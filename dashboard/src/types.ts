export interface Domain {
  id: number;
  domain: string;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  rua_address: string;
  customer_id: string;
  created_at: number; // unix timestamp
  alerts_enabled: number; // 1 = on, 0 = off
}

export interface DailyStat {
  day: string;
  total: number;
  passed: number;
  failed: number;
}

export interface DomainStats {
  domain: string;
  days: number;
  stats: DailyStat[];
}

export interface AddDomainResult {
  domain: Domain;
  rua_hint: string;
  manual_dns?: boolean;
  dns_instructions?: string;
}

export interface FailingSource {
  source_ip: string;
  total: number;
  header_from: string | null;
  base_domain: string | null;
  org: string | null;
}

export interface ReportSource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  count: number;
  spf_pass: number;
  dkim_pass: number;
  disposition: string;
  reporters: string;
  base_domain: string | null;
  org: string | null;
}

export interface AnomalySource {
  source_ip: string;
  header_from: string | null;
  spf_domain: string | null;
  dkim_domain: string | null;
  total: number;
  spf_pass: number;
  dkim_pass: number;
  first_seen: string; // YYYY-MM-DD
  last_seen: string;  // YYYY-MM-DD
  base_domain: string | null;
  org: string | null;
}

export interface CheckResult {
  id: number;
  from_email: string;
  from_domain: string;
  spf_result: string | null;
  spf_domain: string | null;
  spf_record: string | null;
  dkim_result: string | null;
  dkim_domain: string | null;
  dmarc_result: string | null;
  dmarc_policy: string | null;
  dmarc_record: string | null;
  overall_status: 'protected' | 'at_risk' | 'exposed';
  session_token: string | null;
  spf_lookup_count: number | null;
  created_at: number;
}

export interface AggregateReport {
  id: number;
  domain: string;
  org_name: string;
  report_id: string;
  date_begin: number; // unix timestamp
  date_end: number;   // unix timestamp
  total_count: number;
  pass_count: number;
  fail_count: number;
}

export interface DayReport {
  date: string;
  domain: string;
  summary: { total: number; passed: number; failed: number };
  sources: ReportSource[];
}
