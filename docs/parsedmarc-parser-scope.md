# parsedmarc Parser Core — Deep Scope Analysis

Version analyzed: **9.1.2** (current master, 2026-03-06)
Repo: https://github.com/domainaware/parsedmarc

---

## 1. Full Module File List

```
parsedmarc/
├── __init__.py          ← CORE: all parsing logic (2488 lines)
├── cli.py               ← integration: CLI entrypoint
├── constants.py         ← CORE: version + user agent (3 lines)
├── elastic.py           ← integration: Elasticsearch output
├── gelf.py              ← integration: GELF/Graylog output
├── kafkaclient.py       ← integration: Kafka output
├── log.py               ← CORE: shared logger (4 lines)
├── loganalytics.py      ← integration: Azure Log Analytics output
├── mail/
│   ├── __init__.py      ← CORE: re-exports mail connection classes
│   ├── mailbox_connection.py  ← CORE: ABC interface for mailbox
│   ├── imap.py          ← MAILBOX: IMAP connection impl
│   ├── gmail.py         ← MAILBOX: Gmail API connection impl
│   ├── graph.py         ← MAILBOX: MS Graph (Office 365) impl
│   └── maildir.py       ← MAILBOX: Maildir local folder impl
├── opensearch.py        ← integration: OpenSearch output
├── resources/
│   ├── dbip/            ← bundled DBIP IP-to-Country MMDB file
│   └── maps/
│       ├── base_reverse_dns_map.csv  ← known sender IP→service map
│       └── psl_overrides.txt         ← public suffix list overrides
├── s3.py                ← integration: AWS S3 output
├── splunk.py            ← integration: Splunk HEC output
├── syslog.py            ← integration: syslog output
├── types.py             ← CORE: TypedDict schemas (220 lines)
├── utils.py             ← CORE: DNS/IP/email helpers (729 lines)
└── webhook.py           ← integration: webhook output
```

---

## 2. Core vs Integration Classification

### Parser Core (what we care about)
| File | Role |
|---|---|
| `__init__.py` | All parsing functions — aggregate XML, forensic, SMTP TLS, email |
| `types.py` | All TypedDict schemas for parsed output |
| `utils.py` | DNS resolution, IP geo-lookup, email parsing, timestamp helpers |
| `constants.py` | Version string only |
| `log.py` | One-liner shared logger |
| `mail/mailbox_connection.py` | ABC interface (needed for type signatures in __init__) |
| `resources/dbip/` | Bundled IP-to-country database |
| `resources/maps/` | Reverse DNS service map + PSL overrides |

### Mailbox Connectors (needed to fetch emails, not to parse them)
| File | Role |
|---|---|
| `mail/imap.py` | IMAP via `mailsuite.imap.IMAPClient` + `imapclient` |
| `mail/gmail.py` | Gmail API via `google-api-python-client` |
| `mail/graph.py` | MS Graph (Office 365) via `msgraph-core` + `azure-identity` |
| `mail/maildir.py` | Local Maildir via Python stdlib `mailbox` |

### Pure Integrations (output sinks, irrelevant to parser)
`cli.py`, `elastic.py`, `opensearch.py`, `kafka.py`, `splunk.py`, `gelf.py`, `loganalytics.py`, `s3.py`, `syslog.py`, `webhook.py`

---

## 3. Core File Details

### `types.py` (220 lines)
Pure TypedDict schemas — no logic. Defines the shape of all parser outputs:

- **`AggregateReport`** → `xml_schema`, `report_metadata`, `policy_published`, `records[]`
  - `AggregateReportMetadata`: org_name, org_email, report_id, begin_date, end_date, timespan_requires_normalization, original_timespan_seconds, errors
  - `AggregatePolicyPublished`: domain, adkim, aspf, p, sp, pct, fo
  - `AggregateRecord`: interval_begin, interval_end, source (IPSourceInfo), count, alignment, policy_evaluated, identifiers, auth_results
  - `AggregateAlignment`: `{spf: bool, dkim: bool, dmarc: bool}`
  - `AggregateAuthResults`: `{dkim: [{domain, result, selector}], spf: [{domain, result, scope}]}`
- **`ForensicReport`**: feedback_type, source (IPSourceInfo), arrival_date, auth_failure[], authentication_mechanisms[], reported_domain, sample_headers_only, sample (raw), parsed_sample (ParsedEmail)
- **`SMTPTLSReport`**: organization_name, begin_date, end_date, contact_info, report_id, policies[]
  - `SMTPTLSPolicy`: policy_domain, policy_type (tlsa/sts/no-policy-found), successful_session_count, failed_session_count, failure_details[]
