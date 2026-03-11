import { AggregateReport, CheckResult, Domain, MonitorSubscription, ReportRecord, SpfFlattenConfig, MtaStsConfig, MtaStsMode, TlsReport } from './types';

// ── Domains ──────────────────────────────────────────────────

export function getDomainByName(db: D1Database, domain: string) {
  return db.prepare('SELECT * FROM domains WHERE domain = ?').bind(domain).first<Domain>();
}

export function getDomainById(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first<Domain>();
}

export function insertDomain(db: D1Database, d: Pick<Domain, 'domain' | 'rua_address'>) {
  return db.prepare(`
    INSERT INTO domains (domain, rua_address) VALUES (?, ?)
  `).bind(d.domain, d.rua_address).run();
}

export function getAllDomains(db: D1Database) {
  return db.prepare('SELECT * FROM domains ORDER BY id').all<Domain>();
}

export function updateDomainSpfLookupCount(db: D1Database, domainId: number, count: number) {
  return db.prepare(`UPDATE domains SET spf_lookup_count = ?, updated_at = unixepoch() WHERE id = ?`)
    .bind(count, domainId).run();
}

export function updateDomainDmarcPolicy(db: D1Database, domainId: number, policy: string) {
  return db.prepare(`UPDATE domains SET dmarc_policy = ?, updated_at = unixepoch() WHERE id = ?`)
    .bind(policy, domainId).run();
}

export function updateDomainDnsRecord(db: D1Database, domainId: number, recordId: string) {
  return db.prepare(`
    UPDATE domains SET dns_record_id = ?, auth_record_provisioned = 1, updated_at = unixepoch()
    WHERE id = ?
  `).bind(recordId, domainId).run();
}

// ── Check Results ────────────────────────────────────────────

export function insertCheckResult(db: D1Database, r: Omit<CheckResult, 'id' | 'created_at'>) {
  return db.prepare(`
    INSERT INTO check_results
      (from_email, from_domain, spf_result, spf_domain, spf_record,
       dkim_result, dkim_domain, dmarc_result, dmarc_policy, dmarc_record,
       overall_status, report_sent, session_token, spf_lookup_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    r.from_email, r.from_domain, r.spf_result, r.spf_domain, r.spf_record,
    r.dkim_result, r.dkim_domain, r.dmarc_result, r.dmarc_policy, r.dmarc_record,
    r.overall_status, r.report_sent, r.session_token ?? null,
    r.spf_lookup_count ?? null
  ).run();
}

export function getCheckResultByToken(db: D1Database, token: string) {
  return db.prepare('SELECT * FROM check_results WHERE session_token = ?')
    .bind(token).first<CheckResult>();
}

// ── Aggregate Reports ────────────────────────────────────────

export function insertAggregateReport(db: D1Database, r: Omit<AggregateReport, 'id' | 'created_at'>) {
  return db.prepare(`
    INSERT OR IGNORE INTO aggregate_reports
      (domain_id, org_name, report_id, date_begin, date_end,
       total_count, pass_count, fail_count, raw_xml)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    r.domain_id, r.org_name, r.report_id,
    r.date_begin, r.date_end, r.total_count, r.pass_count, r.fail_count, r.raw_xml
  ).run();
}

export function getRecentReports(db: D1Database, limit = 30) {
  return db.prepare(`
    SELECT r.*, d.domain FROM aggregate_reports r
    JOIN domains d ON d.id = r.domain_id
    ORDER BY r.date_begin DESC LIMIT ?
  `).bind(limit).all<AggregateReport & { domain: string }>();
}

// ── Monitor Subscriptions ─────────────────────────────────────

export function insertMonitorSubscription(
  db: D1Database,
  s: Pick<MonitorSubscription, 'email' | 'domain' | 'session_token' | 'spf_record' | 'dmarc_policy' | 'dmarc_pct' | 'dmarc_record'>
) {
  return db.prepare(`
    INSERT INTO monitor_subscriptions (email, domain, session_token, spf_record, dmarc_policy, dmarc_pct, dmarc_record)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(email, domain) DO NOTHING
  `).bind(s.email, s.domain, s.session_token ?? null, s.spf_record ?? null, s.dmarc_policy ?? null, s.dmarc_pct ?? null, s.dmarc_record ?? null).run();
}

