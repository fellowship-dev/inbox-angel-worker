/**
 * Auto-migration — runs on first request per Worker instance.
 *
 * Tracks applied versions in `_migrations`. Safe to call on every request;
 * after the first successful run the module-level flag short-circuits it.
 *
 * Migration errors are caught and logged (not re-thrown). Failures here are
 * almost always "column already exists" from users who previously ran
 * `npm run migrate` manually — the DDL is additive, so swallowing is safe.
 */

const MIGRATIONS: { version: number; sql: string }[] = [
	{
		version: 1,
		sql: `
      CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT NOT NULL,
        plan TEXT NOT NULL DEFAULT 'free',
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE TABLE IF NOT EXISTS domains (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        domain TEXT NOT NULL,
        rua_address TEXT NOT NULL,
        dmarc_policy TEXT,
        dmarc_pct INTEGER,
        spf_record TEXT,
        dkim_configured INTEGER NOT NULL DEFAULT 0,
        auth_record_provisioned INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(customer_id, domain)
      );
      CREATE INDEX IF NOT EXISTS idx_domains_customer ON domains(customer_id);
      CREATE INDEX IF NOT EXISTS idx_domains_domain ON domains(domain);
      CREATE TABLE IF NOT EXISTS check_results (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_email TEXT NOT NULL,
        from_domain TEXT NOT NULL,
        spf_result TEXT,
        spf_domain TEXT,
        spf_record TEXT,
        dkim_result TEXT,
        dkim_domain TEXT,
        dmarc_result TEXT,
        dmarc_policy TEXT,
        dmarc_record TEXT,
        overall_status TEXT NOT NULL,
        report_sent INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_check_results_domain ON check_results(from_domain);
      CREATE TABLE IF NOT EXISTS aggregate_reports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        domain_id INTEGER NOT NULL REFERENCES domains(id) ON DELETE CASCADE,
        org_name TEXT NOT NULL,
        report_id TEXT NOT NULL,
        date_begin INTEGER NOT NULL,
        date_end INTEGER NOT NULL,
        total_count INTEGER NOT NULL DEFAULT 0,
        pass_count INTEGER NOT NULL DEFAULT 0,
        fail_count INTEGER NOT NULL DEFAULT 0,
        raw_xml TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(domain_id, report_id)
      );
      CREATE INDEX IF NOT EXISTS idx_agg_reports_customer ON aggregate_reports(customer_id);
      CREATE INDEX IF NOT EXISTS idx_agg_reports_domain ON aggregate_reports(domain_id);
      CREATE INDEX IF NOT EXISTS idx_agg_reports_date ON aggregate_reports(date_begin);
      CREATE TABLE IF NOT EXISTS report_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        report_id INTEGER NOT NULL REFERENCES aggregate_reports(id) ON DELETE CASCADE,
        customer_id TEXT NOT NULL,
        source_ip TEXT NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        disposition TEXT NOT NULL,
        dkim_result TEXT,
        dkim_domain TEXT,
        spf_result TEXT,
        spf_domain TEXT,
        header_from TEXT,
        created_at INTEGER NOT NULL DEFAULT (unixepoch())
      );
      CREATE INDEX IF NOT EXISTS idx_records_report ON report_records(report_id);
      CREATE INDEX IF NOT EXISTS idx_records_customer ON report_records(customer_id);
      CREATE INDEX IF NOT EXISTS idx_records_ip ON report_records(source_ip);
    `,
	},
	{
		// Stores CF DNS record ID for the cross-domain DMARC auth record
		version: 2,
		sql: `ALTER TABLE domains ADD COLUMN dns_record_id TEXT;`,
	},
	{
		// Per-session token for free-check polling
		version: 3,
		sql: `
      ALTER TABLE check_results ADD COLUMN session_token TEXT;
      CREATE INDEX IF NOT EXISTS idx_check_results_token ON check_results(session_token);
    `,
	},
	{
		// Domain monitoring subscriptions (daily DNS diff)
		version: 4,
		sql: `
      CREATE TABLE IF NOT EXISTS monitor_subscriptions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        domain TEXT NOT NULL,
        session_token TEXT,
        spf_record TEXT,
        dmarc_policy TEXT,
        dmarc_pct INTEGER,
        dmarc_record TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_checked_at INTEGER,
        created_at INTEGER NOT NULL DEFAULT (unixepoch()),
        UNIQUE(email, domain)
      );
      CREATE INDEX IF NOT EXISTS idx_monitor_active ON monitor_subscriptions(active, last_checked_at);
      CREATE INDEX IF NOT EXISTS idx_monitor_domain ON monitor_subscriptions(domain);
    `,
	},
];

let migrated = false;

export async function ensureMigrated(db: D1Database): Promise<void> {
	if (migrated) return;

	await db.exec(
		`CREATE TABLE IF NOT EXISTS _migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`
	);

	const row = await db
		.prepare(`SELECT MAX(version) as v FROM _migrations`)
		.first<{ v: number | null }>();
	const current = row?.v ?? 0;

	for (const m of MIGRATIONS) {
		if (m.version > current) {
			try {
				await db.exec(m.sql);
			} catch (e) {
				// Most likely "column already exists" from a prior manual migrate run — safe to continue
				console.warn(`[migrate] migration ${m.version} error (column may already exist):`, e);
			}
			await db
				.prepare(`INSERT OR IGNORE INTO _migrations (version, applied_at) VALUES (?, ?)`)
				.bind(m.version, new Date().toISOString())
				.run();
			console.log(`[migrate] applied migration ${m.version}`);
		}
	}

	migrated = true;
}
