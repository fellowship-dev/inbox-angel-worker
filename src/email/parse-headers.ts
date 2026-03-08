// Authentication-Results header parser — RFC 7601
// Extracts SPF, DKIM, DMARC results from inbound email headers.
//
// Example header:
//   Authentication-Results: mx.google.com;
//     dkim=pass header.d=example.com header.s=selector1;
//     spf=pass (google.com: domain of user@example.com ...) smtp.mailfrom=user@example.com;
//     dmarc=pass (p=reject dis=none) header.from=example.com

export type AuthMethodResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'temperror' | 'permerror';

export interface SpfHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // smtp.mailfrom or smtp.helo domain
}

export interface DkimHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // header.d
  selector: string | null;  // header.s
}

export interface DmarcHeaderResult {
  result: AuthMethodResult;
  domain: string | null;    // header.from
  policy: string | null;    // p= from comment
  disposition: string | null; // dis= from comment
}

export interface AuthResultsHeader {
  spf: SpfHeaderResult | null;
  dkim: DkimHeaderResult | null;
  dmarc: DmarcHeaderResult | null;
  raw: string;
}

// Parses one "key=value" tag from an auth result clause
function parseTag(clause: string, key: string): string | null {
  const match = clause.match(new RegExp(`(?:^|[\\s;])${key}=([^\\s;]+)`, 'i'));
  return match ? match[1].toLowerCase() : null;
}

// Extracts the result keyword (first word after method=)
function parseResult(clause: string): AuthMethodResult {
  const match = clause.match(/=\s*(\w+)/);
  if (!match) return 'none';
  return match[1].toLowerCase() as AuthMethodResult;
}

// Strip parenthetical comments like "(google.com: domain of ...)" before tag parsing
function stripComments(s: string): string {
  return s.replace(/\([^)]*\)/g, '');
}

/**
 * Parses the Authentication-Results header value.
 * Handles multiple clauses (dkim, spf, dmarc) in any order.
 * Returns null if the header is missing or empty.
 */
export function parseAuthResults(header: string | null | undefined): AuthResultsHeader | null {
  if (!header) return null;

  // Strip the authserv-id prefix (everything before the first ';')
  const semiIdx = header.indexOf(';');
  const body = semiIdx >= 0 ? header.slice(semiIdx + 1) : header;

  // Split into method clauses on method keywords
  // Each clause starts with: dkim= | spf= | dmarc= | arc= etc.
  const clauses = body.split(/(?=\b(?:dkim|spf|dmarc|arc|bimi)\s*=)/i).map(c => c.trim()).filter(Boolean);

  let spf: SpfHeaderResult | null = null;
  let dkim: DkimHeaderResult | null = null;
  let dmarc: DmarcHeaderResult | null = null;

  for (const clause of clauses) {
    const stripped = stripComments(clause);

    if (/^dkim\s*=/i.test(clause)) {
      dkim = {
        result: parseResult(clause),
        domain: parseTag(stripped, 'header\\.d') ?? parseTag(stripped, 'header\\.i')?.split('@').pop() ?? null,
        selector: parseTag(stripped, 'header\\.s'),
      };
    } else if (/^spf\s*=/i.test(clause)) {
      spf = {
        result: parseResult(clause),
        domain: parseTag(stripped, 'smtp\\.mailfrom')?.split('@').pop()
          ?? parseTag(stripped, 'smtp\\.helo')
          ?? null,
      };
    } else if (/^dmarc\s*=/i.test(clause)) {
      // policy and disposition live inside the comment, e.g. (p=reject dis=none)
      const comment = clause.match(/\(([^)]*)\)/)?.[1] ?? '';
      dmarc = {
        result: parseResult(clause),
        domain: parseTag(stripped, 'header\\.from'),
        policy: comment.match(/\bp=(\w+)/i)?.[1]?.toLowerCase() ?? null,
        disposition: comment.match(/\bdis=(\w+)/i)?.[1]?.toLowerCase() ?? null,
      };
    }
  }

  return { spf, dkim, dmarc, raw: header };
}

/**
 * Finds and parses the Authentication-Results header from a raw email header map.
 * Handles multiple Authentication-Results headers (takes the first).
 */
export function extractAuthResults(headers: Headers | Map<string, string> | Record<string, string>): AuthResultsHeader | null {
  let value: string | null | undefined;

  if (headers instanceof Headers) {
    value = headers.get('authentication-results');
  } else if (headers instanceof Map) {
    value = headers.get('authentication-results') ?? headers.get('Authentication-Results');
  } else {
    value = (headers as Record<string, string>)['authentication-results']
      ?? (headers as Record<string, string>)['Authentication-Results'];
  }

  return parseAuthResults(value);
}