export function getActiveSubscriptions(db: D1Database, limit = 100) {
  return db.prepare(`
    SELECT ms.* FROM monitor_subscriptions ms
    JOIN domains d ON d.domain = ms.domain
    WHERE ms.active = 1 AND d.alerts_enabled = 1
    ORDER BY ms.last_checked_at ASC NULLS FIRST
    LIMIT ?
  `).bind(limit).all<MonitorSubscription>();
}

export function updateSubscriptionBaseline(
  db: D1Database,
  id: number,
  baseline: Pick<MonitorSubscription, 'spf_record' | 'dmarc_policy' | 'dmarc_pct' | 'dmarc_record'>
) {
  return db.prepare(`
    UPDATE monitor_subscriptions
    SET spf_record = ?, dmarc_policy = ?, dmarc_pct = ?, dmarc_record = ?, last_checked_at = unixepoch()
    WHERE id = ?
  `).bind(baseline.spf_record ?? null, baseline.dmarc_policy ?? null, baseline.dmarc_pct ?? null, baseline.dmarc_record ?? null, id).run();
}

// ── Weekly Digest ─────────────────────────────────────────────

export interface DomainWeeklyStat {
  domain_id: number;
  domain: string;
  dmarc_policy: string | null;
  total_messages: number;
  pass_messages: number;
  fail_messages: number;
  report_count: number;
}

export interface FailingSource {
  source_ip: string;
  total: number;
  header_from: string | null;
}

export function getWeeklyDomainStats(db: D1Database, since: number) {
  return db.prepare(`
    SELECT
      d.id AS domain_id,
      d.domain,
      d.dmarc_policy,
      COALESCE(SUM(r.total_count), 0) AS total_messages,
      COALESCE(SUM(r.pass_count),  0) AS pass_messages,
      COALESCE(SUM(r.fail_count),  0) AS fail_messages,
      COUNT(r.id) AS report_count
    FROM domains d
    LEFT JOIN aggregate_reports r ON r.domain_id = d.id AND r.date_begin >= ?
    GROUP BY d.id, d.domain, d.dmarc_policy
    ORDER BY d.domain
  `).bind(since).all<DomainWeeklyStat>();
}

export function getTopFailingSources(db: D1Database, domainId: number, since: number, limit = 5) {
  return db.prepare(`
    SELECT rr.source_ip, SUM(rr.count) AS total, rr.header_from,
           MAX(rr.base_domain) AS base_domain, MAX(rr.org) AS org
    FROM report_records rr
    JOIN aggregate_reports ar ON ar.id = rr.report_id
    WHERE ar.domain_id = ? AND ar.date_begin >= ?
      AND (rr.dkim_result = 'fail' OR rr.spf_result = 'fail')
    GROUP BY rr.source_ip
    ORDER BY total DESC
    LIMIT ?
  `).bind(domainId, since, limit).all<FailingSource>();
}

export interface AnomalySource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  total: number;
  spf_pass: number;  // 1 if any record had spf pass in window
  dkim_pass: number; // 1 if any record had dkim pass in window
  first_seen: string; // YYYY-MM-DD
  last_seen: string;  // YYYY-MM-DD
  base_domain: string | null;
  org: string | null;
}

export function getAnomalySources(db: D1Database, domainId: number, since: number) {
  return db.prepare(`
    SELECT
      rr.source_ip,
      rr.header_from,
      rr.spf_domain,
      rr.dkim_domain,
      SUM(rr.count) AS total,
      MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
      MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
      MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
      MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
      MAX(rr.base_domain) AS base_domain,
      MAX(rr.org) AS org
    FROM report_records rr
    JOIN aggregate_reports ar ON ar.id = rr.report_id
    WHERE ar.domain_id = ?
      AND ar.date_begin >= ?
      AND (rr.spf_result != 'pass' OR rr.dkim_result != 'pass')
    GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain
    ORDER BY total DESC
  `).bind(domainId, since).all<AnomalySource>();
}

