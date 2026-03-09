// IP enrichment — reverse DNS + ASN/country via free DNS services only.
// PTR records:   Cloudflare DoH (cloudflare-dns.com) — no key, no rate limit
// ASN / country: Team Cymru DNS whois (origin.asn.cymru.com) — free, DNS-based
// Results are cached in the ip_info D1 table; TTL = 30 days.

import type { IpInfo } from './types';
import type { IpInfoRow } from '../db/types';

const DOH_URL = 'https://cloudflare-dns.com/dns-query';
const CACHE_TTL_DAYS = 30;

// ── DNS-over-HTTPS helpers ────────────────────────────────────

async function dohQuery(name: string, type: string): Promise<string[]> {
  try {
    const url = `${DOH_URL}?name=${encodeURIComponent(name)}&type=${encodeURIComponent(type)}`;
    const res = await fetch(url, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return [];
    const data = await res.json() as { Answer?: { data: string }[] };
    return (data.Answer ?? []).map(a => a.data.replace(/\.$/, '').trim());
  } catch {
    return [];
  }
}

// PTR record for an IPv4 address
async function lookupPtr(ip: string): Promise<string | null> {
  if (!isIPv4(ip)) return null; // skip IPv6 for now
  const reversed = ip.split('.').reverse().join('.') + '.in-addr.arpa';
  const answers = await dohQuery(reversed, 'PTR');
  return answers[0] ?? null;
}

// Team Cymru DNS whois: returns { asn, countryCode, org } for an IPv4
// Query: {rev}.origin.asn.cymru.com TXT  → "ASN | prefix | CC | registry | date"
// Query: AS{asn}.asn.cymru.com       TXT  → "ASN | CC | registry | date | ORG NAME, CC"
async function lookupAsn(ip: string): Promise<{ asn: string | null; countryCode: string | null; org: string | null }> {
  if (!isIPv4(ip)) return { asn: null, countryCode: null, org: null };
  const reversed = ip.split('.').reverse().join('.');
  const originAnswers = await dohQuery(`${reversed}.origin.asn.cymru.com`, 'TXT');
  if (!originAnswers.length) return { asn: null, countryCode: null, org: null };

  // Strip surrounding quotes if present
  const originTxt = originAnswers[0].replace(/^"|"$/g, '');
  const parts = originTxt.split('|').map(p => p.trim());
  const asn = parts[0] || null;
  const countryCode = parts[2] || null;

  let org: string | null = null;
  if (asn) {
    const asnAnswers = await dohQuery(`AS${asn}.asn.cymru.com`, 'TXT');
    if (asnAnswers.length) {
      const asnTxt = asnAnswers[0].replace(/^"|"$/g, '');
      const asnParts = asnTxt.split('|').map(p => p.trim());
      // Last part is "ORG NAME, CC" — take everything before the trailing ", CC"
      const raw = asnParts[asnParts.length - 1] ?? '';
      org = raw.replace(/,\s*[A-Z]{2}$/, '').trim() || null;
    }
  }

  return { asn, countryCode, org };
}

function isIPv4(ip: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(ip);
}

function baseDomain(hostname: string): string {
  const parts = hostname.replace(/\.$/, '').split('.');
  return parts.length <= 2 ? hostname : parts.slice(-2).join('.');
}

// ── Public API ────────────────────────────────────────────────

export async function getIpInfo(ip: string): Promise<IpInfo> {
  const [ptr, { asn, countryCode, org }] = await Promise.all([
    lookupPtr(ip),
    lookupAsn(ip),
  ]);

  return {
    ip,
    reverse_dns: ptr,
    base_domain: ptr ? baseDomain(ptr) : null,
    country_code: countryCode,
    country_name: null, // not available without a geo DB — country_code is enough
    subdivision: null,
    city: null,
    org: org ?? null,
    asn: asn ?? null,
  };
}

// ── D1 cache helpers ──────────────────────────────────────────

export async function getCachedIpInfo(db: D1Database, ip: string): Promise<IpInfo | null> {
  const row = await db.prepare(`SELECT * FROM ip_info WHERE ip = ?`).bind(ip).first<IpInfoRow>();
  if (!row) return null;
  const ageSeconds = Math.floor(Date.now() / 1000) - row.fetched_at;
  if (ageSeconds > CACHE_TTL_DAYS * 86400) return null; // expired
  return {
    ip: row.ip,
    reverse_dns: row.reverse_dns,
    base_domain: row.base_domain,
    country_code: row.country_code,
    country_name: null,
    subdivision: null,
    city: null,
    org: row.org,
    asn: row.asn,
  };
}

export async function cacheIpInfo(db: D1Database, info: IpInfo & { asn?: string | null }): Promise<void> {
  await db.prepare(`
    INSERT INTO ip_info (ip, reverse_dns, base_domain, country_code, org, asn, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, unixepoch())
    ON CONFLICT(ip) DO UPDATE SET
      reverse_dns = excluded.reverse_dns,
      base_domain = excluded.base_domain,
      country_code = excluded.country_code,
      org = excluded.org,
      asn = excluded.asn,
      fetched_at = unixepoch()
  `).bind(info.ip, info.reverse_dns, info.base_domain, info.country_code, info.org ?? null, info.asn ?? null).run();
}