- **`ParsedReport`**: union discriminated by `report_type: "aggregate" | "forensic" | "smtp_tls"`
- **`ParsingResults`**: `{aggregate_reports, forensic_reports, smtp_tls_reports}`

### `constants.py` (3 lines)
Just `__version__ = "9.1.2"` and `USER_AGENT`.

### `log.py` (4 lines)
`logger = logging.getLogger("parsedmarc")` — nothing more.

### `utils.py` (729 lines)
Key functions:

**IP / DNS:**
- `get_ip_address_country(ip, db_path)` — geoip2 MMDB lookup (DBIP or MaxMind)
- `get_reverse_dns(ip, cache, nameservers, timeout)` — PTR record via dnspython
- `get_base_domain(domain)` — uses `publicsuffixlist` + PSL overrides
- `get_service_from_reverse_dns_base_domain(base_domain, ...)` — maps reverse DNS base domain → `{name, type}` via bundled CSV or remote URL
- `get_ip_address_info(ip, ...)` → `IPAddressInfo` — combines all the above into one `{ip_address, reverse_dns, country, base_domain, name, type}` dict, with caching via `ExpiringDict`
- `query_dns(domain, record_type, cache, nameservers, timeout)` — generic DNS resolver

**Email:**
- `parse_email(data, strip_attachment_payloads)` — wraps `mailparser`, returns normalized dict with from/to/cc/bcc/attachments/body/headers/subject; handles Outlook MSG via `convert_outlook_msg`
- `convert_outlook_msg(msg_bytes)` — shells out to `msgconvert` Perl utility
- `parse_email_address(original_address)` → `{display_name, address, local, domain}`
- `is_outlook_msg(content)` — magic byte check (`\xd0\xcf\x11\xe0`)
- `is_mbox(path)` — stdlib mailbox check

**Timestamps:**
- `timestamp_to_human(unix_ts)` → `"YYYY-MM-DD HH:MM:SS"`
- `human_timestamp_to_datetime(str, to_utc)` — uses `dateutil.parser.parse`
- `human_timestamp_to_unix_timestamp(str)` → int

**Misc:**
- `decode_base64(data)` — base64 with optional padding
- `get_filename_safe_string(string)` — sanitize for filesystem

### `mail/mailbox_connection.py` (33 lines)
Abstract base class `MailboxConnection` with 7 abstract methods:
`create_folder`, `fetch_messages`, `fetch_message`, `delete_message`, `move_message`, `keepalive`, `watch`

---

## 4. Key Parsing Functions in `__init__.py`

### Module-level constants
```python
feedback_report_regex = re.compile(r"^([\w\-]+): (.+)$", re.MULTILINE)
xml_header_regex = re.compile(r"^<\?xml .*?>", re.MULTILINE)
xml_schema_regex = re.compile(r"</??xs:schema.*>", re.MULTILINE)
text_report_regex = re.compile(r"\s*([a-zA-Z\s]+):\s(.+)", re.MULTILINE)

MAGIC_ZIP = b"\x50\x4b\x03\x04"
MAGIC_GZIP = b"\x1f\x8b"
MAGIC_XML = b"\x3c\x3f\x78\x6d\x6c\x20"
MAGIC_JSON = b"\7b"

IP_ADDRESS_CACHE = ExpiringDict(max_len=10000, max_age_seconds=14400)
SEEN_AGGREGATE_REPORT_IDS = ExpiringDict(max_len=100000000, max_age_seconds=3600)
REVERSE_DNS_MAP = dict()
```

---

### `parse_aggregate_report_xml(xml, *, ...)` → `AggregateReport`
**Entry point for aggregate (RUA) reports.**

Pseudocode:
```
1. Decode bytes→str if needed
2. Try xmltodict.parse(xml)["feedback"]; on failure, use lxml with recover=True
3. Strip invalid XML headers (xml_header_regex) and schema tags (xml_schema_regex)
4. re-parse with xmltodict.parse(xml)["feedback"]
5. Extract report_metadata:
   - org_name (fallback: email domain; normalize via get_base_domain if no spaces)
   - org_email, org_extra_contact_info, report_id (strip <> and @domain suffix)
   - begin_ts, end_ts from date_range (strip fractional seconds via .split(".")[0])
   - Compute span_seconds; set normalize_timespan = span > threshold (default 24h)
   - Convert timestamps to "YYYY-MM-DD HH:MM:SS" strings
6. Extract policy_published:
   - domain, adkim (default "r"), aspf (default "r"), p, sp (default to p), pct (default "100"), fo (default "0")
   - Handle case where policy_published is a list (take first)
7. For each record in report["record"] (list or single):
   - Call _parse_report_record(record, ...) → parsed_record
   - Call _append_parsed_record(parsed_record, records, begin_dt, end_dt, normalize)
   - Call keep_alive() every 20 records if provided
8. Return {xml_schema, report_metadata, policy_published, records}
```