export function getAllSources(db: D1Database, domainId: number, since: number) {
  return db.prepare(`
    SELECT
      rr.source_ip,
      rr.header_from,
      rr.spf_domain,
      rr.dkim_domain,
      SUM(rr.count) AS total,
      MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
      MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
      MIN(date(datetime(ar.date_begin, 'unixepoch'))) AS first_seen,
      MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen,
      MAX(rr.base_domain) AS base_domain,
      MAX(rr.org) AS org
    FROM report_records rr
    JOIN aggregate_reports ar ON ar.id = rr.report_id
    WHERE ar.domain_id = ?
      AND ar.date_begin >= ?
    GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain
    ORDER BY total DESC
  `).bind(domainId, since).all<AnomalySource>();
}

export interface DailyDomainStat {
  day: string;
  total: number;
  passed: number;
  failed: number;
}

export function getDomainStats(db: D1Database, domainId: number, since: number) {
  return db.prepare(`
    SELECT
      date(datetime(date_begin, 'unixepoch')) AS day,
      SUM(total_count) AS total,
      SUM(pass_count)  AS passed,
      SUM(fail_count)  AS failed
    FROM aggregate_reports
    WHERE domain_id = ? AND date_begin >= ?
    GROUP BY day
    ORDER BY day ASC
  `).bind(domainId, since).all<DailyDomainStat>();
}

// ── Report Detail (per-date source breakdown) ─────────────────

export interface ReportSource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  count: number;
  spf_pass: number;  // 1 if any record had spf pass, else 0
  dkim_pass: number; // 1 if any record had dkim pass, else 0
  disposition: string;
  reporters: string; // comma-separated org names
}

export interface DayReportSummary {
  total: number;
  passed: number;
  failed: number;
}

export function getReportSourcesByDate(db: D1Database, domainId: number, date: string) {
  return db.prepare(`
    SELECT
      rr.source_ip,
      rr.header_from,
      rr.spf_domain,
      rr.dkim_domain,
      SUM(rr.count) AS count,
      MAX(CASE WHEN rr.spf_result  = 'pass' THEN 1 ELSE 0 END) AS spf_pass,
      MAX(CASE WHEN rr.dkim_result = 'pass' THEN 1 ELSE 0 END) AS dkim_pass,
      rr.disposition,
      GROUP_CONCAT(DISTINCT ar.org_name) AS reporters
    FROM report_records rr
    JOIN aggregate_reports ar ON ar.id = rr.report_id
    WHERE ar.domain_id = ?
      AND date(datetime(ar.date_begin, 'unixepoch')) = ?
    GROUP BY rr.source_ip, rr.header_from, rr.spf_domain, rr.dkim_domain, rr.disposition
    ORDER BY count DESC
  `).bind(domainId, date).all<ReportSource>();
}

export function getDayReportSummary(db: D1Database, domainId: number, date: string) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(total_count), 0) AS total,
      COALESCE(SUM(pass_count),  0) AS passed,
      COALESCE(SUM(fail_count),  0) AS failed
    FROM aggregate_reports
    WHERE domain_id = ?
      AND date(datetime(date_begin, 'unixepoch')) = ?
  `).bind(domainId, date).first<DayReportSummary>();
}

// ── Export ────────────────────────────────────────────────────

export interface ExportRow {
  date: string;
  org_name: string;
  total_count: number;
  pass_count: number;
  fail_count: number;
  source_ip: string | null;
  header_from: string | null;
  spf_result: string | null;
  spf_domain: string | null;
  dkim_result: string | null;
  dkim_domain: string | null;
  record_count: number | null;
  disposition: string | null;
}

export function getDomainExportData(db: D1Database, domainId: number) {
  return db.prepare(`
    SELECT
      date(datetime(ar.date_begin, 'unixepoch')) AS date,
      ar.org_name,
      ar.total_count,
      ar.pass_count,
      ar.fail_count,
      rr.source_ip,
      rr.header_from,
      rr.spf_result,
      rr.spf_domain,
      rr.dkim_result,
      rr.dkim_domain,
      rr.count AS record_count,
      rr.disposition
    FROM aggregate_reports ar
    LEFT JOIN report_records rr ON rr.report_id = ar.id
    WHERE ar.domain_id = ?
    ORDER BY ar.date_begin DESC, rr.count DESC
  `).bind(domainId).all<ExportRow>();
}

// ── Settings ─────────────────────────────────────────────────

export function getSetting(db: D1Database, key: string) {
  return db.prepare(`SELECT value FROM settings WHERE key = ?`).bind(key).first<{ value: string }>();
}

export function setSetting(db: D1Database, key: string, value: string) {
  return db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `).bind(key, value).run();
}

