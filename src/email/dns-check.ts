// Live DNS lookups for SPF, DKIM, DMARC records via Cloudflare DoH (DNS over HTTPS).
// Workers-native: uses fetch(), no Node.js dns module.

export interface DnsRecord {
  type: string;
  value: string;
}

export interface SpfRecord {
  raw: string;
  mechanisms: string[];  // e.g. ["ip4:1.2.3.4", "include:sendgrid.net", "~all"]
  verdict: 'strict' | 'soft' | 'open' | 'missing';
  lookup_count: number;  // total DNS lookups required to evaluate this record
}

export interface DkimRecord {
  raw: string;
  version: string;   // v=DKIM1
  keyType: string;   // k=rsa
  present: boolean;
}

export interface DmarcRecord {
  raw: string;
  policy: 'none' | 'quarantine' | 'reject';
  subdomainPolicy: 'none' | 'quarantine' | 'reject';
  pct: number;
  rua: string[];     // aggregate report addresses
  ruf: string[];     // forensic report addresses
}

export interface DnsCheckResult {
  domain: string;
  spf: SpfRecord | null;
  dkim: DkimRecord | null;   // null if no selector available
  dmarc: DmarcRecord | null;
}

const DOH_URL = 'https://cloudflare-dns.com/dns-query';

async function queryTxt(name: string): Promise<string[]> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=TXT`;
    const res = await fetch(url, {
      headers: { Accept: 'application/dns-json' },
    });
    if (!res.ok) return [];
    const data = await res.json() as { Answer?: { type: number; data: string }[] };
    return (data.Answer ?? [])
      .filter(r => r.type === 16) // TXT = 16
      .map(r => r.data.replace(/^"|"$/g, '').replace(/"\s*"/g, '')); // strip quotes + join split strings
  } catch {
    return [];
  }
}

// ── SPF ──────────────────────────────────────────────────────

export function parseSpfRecord(raw: string): SpfRecord {
  const mechanisms = raw
    .split(/\s+/)
    .filter(p => !p.startsWith('v='))
    .map(p => p.toLowerCase());

  const allMechanism = mechanisms.find(m => m.endsWith('all'));
  let verdict: SpfRecord['verdict'] = 'missing';
  if (allMechanism) {
    if (allMechanism === '-all') verdict = 'strict';
    else if (allMechanism === '~all') verdict = 'soft';
    else verdict = 'open'; // +all or ?all
  }

  return { raw, mechanisms, verdict };
}

// Walk the SPF include chain and count DNS lookups.
// Mechanisms that count toward the 10-lookup limit: include, a, mx, ptr, exists, redirect.
// ip4, ip6, all, exp do NOT count.
async function walkSpfLookups(domain: string, visited = new Set<string>(), count = { n: 0 }): Promise<number> {
  if (visited.has(domain) || count.n > 10) return count.n;
  visited.add(domain);

  const records = await queryTxt(domain);
  const spfRaw = records.find(r => r.startsWith('v=spf1'));
  if (!spfRaw) return count.n;

  for (const token of spfRaw.split(/\s+/)) {
    const t = token.toLowerCase();
    if (t.startsWith('include:')) {
      count.n++;
      await walkSpfLookups(t.slice(8), visited, count);
    } else if (t.startsWith('redirect=')) {
      count.n++;
      await walkSpfLookups(t.slice(9), visited, count);
    } else if (t === 'a' || t.startsWith('a:') || t.startsWith('a/') ||
               t === 'mx' || t.startsWith('mx:') || t.startsWith('mx/') ||
               t === 'ptr' || t.startsWith('ptr:') ||
               t.startsWith('exists:')) {
      count.n++;
    }
    if (count.n > 10) break;
  }
  return count.n;
}

export async function lookupSpf(domain: string): Promise<SpfRecord | null> {
  const records = await queryTxt(domain);
  const spfRaw = records.find(r => r.startsWith('v=spf1'));
  if (!spfRaw) return null;
  const parsed = parseSpfRecord(spfRaw);
  const lookup_count = await walkSpfLookups(domain);
  return { ...parsed, lookup_count };
}

// ── DKIM ─────────────────────────────────────────────────────

export function parseDkimRecord(raw: string): DkimRecord {
  const tags = Object.fromEntries(
    raw.split(/\s*;\s*/).map(t => {
      const [k, ...v] = t.split('=');
      return [k?.trim().toLowerCase(), v.join('=').trim()];
    })
  );
  return {
    raw,
    version: tags['v'] ?? 'DKIM1',
    keyType: tags['k'] ?? 'rsa',
    present: true,
  };
}

export async function lookupDkim(domain: string, selector: string): Promise<DkimRecord | null> {
  const name = `${selector}._domainkey.${domain}`;
  const records = await queryTxt(name);
  const dkimRaw = records.find(r => r.includes('v=DKIM1') || r.includes('k='));
  return dkimRaw ? parseDkimRecord(dkimRaw) : null;
}

// ── DMARC ────────────────────────────────────────────────────

export function parseDmarcRecord(raw: string): DmarcRecord {
  const tags = Object.fromEntries(
    raw.split(/\s*;\s*/).map(t => {
      const [k, ...v] = t.split('=');
      return [k?.trim().toLowerCase(), v.join('=').trim()];
    })
  );

  const policy = (tags['p'] ?? 'none') as DmarcRecord['policy'];
  const sp = (tags['sp'] ?? policy) as DmarcRecord['subdomainPolicy'];
  const pct = parseInt(tags['pct'] ?? '100', 10);
  const rua = (tags['rua'] ?? '').split(',').map(s => s.trim()).filter(Boolean);
  const ruf = (tags['ruf'] ?? '').split(',').map(s => s.trim()).filter(Boolean);

  return { raw, policy, subdomainPolicy: sp, pct, rua, ruf };
}

export async function lookupDmarc(domain: string): Promise<DmarcRecord | null> {
  // Try _dmarc.domain first, then _dmarc on the org domain
  const names = [`_dmarc.${domain}`];
  const parts = domain.split('.');
  if (parts.length > 2) names.push(`_dmarc.${parts.slice(-2).join('.')}`);

  for (const name of names) {
    const records = await queryTxt(name);
    const dmarcRaw = records.find(r => r.startsWith('v=DMARC1'));
    if (dmarcRaw) return parseDmarcRecord(dmarcRaw);
  }
  return null;
}

// ── Combined lookup ───────────────────────────────────────────

export async function checkDomain(domain: string, dkimSelector?: string | null): Promise<DnsCheckResult> {
  const [spf, dmarc, dkim] = await Promise.all([
    lookupSpf(domain),
    lookupDmarc(domain),
    dkimSelector ? lookupDkim(domain, dkimSelector) : Promise.resolve(null),
  ]);
  return { domain, spf, dkim, dmarc };
}