**Error handling:** catches `expat.ExpatError`, `KeyError`, `AttributeError`, all wrapped in `InvalidAggregateReport`.

---

### `_parse_report_record(record, *, ...)` → `dict`
**Normalizes a single XML record.**

```
1. Get source IP → call get_ip_address_info() → new_record["source"]
2. new_record["count"] = int(record["row"]["count"])
3. policy_evaluated normalization:
   - disposition: default "none"; if value is "pass", coerce to "none" (quirk)
   - dkim, spf: default "fail"
   - spf_aligned = policy_evaluated["spf"] == "pass"
   - dkim_aligned = policy_evaluated["dkim"] == "pass"
   - dmarc_aligned = spf_aligned OR dkim_aligned
   - policy_override_reasons: normalize "reason" field (list or single)
4. identifiers: copy from "identities" or "identifiers" key
   - header_from: lowercase
   - envelope_from: if missing or null, try to infer from last SPF result domain
   - envelope_to: move from identifiers to top level (quirky XML position)
5. auth_results:
   - dkim: list of {domain, selector (default "none"), result (default "none")}
   - spf: list of {domain, scope (default "mfrom"), result (default "none")}
```

---

### `_append_parsed_record(parsed_record, records, begin_dt, end_dt, normalize)` → None
**Handles timespan normalization.**

```
if not normalize:
    record["normalized_timespan"] = False
    record["interval_begin"] = begin_dt formatted
    record["interval_end"] = end_dt formatted
    records.append(record)
    return

# normalize path: split into daily buckets
buckets = _bucket_interval_by_day(begin_dt, end_dt, count)
for each bucket:
    new_rec = record.copy()
    new_rec["count"] = bucket["count"]  # pro-rated
    new_rec["normalized_timespan"] = True
    new_rec["interval_begin"] / interval_end = bucket times
    records.append(new_rec)
```

---

### `_bucket_interval_by_day(begin, end, total_count)` → list of dicts
**Distributes count proportionally across daily buckets.**

```
1. Validate: begin < end, both tz-aware, same tz, count >= 0
2. Walk calendar days from floor(begin) to end
3. For each day, compute overlap seconds with [begin, end)
4. Pro-rate: exact_count = (overlap_seconds / total_seconds) * total_count
5. Largest-remainder rounding to ensure sum = total_count
6. Return [{begin, end, count}, ...] (zero-count buckets dropped)
```

---

### `extract_report(content)` → str
**Decompresses/decodes report files.**

```
Input: base64 string | bytes | file-like object
1. If str: try base64 decode → bytes; if fails, return as-is (raw XML)
2. Read first 6 bytes as header
3. MAGIC_ZIP → zipfile.ZipFile, read first entry
4. MAGIC_GZIP → zlib.decompress with MAX_WBITS|16 (gzip mode)
5. MAGIC_XML or MAGIC_JSON → read raw bytes
6. Otherwise: raise ParserError("Not a valid zip, gzip, json, or xml file")
```

---

### `parse_smtp_tls_report_json(report)` → `SMTPTLSReport`
**Parses MTA-STS/SMTP TLS reports (RFC 8460).**

```
1. JSON parse report
2. Validate required fields: organization-name, date-range, contact-info, report-id, policies
3. For each policy: call _parse_smtp_tls_report_policy()
   - Validates policy-type in ["tlsa", "sts", "no-policy-found"]
   - Extracts policy-domain, policy-strings, mx-host-pattern
   - Extracts summary: total-successful/failure-session-count
   - Extracts failure-details via _parse_smtp_tls_failure_details()
     (kebab-case → snake_case renaming)
4. Return normalized SMTPTLSReport dict
```

---

### `parse_forensic_report(feedback_report, sample, msg_date, *, ...)` → `ForensicReport`
**Parses DMARC forensic (RUF) reports.**

