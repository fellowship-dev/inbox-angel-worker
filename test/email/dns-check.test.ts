import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  parseSpfRecord,
  parseDkimRecord,
  parseDmarcRecord,
  lookupSpf,
  lookupDkim,
  lookupDmarc,
  checkDomain,
} from '../../src/email/dns-check';

// ── Pure parsing tests (no network) ──────────────────────────

describe('parseSpfRecord', () => {
  it('detects -all as strict', () => {
    const r = parseSpfRecord('v=spf1 include:sendgrid.net -all');
    expect(r.verdict).toBe('strict');
    expect(r.mechanisms).toContain('include:sendgrid.net');
    expect(r.mechanisms).toContain('-all');
  });

  it('detects ~all as soft', () => {
    const r = parseSpfRecord('v=spf1 ip4:1.2.3.4 ~all');
    expect(r.verdict).toBe('soft');
  });

  it('detects +all as open', () => {
    const r = parseSpfRecord('v=spf1 +all');
    expect(r.verdict).toBe('open');
  });

  it('detects ?all as open', () => {
    const r = parseSpfRecord('v=spf1 ?all');
    expect(r.verdict).toBe('open');
  });

  it('returns missing verdict if no all mechanism', () => {
    const r = parseSpfRecord('v=spf1 include:_spf.google.com');
    expect(r.verdict).toBe('missing');
  });

  it('lowercases mechanisms', () => {
    const r = parseSpfRecord('v=spf1 IP4:10.0.0.1 -ALL');
    expect(r.mechanisms).toContain('ip4:10.0.0.1');
    expect(r.mechanisms).toContain('-all');
  });

  it('preserves raw string', () => {
    const raw = 'v=spf1 include:mailgun.org -all';
    expect(parseSpfRecord(raw).raw).toBe(raw);
  });
});

describe('parseDkimRecord', () => {
  it('parses v=DKIM1 and k=rsa', () => {
    const raw = 'v=DKIM1; k=rsa; p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQ==';
    const r = parseDkimRecord(raw);
    expect(r.version).toBe('DKIM1');
    expect(r.keyType).toBe('rsa');
    expect(r.present).toBe(true);
  });

  it('defaults keyType to rsa when k tag missing', () => {
    const raw = 'v=DKIM1; p=MIIB';
    const r = parseDkimRecord(raw);
    expect(r.keyType).toBe('rsa');
  });

  it('parses ed25519 key type', () => {
    const raw = 'v=DKIM1; k=ed25519; p=publickey';
    expect(parseDkimRecord(raw).keyType).toBe('ed25519');
  });

  it('marks present=true always', () => {
    expect(parseDkimRecord('v=DKIM1; p=abc').present).toBe(true);
  });

  it('preserves raw string', () => {
    const raw = 'v=DKIM1; k=rsa; p=abc';
    expect(parseDkimRecord(raw).raw).toBe(raw);
  });
});

describe('parseDmarcRecord', () => {
  it('parses a reject policy with rua and ruf', () => {
    const raw = 'v=DMARC1; p=reject; pct=100; rua=mailto:dmarc@example.com; ruf=mailto:ruf@example.com';
    const r = parseDmarcRecord(raw);
    expect(r.policy).toBe('reject');
    expect(r.subdomainPolicy).toBe('reject'); // defaults to p
    expect(r.pct).toBe(100);
    expect(r.rua).toEqual(['mailto:dmarc@example.com']);
    expect(r.ruf).toEqual(['mailto:ruf@example.com']);
  });

  it('parses quarantine with sp override', () => {
    const raw = 'v=DMARC1; p=quarantine; sp=none; pct=50';
    const r = parseDmarcRecord(raw);
    expect(r.policy).toBe('quarantine');
    expect(r.subdomainPolicy).toBe('none');
    expect(r.pct).toBe(50);
  });

  it('defaults pct to 100 when missing', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none');
    expect(r.pct).toBe(100);
  });

  it('returns empty arrays for rua/ruf when missing', () => {
    const r = parseDmarcRecord('v=DMARC1; p=none');
    expect(r.rua).toEqual([]);
    expect(r.ruf).toEqual([]);
  });

  it('parses multiple rua addresses', () => {
    const raw = 'v=DMARC1; p=none; rua=mailto:a@example.com,mailto:b@example.com';
    const r = parseDmarcRecord(raw);
    expect(r.rua).toHaveLength(2);
    expect(r.rua).toContain('mailto:a@example.com');
  });

  it('preserves raw string', () => {
    const raw = 'v=DMARC1; p=reject';
    expect(parseDmarcRecord(raw).raw).toBe(raw);
  });
});

// ── Network tests (mocked fetch) ─────────────────────────────

function makeDohResponse(txtRecords: string[]) {
  return {
    ok: true,
    json: () =>
      Promise.resolve({
        Answer: txtRecords.map(data => ({ type: 16, data: `"${data}"` })),
      }),
  } as unknown as Response;
}