/**
 * Batch-fetch multiple settings in a single D1 round-trip.
 * Returns a Map<key, value> — missing keys are omitted.
 */
export async function getSettings(db: D1Database, keys: string[]): Promise<Map<string, string>> {
  if (keys.length === 0) return new Map();
  const placeholders = keys.map(() => '?').join(', ');
  const { results } = await db.prepare(`SELECT key, value FROM settings WHERE key IN (${placeholders})`)
    .bind(...keys).all<{ key: string; value: string }>();
  return new Map(results.map(r => [r.key, r.value]));
}

/**
 * Persist config values to D1 settings table.
 * Upserts each key — safe to call multiple times.
 */
export async function persistConfig(db: D1Database, config: Record<string, string>): Promise<void> {
  const stmt = db.prepare(`
    INSERT INTO settings (key, value) VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = unixepoch()
  `);
  await db.batch(Object.entries(config).map(([k, v]) => stmt.bind(k, v)));
}

// ── Monitor Subscriptions (management) ───────────────────────

export function getMonitorSubsByDomain(db: D1Database, domain: string) {
  return db.prepare(`SELECT * FROM monitor_subscriptions WHERE domain = ? ORDER BY created_at`)
    .bind(domain).all<MonitorSubscription>();
}

export function setMonitorSubActive(db: D1Database, id: number, active: boolean) {
  return db.prepare(`UPDATE monitor_subscriptions SET active = ? WHERE id = ?`)
    .bind(active ? 1 : 0, id).run();
}

export function setDomainAlertsEnabled(db: D1Database, domainId: number, enabled: boolean) {
  return db.prepare(`UPDATE domains SET alerts_enabled = ? WHERE id = ?`)
    .bind(enabled ? 1 : 0, domainId).run();
}

// ── Users ─────────────────────────────────────────────────────

export interface User {
  id: string;
  email: string;
  name: string;
  password_hash: string | null;
  role: 'admin' | 'member';
  session_token: string | null;
  last_login_at: number | null;
  created_at: number;
}

export function getUserByEmail(db: D1Database, email: string) {
  return db.prepare(`SELECT * FROM users WHERE email = ?`).bind(email).first<User>();
}

export function getUserBySession(db: D1Database, token: string) {
  return db.prepare(`SELECT * FROM users WHERE session_token = ?`).bind(token).first<User>();
}

export function getAllUsers(db: D1Database) {
  return db.prepare(`SELECT id, email, name, role, last_login_at, created_at FROM users ORDER BY created_at`).all<Omit<User, 'password_hash' | 'session_token'>>();
}

export function insertUser(db: D1Database, u: Pick<User, 'id' | 'email' | 'name' | 'password_hash' | 'role'>) {
  return db.prepare(`INSERT INTO users (id, email, name, password_hash, role) VALUES (?, ?, ?, ?, ?)`)
    .bind(u.id, u.email, u.name, u.password_hash, u.role).run();
}

export function setUserSession(db: D1Database, userId: string, token: string | null) {
  return db.prepare(`UPDATE users SET session_token = ?, last_login_at = unixepoch() WHERE id = ?`)
    .bind(token, userId).run();
}

export function deleteUser(db: D1Database, id: string) {
  return db.prepare(`DELETE FROM users WHERE id = ?`).bind(id).run();
}

// ── Invites ───────────────────────────────────────────────────