```
Input: feedback_report = "Key: Value\n..." string, sample = raw email
1. Parse key-value pairs via feedback_report_regex
2. Normalize keys: lowercase, dashes→underscores
3. arrival_date: use parsed value or msg_date fallback
4. delivery_result: normalize to one of [delivered, spam, policy, reject, other]
5. source_ip → get_ip_address_info() → parsed_report["source"]
6. identity_alignment → authentication_mechanisms (comma-split list)
7. auth_failure → list (comma-split)
8. Optional fields defaulted to None: original_envelope_id, dkim_domain, original_mail_from, original_rcpt_to
9. parse_email(sample) → parsed_sample
10. reported_domain: from report field or parsed_sample["from"]["domain"]
11. sample_headers_only = True if no attachments AND no body
12. Return ForensicReport dict
```

---

### `parse_report_email(input_, *, ...)` → `ParsedReport`
**Top-level email parser — detects report type and dispatches.**

```
Input: RFC 822 bytes or string (or Outlook MSG)
1. Handle Outlook MSG conversion if needed
2. Parse with mailparser to extract headers + date
3. Walk email MIME parts:
   - multipart/*: skip
   - text/html: skip
   - message/feedback-report: capture feedback_report, set is_feedback_report=True
   - text/rfc822* or message/rfc822*: if is_feedback_report, capture as sample
   - application/tlsrpt+json: parse_smtp_tls_report_json() → return smtp_tls
   - application/tlsrpt+gzip: extract_report() then parse_smtp_tls_report_json()
   - text/plain with "A message claiming to be from you has failed":
     parse old-style text report → synthetic feedback_report + sample
   - else: try b64decode → check magic bytes:
     - ZIP/GZIP → extract_report() → detect XML/JSON
     - starts with "{" → smtp_tls
     - starts with "<" → aggregate → parse_aggregate_report_xml()
4. If feedback_report AND sample collected:
   → parse_forensic_report()
5. If nothing matched: raise InvalidDMARCReport
```

---

### `parse_report_file(input_, *, ...)` → `ParsedReport`
**Convenience: tries aggregate, then smtp_tls, then email format.**

```
1. Open file/bytes
2. Try parse_aggregate_report_file() → success: return aggregate
3. Except InvalidAggregateReport: try parse_smtp_tls_report_json()
4. Except InvalidSMTPTLSReport: try parse_report_email()
5. Except InvalidDMARCReport: raise ParserError("Not a valid report")
```

---

### `get_dmarc_reports_from_mailbox(connection, *, ...)` → `ParsingResults`
**Orchestrates mailbox polling and parsing.**
Not core parsing — this is the glue layer between MailboxConnection and the parsers. Handles dedup via `SEEN_AGGREGATE_REPORT_IDS`, folder management, batch processing, and recursive catch-up for messages that arrived during processing.

---

## 5. Commit History — Core Files

### `__init__.py` — Very active
| Date | Author | Message |
|---|---|---|
| 2026-01-21 | Sean Whalen | Fix timestamp parsing — remove fractional seconds |
| 2026-01-08 | maraspr | Remove newlines before b64decode |
| 2026-01-08 | maraspr | Validate that string is base64 |
| 2025-12-29 | Sean Whalen | Code cleanup |
| 2025-12-29 | Copilot | Fix IMAP SEARCH SINCE date format to RFC 3501 |
| 2025-12-25 | Sean Whalen | Add type annotations for SMTP TLS and forensic structures |
| 2025-12-25 | Sean Whalen | Refactor and improve parsing and extraction functions |
| 2025-12-24 | Sean Whalen | More code cleanup; use literal dicts instead of OrderedDicts |
| 2025-12-17 | Sean Whalen | Fix #638 |
| 2025-12-08 | Sean Whalen | 9.0.5, 9.0.4 |
| 2025-12-03 | Sean Whalen | 9.0.2 |
| 2025-12-01 | Sean Whalen | 9.0.0 — major refactor |
**Assessment:** Highly active. ~8 functional commits in last 60 days (Jan 2026). Mostly bug fixes and type annotation improvements. The 9.0.0 release (Dec 2025) was a major cleanup. Stable logic, cosmetic churn.

### `types.py` — Very stable
| Date | Author | Message |
|---|---|---|
| 2026-03-03 | Copilot | Drop Python 3.9 support |
| 2025-12-25 | Sean Whalen | Add type annotations for SMTP TLS and forensic structures |
**Assessment:** Only 2 commits in the last 3 months. Type definitions are stable — schemas don't change often.

