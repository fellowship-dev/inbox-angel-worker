import { AggregateReport, CheckResult, Customer, Domain, MonitorSubscription, ReportRecord } from './types';

// ── Customers ────────────────────────────────────────────────

export function getCustomer(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<Customer>();
}

export function getAllCustomers(db: D1Database) {
  return db.prepare('SELECT * FROM customers ORDER BY created_at').all<Customer>();
}

export function upsertCustomer(db: D1Database, c: Pick<Customer, 'id' | 'name' | 'email' | 'plan'>) {
  return db.prepare(`
    INSERT INTO customers (id, name, email, plan)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, email=excluded.email, plan=excluded.plan, updated_at=unixepoch()
  `).bind(c.id, c.name, c.email, c.plan).run();
}

// ── Domains ──────────────────────────────────────────────────

export function getDomainsByCustomer(db: D1Database, customerId: string) {
  return db.prepare('SELECT * FROM domains WHERE customer_id = ? ORDER BY domain')
    .bind(customerId).all<Domain>();
}

export function getDomainByName(db: D1Database, domain: string) {
  return db.prepare('SELECT * FROM domains WHERE domain = ?').bind(domain).first<Domain>();
}

export function getDomainById(db: D1Database, id: number) {
  return db.prepare('SELECT * FROM domains WHERE id = ?').bind(id).first<Domain>();
}

export function insertDomain(db: D1Database, d: Pick<Domain, 'customer_id' | 'domain' | 'rua_address'>) {
  return db.prepare(`
    INSERT INTO domains (customer_id, domain, rua_address) VALUES (?, ?, ?)
  `).bind(d.customer_id, d.domain, d.rua_address).run();
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
       overall_status, report_sent, session_token)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    r.from_email, r.from_domain, r.spf_result, r.spf_domain, r.spf_record,
    r.dkim_result, r.dkim_domain, r.dmarc_result, r.dmarc_policy, r.dmarc_record,
    r.overall_status, r.report_sent, r.session_token ?? null
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
      (customer_id, domain_id, org_name, report_id, date_begin, date_end,
       total_count, pass_count, fail_count, raw_xml)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(
    r.customer_id, r.domain_id, r.org_name, r.report_id,
    r.date_begin, r.date_end, r.total_count, r.pass_count, r.fail_count, r.raw_xml
  ).run();
}

export function getRecentReports(db: D1Database, customerId: string, limit = 30) {
  return db.prepare(`
    SELECT r.*, d.domain FROM aggregate_reports r
    JOIN domains d ON d.id = r.domain_id
    WHERE r.customer_id = ?
    ORDER BY r.date_begin DESC LIMIT ?
  `).bind(customerId, limit).all<AggregateReport & { domain: string }>();
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
    SELECT * FROM monitor_subscriptions
    WHERE active = 1
    ORDER BY last_checked_at ASC NULLS FIRST
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

export function getWeeklyDomainStats(db: D1Database, customerId: string, since: number) {
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
    WHERE d.customer_id = ?
    GROUP BY d.id, d.domain, d.dmarc_policy
    ORDER BY d.domain
  `).bind(since, customerId).all<DomainWeeklyStat>();
}

export function getTopFailingSources(db: D1Database, domainId: number, since: number, limit = 5) {
  return db.prepare(`
    SELECT rr.source_ip, SUM(rr.count) AS total, rr.header_from
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
      MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen
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
      MAX(date(datetime(ar.date_begin, 'unixepoch'))) AS last_seen
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

// ── Monitor Subscriptions (management) ───────────────────────

export function getMonitorSubsByDomain(db: D1Database, domain: string) {
  return db.prepare(`SELECT * FROM monitor_subscriptions WHERE domain = ? ORDER BY created_at`)
    .bind(domain).all<MonitorSubscription>();
}

export function setMonitorSubActive(db: D1Database, id: number, active: boolean) {
  return db.prepare(`UPDATE monitor_subscriptions SET active = ? WHERE id = ?`)
    .bind(active ? 1 : 0, id).run();
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

export function setUserSession(db: D1Database, userId: string, token: string) {
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

// ── Report Records ───────────────────────────────────────────

export function insertReportRecords(db: D1Database, records: Omit<ReportRecord, 'id' | 'created_at'>[]) {
  const stmt = db.prepare(`
    INSERT INTO report_records
      (report_id, customer_id, source_ip, count, disposition,
       dkim_result, dkim_domain, spf_result, spf_domain, header_from)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  return db.batch(records.map(r =>
    stmt.bind(
      r.report_id, r.customer_id, r.source_ip, r.count, r.disposition,
      r.dkim_result, r.dkim_domain, r.spf_result, r.spf_domain, r.header_from
    )
  ));
}
