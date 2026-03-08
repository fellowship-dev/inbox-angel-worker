import { IpInfo } from './types';

// IP geolocation + reverse DNS enrichment.
// Uses ip-api.com (free, no key required, 45 req/min).
// TODO: swap for MaxMind GeoLite2 HTTP API for higher limits + offline support.
export async function getIpInfo(ip: string): Promise<IpInfo> {
  try {
    const res = await fetch(`http://ip-api.com/json/${ip}?fields=status,country,countryCode,regionName,city,reverse`, {
      headers: { 'Accept': 'application/json' },
    });
    if (!res.ok) return bare(ip);
    const data = await res.json() as Record<string, string>;
    if (data['status'] !== 'success') return bare(ip);

    const reverse = data['reverse'] || null;
    const base_domain = reverse ? baseDomain(reverse) : null;

    return {
      ip,
      reverse_dns: reverse,
      base_domain,
      country_code: data['countryCode'] || null,
      country_name: data['country'] || null,
      subdivision: data['regionName'] || null,
      city: data['city'] || null,
    };
  } catch {
    return bare(ip);
  }
}

function bare(ip: string): IpInfo {
  return { ip, reverse_dns: null, base_domain: null, country_code: null, country_name: null, subdivision: null, city: null };
}

// Extract base domain from a FQDN (e.g. mail.google.com → google.com)
function baseDomain(hostname: string): string {
  const parts = hostname.replace(/\.$/, '').split('.');
  if (parts.length <= 2) return hostname;
  return parts.slice(-2).join('.');
}