export interface Invite {
  token: string;
  email: string;
  role: string;
  invited_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

export function getInvite(db: D1Database, token: string) {
  return db.prepare(`SELECT * FROM invites WHERE token = ?`).bind(token).first<Invite>();
}

export function insertInvite(db: D1Database, inv: Pick<Invite, 'token' | 'email' | 'role' | 'invited_by' | 'expires_at'>) {
  return db.prepare(`INSERT INTO invites (token, email, role, invited_by, expires_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(inv.token, inv.email, inv.role, inv.invited_by, inv.expires_at).run();
}

export function markInviteUsed(db: D1Database, token: string) {
  return db.prepare(`UPDATE invites SET used_at = unixepoch() WHERE token = ?`).bind(token).run();
}

// ── Password Reset Tokens ────────────────────────────────────

export interface PasswordResetToken {
  token: string;
  user_id: string;
  expires_at: number;
  used_at: number | null;
}

export function insertPasswordResetToken(db: D1Database, token: string, userId: string, expiresAt: number) {
  return db.prepare(`INSERT INTO password_reset_tokens (token, user_id, expires_at) VALUES (?, ?, ?)`)
    .bind(token, userId, expiresAt).run();
}

export function getPasswordResetToken(db: D1Database, token: string) {
  return db.prepare(`SELECT * FROM password_reset_tokens WHERE token = ?`).bind(token).first<PasswordResetToken>();
}

export function markResetTokenUsed(db: D1Database, token: string) {
  return db.prepare(`UPDATE password_reset_tokens SET used_at = unixepoch() WHERE token = ?`).bind(token).run();
}

// ── SPF Flatten Config ────────────────────────────────────────

export function getSpfFlattenConfig(db: D1Database, domainId: number) {
  return db.prepare(`SELECT * FROM spf_flatten_config WHERE domain_id = ?`)
    .bind(domainId).first<SpfFlattenConfig>();
}

export function getAllEnabledSpfFlattenConfigs(db: D1Database) {
  return db.prepare(`SELECT * FROM spf_flatten_config WHERE enabled = 1`)
    .all<SpfFlattenConfig>();
}

export function upsertSpfFlattenConfig(
  db: D1Database,
  c: Pick<SpfFlattenConfig, 'domain_id' | 'canonical_record' | 'lookup_count' | 'cf_record_id'>
) {
  return db.prepare(`
    INSERT INTO spf_flatten_config (domain_id, enabled, cf_record_id, canonical_record, lookup_count)
    VALUES (?, 1, ?, ?, ?)
    ON CONFLICT(domain_id) DO UPDATE SET
      enabled = 1,
      cf_record_id = COALESCE(excluded.cf_record_id, cf_record_id),
      canonical_record = excluded.canonical_record,
      lookup_count = excluded.lookup_count,
      last_error = NULL,
      updated_at = unixepoch()
  `).bind(c.domain_id, c.cf_record_id, c.canonical_record, c.lookup_count).run();
}

export function updateSpfFlattenResult(
  db: D1Database,
  domainId: number,
  flattened_record: string,
  ip_count: number,
  cf_record_id: string
) {
  return db.prepare(`
    UPDATE spf_flatten_config
    SET flattened_record = ?, ip_count = ?, cf_record_id = ?,
        last_flattened_at = unixepoch(), last_error = NULL, updated_at = unixepoch()
    WHERE domain_id = ?
  `).bind(flattened_record, ip_count, cf_record_id, domainId).run();
}

export function updateSpfFlattenError(db: D1Database, domainId: number, error: string) {
  return db.prepare(`
    UPDATE spf_flatten_config
    SET last_error = ?, updated_at = unixepoch()
    WHERE domain_id = ?
  `).bind(error, domainId).run();
}

export function deleteSpfFlattenConfig(db: D1Database, domainId: number) {
  return db.prepare(`DELETE FROM spf_flatten_config WHERE domain_id = ?`)
    .bind(domainId).run();
}

// ── MTA-STS Config ────────────────────────────────────────────

export function getMtaStsConfig(db: D1Database, domainId: number) {
  return db.prepare(`SELECT * FROM mta_sts_config WHERE domain_id = ?`)
    .bind(domainId).first<MtaStsConfig>();
}

export function getMtaStsConfigByDomain(db: D1Database, domain: string) {
  return db.prepare(`
    SELECT m.* FROM mta_sts_config m
    JOIN domains d ON d.id = m.domain_id
    WHERE d.domain = ? AND m.enabled = 1
  `).bind(domain).first<MtaStsConfig>();
}

export function getAllEnabledMtaStsConfigs(db: D1Database) {
  return db.prepare(`SELECT * FROM mta_sts_config WHERE enabled = 1`).all<MtaStsConfig>();
}

export function insertMtaStsConfig(
  db: D1Database,
  c: Pick<MtaStsConfig, 'domain_id' | 'mode' | 'mx_hosts' | 'policy_id' | 'mta_sts_record_id' | 'tls_rpt_record_id' | 'cname_record_id'>
) {
  return db.prepare(`
    INSERT INTO mta_sts_config
      (domain_id, mode, mx_hosts, policy_id, mta_sts_record_id, tls_rpt_record_id, cname_record_id)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(c.domain_id, c.mode, c.mx_hosts, c.policy_id, c.mta_sts_record_id, c.tls_rpt_record_id, c.cname_record_id).run();
}

export function updateMtaStsMode(db: D1Database, domainId: number, mode: MtaStsMode, policy_id: string) {
  return db.prepare(`
    UPDATE mta_sts_config SET mode = ?, policy_id = ?, last_error = NULL, updated_at = unixepoch()
    WHERE domain_id = ?
  `).bind(mode, policy_id, domainId).run();
}

export function updateMtaStsMxHosts(db: D1Database, domainId: number, mx_hosts: string, policy_id: string) {
  return db.prepare(`
    UPDATE mta_sts_config SET mx_hosts = ?, policy_id = ?, updated_at = unixepoch()
    WHERE domain_id = ?
  `).bind(mx_hosts, policy_id, domainId).run();
}

export function updateMtaStsError(db: D1Database, domainId: number, error: string) {
  return db.prepare(`UPDATE mta_sts_config SET last_error = ?, updated_at = unixepoch() WHERE domain_id = ?`)
    .bind(error, domainId).run();
}

export function deleteMtaStsConfig(db: D1Database, domainId: number) {
  return db.prepare(`DELETE FROM mta_sts_config WHERE domain_id = ?`).bind(domainId).run();
}

// ── TLS Reports ───────────────────────────────────────────────

export function insertTlsReport(db: D1Database, r: Omit<TlsReport, 'id' | 'created_at'>) {
  return db.prepare(`
    INSERT INTO tls_reports
      (domain_id, org_name, date_begin, date_end,
       total_success, total_failure, failure_details, raw_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(domain_id, org_name, date_begin) DO UPDATE SET
      total_success = excluded.total_success,
      total_failure = excluded.total_failure,
      failure_details = excluded.failure_details,
      raw_json = excluded.raw_json
  `).bind(
    r.domain_id, r.org_name, r.date_begin, r.date_end,
    r.total_success, r.total_failure, r.failure_details, r.raw_json
  ).run();
}

export function getTlsReportSummary(db: D1Database, domainId: number, since: number) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(total_success), 0) AS total_success,
      COALESCE(SUM(total_failure), 0) AS total_failure,
      COUNT(*) AS report_count
    FROM tls_reports
    WHERE domain_id = ? AND date_begin >= ?
  `).bind(domainId, since).first<{ total_success: number; total_failure: number; report_count: number }>();
}

// ── Audit Log ─────────────────────────────────────────────────

export interface AuditLogRow {
  id: number;
  actor_id: string | null;
  actor_email: string | null;
  actor_type: 'user' | 'system';
  action: string;
  resource_type: string | null;
  resource_id: string | null;
  resource_name: string | null;
  before_value: string | null;  // JSON string
  after_value: string | null;   // JSON string
  meta: string | null;          // JSON string
  created_at: number;
}

export function getAuditLog(
  db: D1Database,
  opts: {
    page?: number;
    limit?: number;
    action?: string;
    domain_id?: string;
    actor_id?: string;
    since?: number;
    until?: number;
  } = {},
) {
  const { page = 1, limit = 50, action, domain_id, actor_id, since, until } = opts;
  const safeLimit = Math.min(limit, 200);
  const offset = (page - 1) * safeLimit;

  const conditions: string[] = [];
  const params: (string | number)[] = [];

  if (action) {
    conditions.push('action LIKE ?');
    params.push(action.replace(/%/g, '') + '%');
  }
  if (domain_id) {
    conditions.push("(resource_id = ? AND resource_type = 'domain')");
    params.push(domain_id);
  }
  if (actor_id) {
    conditions.push('actor_id = ?');
    params.push(actor_id);
  }
  if (since) {
    conditions.push('created_at >= ?');
    params.push(since);
  }
  if (until) {
    conditions.push('created_at <= ?');
    params.push(until);
  }

  params.push(safeLimit, offset);

  const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  return db
    .prepare(
      `SELECT * FROM audit_log ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`,
    )
    .bind(...params)
    .all<AuditLogRow>();
}

// ── Report Records ───────────────────────────────────────────

export function insertReportRecords(db: D1Database, records: Omit<ReportRecord, 'id' | 'created_at'>[]) {
  const stmt = db.prepare(`
    INSERT INTO report_records
      (report_id, source_ip, count, disposition,
       dkim_result, dkim_domain, spf_result, spf_domain, header_from,
       reverse_dns, base_domain, country_code, org)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return db.batch(records.map(r =>
    stmt.bind(
      r.report_id, r.source_ip, r.count, r.disposition,
      r.dkim_result, r.dkim_domain, r.spf_result, r.spf_domain, r.header_from,
      r.reverse_dns ?? null, r.base_domain ?? null, r.country_code ?? null, r.org ?? null
    )
  ));
}