### `utils.py` — Moderately active
| Date | Author | Message |
|---|---|---|
| 2025-12-25 | Sean Whalen | Refactor: use non-Optional types where applicable |
| 2025-12-25 | Sean Whalen | Refactor and improve parsing/extraction functions |
| 2025-12-24 | Sean Whalen | Code cleanup; literal dicts |
| 2025-12-08 | Sean Whalen | 9.0.4 |
| 2025-12-02 | Sean Whalen | Type hint improvements |
| 2025-11-28 | Sean Whalen | 8.19.0 |
| 2025-06-03 | Sean Whalen | Remove debugging code |
| 2025-03-22 | Tom Henderson | Raise for failed status |
**Assessment:** Active but mostly type annotation and cleanup. Core utility logic (DNS, IP lookup, email parsing) is stable.

### `mail/__init__.py` — Stable
| Date | Author | Message |
|---|---|---|
| 2024-10-03 | Sean Whalen | 8.15.1 |
| 2024-09-06 | Sean Whalen | Fix maildir connection |
| 2022-04-22 | Nathan Thorpe | PEP8 + tests fix |
**Assessment:** Very stable. Just re-exports.

### `mail/imap.py` — Moderately active
Mostly `since` option improvements and IMAP SEARCH date format fixes. Last meaningful change: 2025-12-24.

### `mail/graph.py` — Active
Multiple contributors. National cloud support added Feb 2025. DeviceFlow auth fix Mar 2024. Last meaningful change: Feb 2025.

### `constants.py` — Active (version bumps only)
Updated every release. The actual version string is maintained here; hatch reads it dynamically.

---

## 6. Core Dependencies (Parser Only)

These are required for the parser core. The full `pyproject.toml` mixes them with integration deps.

| Package | Used in | Purpose |
|---|---|---|
| `lxml` | `__init__.py` | XML parsing with error recovery (lxml.etree) |
| `xmltodict` | `__init__.py` | XML → dict (primary path) |
| `dnspython` | `utils.py` | DNS resolver, PTR lookups |
| `geoip2` | `utils.py` | IP-to-country lookup from MMDB |
| `publicsuffixlist` | `utils.py` | Base domain extraction |
| `requests` | `utils.py` | Download updated reverse DNS map CSV |
| `expiringdict` | `__init__.py`, `utils.py` | TTL cache for IP/report dedup |
| `mailparser` | `__init__.py`, `utils.py` | RFC 822 email parsing |
| `python-dateutil` | `utils.py` | Flexible timestamp parsing |
| `mailsuite` | `__init__.py` | `mailsuite.smtp.send_email` (email_results output fn) |

**Parser-only deps (no integration):** lxml, xmltodict, dnspython, geoip2, publicsuffixlist, requests, expiringdict, mailparser, python-dateutil

**Integration-only deps** (safe to drop): azure-identity, azure-monitor-ingestion, boto3, elasticsearch-dsl, elasticsearch, google-api-*, imapclient, kafka-python-ng, msgraph-core, opensearch-py, pygelf, tqdm, PyYAML

**Mailbox connector deps:**
- `imapclient` + `mailsuite` → IMAP
- `google-api-python-client`, `google-auth-*` → Gmail
- `msgraph-core`, `azure-identity` → MS Graph

**Bundled resources:**
- `resources/dbip/dbip-country-lite.mmdb` — fallback IP-to-country DB (bundled, ~10MB)
- `resources/maps/base_reverse_dns_map.csv` — ~2000 rows mapping IP reverse-DNS base domains to service names (e.g. `google.com` → `{name: "Google", type: "esp"}`)
- `resources/maps/psl_overrides.txt` — custom PSL entries

---

## 7. What We'd Need to Port to TypeScript

### 7a. Parser Logic

**XML parsing (aggregate reports):**
- Primary: `xmltodict` pattern → use `fast-xml-parser` or `xml2js`
- Recovery: `lxml` with `recover=True` → use `htmlparser2` or DOMParser in lenient mode
- Regex pre-processing: strip invalid XML headers and schema tags — direct port

**JSON parsing (SMTP TLS reports):**
- Pure JSON.parse with validation — trivial port

**Forensic report parsing:**
- Regex-based key-value extraction from `message/feedback-report` MIME part
- Email walking — need a MIME parser like `mailparser` npm or `postal-mime`

