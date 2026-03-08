import { AggregateReport, CheckResult, Customer, Domain, MonitorSubscription, ReportRecord } from './types';

// ── Customers ────────────────────────────────────────────────

export function getCustomer(db: D1Database, id: string) {
  return db.prepare('SELECT * FROM customers WHERE id = ?').bind(id).first<Customer>();
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