const emptyDohResponse = {
  ok: true,
  json: () => Promise.resolve({ Answer: [] }),
} as unknown as Response;

describe('lookupSpf', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });
  afterEach(() => vi.unstubAllGlobals());

  it('returns parsed SPF record when TXT includes v=spf1', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeDohResponse(['v=spf1 include:sendgrid.net -all'])
    );
    const r = await lookupSpf('example.com');
    expect(r).not.toBeNull();
    expect(r!.verdict).toBe('strict');
  });

  it('returns null when no SPF TXT record found', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      makeDohResponse(['v=DMARC1; p=none'])
    );
    const r = await lookupSpf('example.com');
    expect(r).toBeNull();
  });

  it('returns null on fetch failure', async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error('network error'));
    const r = await lookupSpf('example.com');
    expect(r).toBeNull();
  });

  it('strips quotes from DoH response', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeDohResponse(['v=spf1 ~all']));
    const r = await lookupSpf('example.com');
    expect(r!.raw).toBe('v=spf1 ~all'); // no surrounding quotes
  });
});

describe('lookupDkim', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('queries selector._domainkey.domain', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(makeDohResponse(['v=DKIM1; k=rsa; p=ABC']));
    const r = await lookupDkim('example.com', 'selector1');
    expect(r).not.toBeNull();
    expect(r!.present).toBe(true);
    // Verify correct DNS name was used
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('selector1._domainkey.example.com');
  });

  it('returns null when no DKIM record found', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(emptyDohResponse);
    const r = await lookupDkim('example.com', 'missing-sel');
    expect(r).toBeNull();
  });

  it('finds record with only k= tag (no v=DKIM1)', async () => {
    vi.mocked(fetch).mockResolvedValueOnce(makeDohResponse(['k=rsa; p=MIIB']));
    const r = await lookupDkim('example.com', 'sel');
    expect(r).not.toBeNull();
  });
});

describe('lookupDmarc', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('returns DMARC record from _dmarc.domain', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch.mockResolvedValueOnce(makeDohResponse(['v=DMARC1; p=quarantine; pct=100']));
    const r = await lookupDmarc('example.com');
    expect(r).not.toBeNull();
    expect(r!.policy).toBe('quarantine');
    const url = mockFetch.mock.calls[0][0] as string;
    expect(url).toContain('_dmarc.example.com');
  });

  it('falls back to org domain for subdomains', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(emptyDohResponse) // _dmarc.mail.example.com — miss
      .mockResolvedValueOnce(makeDohResponse(['v=DMARC1; p=reject'])); // _dmarc.example.com — hit
    const r = await lookupDmarc('mail.example.com');
    expect(r).not.toBeNull();
    expect(r!.policy).toBe('reject');
  });

  it('returns null when no DMARC record anywhere', async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(emptyDohResponse)
      .mockResolvedValueOnce(emptyDohResponse);
    const r = await lookupDmarc('example.com');
    expect(r).toBeNull();
  });
});

describe('checkDomain', () => {
  beforeEach(() => vi.stubGlobal('fetch', vi.fn()));
  afterEach(() => vi.unstubAllGlobals());

  it('runs all three lookups in parallel and returns combined result', async () => {
    const mockFetch = vi.mocked(fetch);
    // SPF, DMARC, DKIM — three DoH calls
    mockFetch
      .mockResolvedValueOnce(makeDohResponse(['v=spf1 -all']))         // SPF
      .mockResolvedValueOnce(makeDohResponse(['v=DMARC1; p=reject']))  // DMARC
      .mockResolvedValueOnce(makeDohResponse(['v=DKIM1; k=rsa; p=X'])); // DKIM

    const result = await checkDomain('example.com', 'sel');
    expect(result.domain).toBe('example.com');
    expect(result.spf!.verdict).toBe('strict');
    expect(result.dmarc!.policy).toBe('reject');
    expect(result.dkim!.present).toBe(true);
  });

  it('skips DKIM lookup when no selector provided', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockResolvedValueOnce(makeDohResponse(['v=spf1 ~all']))
      .mockResolvedValueOnce(emptyDohResponse);

    const result = await checkDomain('example.com');
    expect(result.dkim).toBeNull();
    expect(mockFetch).toHaveBeenCalledTimes(2); // only SPF + DMARC
  });

  it('tolerates partial DNS failures', async () => {
    const mockFetch = vi.mocked(fetch);
    mockFetch
      .mockRejectedValueOnce(new Error('timeout'))    // SPF fails
      .mockResolvedValueOnce(emptyDohResponse);       // DMARC empty

    const result = await checkDomain('example.com');
    expect(result.spf).toBeNull();
    expect(result.dmarc).toBeNull();
  });
});