// ── Telemetry heartbeat ───────────────────────────────────────

export interface HeartbeatStats {
  domain_count: number;
  dns_verified_count: number;
  spf_flatten_count: number;
  mta_sts_testing_count: number;
  mta_sts_enforce_count: number;
  reports_30d: number;
  tls_reports_30d: number;
  team_member_count: number;
  instance_age_days: number;
}

export async function getHeartbeatStats(db: D1Database): Promise<HeartbeatStats> {
  const since30d = Math.floor(Date.now() / 1000) - 30 * 86400;
  const [domains, spf, mta, reports, tls, users, age] = await db.batch([
    db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN auth_record_provisioned = 1 THEN 1 ELSE 0 END) AS verified FROM domains`),
    db.prepare(`SELECT COUNT(*) AS n FROM spf_flatten_configs WHERE enabled = 1`),
    db.prepare(`SELECT SUM(CASE WHEN mode = 'testing' THEN 1 ELSE 0 END) AS testing, SUM(CASE WHEN mode = 'enforce' THEN 1 ELSE 0 END) AS enforce FROM mta_sts_configs WHERE enabled = 1`),
    db.prepare(`SELECT COUNT(*) AS n FROM aggregate_reports WHERE created_at > ?`).bind(since30d),
    db.prepare(`SELECT COUNT(*) AS n FROM tls_reports WHERE created_at > ?`).bind(since30d),
    db.prepare(`SELECT COUNT(*) AS n FROM users`),
    db.prepare(`SELECT MIN(created_at) AS first FROM users`),
  ]);

  const d = domains.results[0] as { n: number; verified: number } | undefined;
  const s = spf.results[0] as { n: number } | undefined;
  const m = mta.results[0] as { testing: number; enforce: number } | undefined;
  const r = reports.results[0] as { n: number } | undefined;
  const t = tls.results[0] as { n: number } | undefined;
  const u = users.results[0] as { n: number } | undefined;
  const a = age.results[0] as { first: number | null } | undefined;

  const firstTs = a?.first ?? Math.floor(Date.now() / 1000);
  const ageDays = Math.floor((Math.floor(Date.now() / 1000) - firstTs) / 86400);

  return {
    domain_count: d?.n ?? 0,
    dns_verified_count: d?.verified ?? 0,
    spf_flatten_count: s?.n ?? 0,
    mta_sts_testing_count: m?.testing ?? 0,
    mta_sts_enforce_count: m?.enforce ?? 0,
    reports_30d: r?.n ?? 0,
    tls_reports_30d: t?.n ?? 0,
    team_member_count: u?.n ?? 0,
    instance_age_days: ageDays,
  };
}