**Email parsing:**
- `mailparser` (Python) → `postal-mime` or `mailparser` (npm)
- Outlook MSG: `msgconvert` Perl tool → `@kenjiuno/msgreader` npm package
- Multipart MIME walking: handled by whatever email library chosen

**Base64/compression:**
- ZIP: Node.js `adm-zip` or `yauzl`
- GZIP: Node.js `zlib.gunzip`
- Base64: `Buffer.from(str, 'base64')`

### 7b. IP/DNS Enrichment

**DNS (PTR records):**
- `dnspython` → `dns` npm (`@leichtgewicht/dns` or native `dns.promises.reverse`)
- Default nameservers: Cloudflare 1.1.1.1/1.0.0.1

**GeoIP:**
- `geoip2` → `maxmind` npm package — same MMDB format, direct swap
- Bundled DBIP MMDB can be reused as-is

**Public Suffix List:**
- `publicsuffixlist` → `tldts` or `psl` npm packages

**Reverse DNS service map:**
- Bundled CSV → just bundle the CSV in TS project and parse at startup
- Remote refresh: optional HTTP fetch of same URL

**ExpiringDict:**
- `expiringdict` → `node-cache` or `lru-cache` with TTL

### 7c. Type Definitions
`types.py` maps almost 1:1 to TypeScript interfaces. Direct conversion:
- `TypedDict` → `interface`
- `Optional[str]` → `string | null`
- `Union[A, B]` → `A | B`
- `Literal["aggregate"]` → `"aggregate"` literal type
- `List[X]` → `X[]`
- Discriminated union `ParsedReport` → TypeScript discriminated union by `report_type`

### 7d. Key Edge Cases to Preserve
1. **Fractional seconds stripping** in UNIX timestamps: `"1234567890.5"` → split on "." and take first part
2. **Disposition coercion**: if disposition value is literally `"pass"` → coerce to `"none"` (ISP quirk)
3. **`identities` vs `identifiers`** key name variation in aggregate XML
4. **`envelope_from` inference**: if missing/null, fall back to last SPF result domain
5. **`org_name` normalization**: if no spaces, run through `get_base_domain()` to strip subdomains
6. **Report ID sanitization**: strip `<>` and `@domain` suffix
7. **policy_published as list**: some senders send it as array — take first element
8. **XML recovery**: if xmltodict fails, try lxml with `recover=True`, re-serialize, retry
9. **Timespan normalization**: reports spanning >24h get per-record count split into daily buckets with largest-remainder rounding
10. **SEEN_AGGREGATE_REPORT_IDS dedup**: keyed by `{org_name}_{report_id}` — 1-hour TTL
11. **`msgconvert` dependency**: Outlook MSG support requires external Perl utility

### 7e. What Can Be Dropped for TS Port
- `mailbox` (stdlib mbox support) — unlikely needed
- `email_results` (SMTP output of parsed results)
- `save_output` / `get_report_zip` (file output)
- All mailbox connectors (fetch from upstream or use your own)
- All integration sinks

### 7f. Estimated Scope
| Component | Lines (Python) | TS Complexity |
|---|---|---|
| `types.py` | 220 | Low — direct interface port |
| `constants.py` + `log.py` | 7 | Trivial |
| `utils.py` core (IP/DNS/timestamps) | ~500 | Medium — find npm equivalents |
| `utils.py` email helpers | ~200 | Medium |
| `__init__.py` aggregate parser | ~500 | Medium — XML handling |
| `__init__.py` forensic parser | ~150 | Low |
| `__init__.py` SMTP TLS parser | ~150 | Low |
| `__init__.py` email dispatcher | ~200 | Medium — MIME walking |
| `__init__.py` timespan normalization | ~150 | Low |
| Bundled resources | static files | Direct copy |
| **Total** | **~2000 logic lines** | **~4-6 days** |

---

## 8. Stability Summary

| File | Last Meaningful Change | Churn Level | Verdict |
|---|---|---|---|
| `types.py` | Dec 2025 | Low | Port now, stable |
| `constants.py` | Mar 2026 | Version bumps only | Trivial |
| `utils.py` | Dec 2025 | Medium | Stable core, type cleanup |
| `__init__.py` | Jan 2026 | High | Active bugfixing, track changes |
| `mail/*.py` | Dec 2024 – Feb 2025 | Low-Medium | Stable |

The most recent parser bug (Jan 2026): fractional seconds in UNIX timestamps from some senders (`"1234567890.123"`) caused timestamp parsing failures — fixed by `int(ts.split(".")[0])`.
