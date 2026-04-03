// Certificate Transparency log subdomain discovery via crt.sh.
// Uses the public JSON API — no auth required.

const CRT_SH_URL = 'https://crt.sh/?q=%.{DOMAIN}&output=json';

interface CrtShEntry {
  name_value: string;
}

/**
 * Query crt.sh for all known subdomains of rootDomain.
 * Returns unique, normalised subdomain names (excluding wildcards).
 * Throws if the upstream fetch fails or returns non-200.
 */
export async function fetchSubdomains(rootDomain: string): Promise<string[]> {
  const url = CRT_SH_URL.replace('{DOMAIN}', encodeURIComponent(rootDomain));
  let res: Response;
  try {
    res = await fetch(url, { headers: { Accept: 'application/json' } });
  } catch (e) {
    throw new Error(`crt.sh fetch failed: ${String(e)}`);
  }

  if (!res.ok) {
    throw new Error(`crt.sh returned HTTP ${res.status}`);
  }

  let entries: CrtShEntry[];
  try {
    entries = await res.json() as CrtShEntry[];
  } catch {
    // crt.sh returns an empty body (not JSON) when there are no results
    return [];
  }

  if (!Array.isArray(entries)) return [];

  const seen = new Set<string>();
  const results: string[] = [];
  for (const entry of entries) {
    // name_value may contain newline-separated names or wildcard entries
    for (const raw of entry.name_value.split('\n')) {
      const name = raw.trim().toLowerCase();
      // Skip wildcards and the root domain itself
      if (!name || name.startsWith('*') || name === rootDomain) continue;
      // Must be an actual subdomain of rootDomain
      if (!name.endsWith(`.${rootDomain}`)) continue;
      if (!seen.has(name)) {
        seen.add(name);
        results.push(name);
      }
    }
  }

  return results.sort();
}
