import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fetchSubdomains } from '../../src/domains/ct';

function mockFetch(status: number, body: unknown): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
    new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
  ));
}

beforeEach(() => vi.unstubAllGlobals());

describe('fetchSubdomains', () => {
  it('returns sorted unique subdomains for a root domain', async () => {
    mockFetch(200, [
      { name_value: 'mail.example.com' },
      { name_value: 'www.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual(['mail.example.com', 'www.example.com']);
  });

  it('deduplicates subdomains across entries', async () => {
    mockFetch(200, [
      { name_value: 'mail.example.com' },
      { name_value: 'mail.example.com\nwww.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual(['mail.example.com', 'www.example.com']);
  });

  it('excludes wildcard entries', async () => {
    mockFetch(200, [
      { name_value: '*.example.com' },
      { name_value: 'mail.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).not.toContain('*.example.com');
    expect(result).toContain('mail.example.com');
  });

  it('excludes the root domain itself', async () => {
    mockFetch(200, [
      { name_value: 'example.com' },
      { name_value: 'mail.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).not.toContain('example.com');
  });

  it('excludes entries not under the root domain', async () => {
    mockFetch(200, [
      { name_value: 'other.com' },
      { name_value: 'mail.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual(['mail.example.com']);
  });

  it('returns empty array when crt.sh returns empty body', async () => {
    mockFetch(200, '');
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual([]);
  });

  it('returns empty array when crt.sh returns an empty array', async () => {
    mockFetch(200, []);
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual([]);
  });

  it('throws when crt.sh returns non-200', async () => {
    mockFetch(500, '');
    await expect(fetchSubdomains('example.com')).rejects.toThrow('crt.sh returned HTTP 500');
  });

  it('throws when fetch itself fails', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network down')));
    await expect(fetchSubdomains('example.com')).rejects.toThrow('crt.sh fetch failed');
  });

  it('handles newline-separated names within a single entry', async () => {
    mockFetch(200, [
      { name_value: 'a.example.com\nb.example.com\nc.example.com' },
    ]);
    const result = await fetchSubdomains('example.com');
    expect(result).toEqual(['a.example.com', 'b.example.com', 'c.example.com']);
  });
});
