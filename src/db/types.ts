// TypeScript types mirroring the D1 schema

export type Plan = 'free' | 'starter' | 'pro' | 'enterprise';
export type DmarcPolicy = 'none' | 'quarantine' | 'reject';
export type SpfResult = 'pass' | 'fail' | 'softfail' | 'neutral' | 'none' | 'permerror' | 'temperror';
export type DkimResult = 'pass' | 'fail' | 'none';
export type DmarcResult = 'pass' | 'fail' | 'none';
export type OverallStatus = 'protected' | 'at_risk' | 'exposed';
export type Disposition = 'none' | 'quarantine' | 'reject';

export interface Customer {
  id: string;
  name: string;
  email: string;
  plan: Plan;
  created_at: number;
  updated_at: number;
}

export interface Domain {
  id: number;
  customer_id: string;
  domain: string;
  rua_address: string;
  dmarc_policy: DmarcPolicy | null;
  dmarc_pct: number | null;
  spf_record: string | null;
  dkim_configured: 0 | 1;
  auth_record_provisioned: 0 | 1;
  dns_record_id: string | null;  // Cloudflare DNS record ID for deprovision
  created_at: number;
  updated_at: number;
}

export interface CheckResult {
  id: number;
  from_email: string;
  from_domain: string;
  spf_result: SpfResult | null;
  spf_domain: string | null;
  spf_record: string | null;
  dkim_result: DkimResult | null;
  dkim_domain: string | null;
  dmarc_result: DmarcResult | null;
  dmarc_policy: DmarcPolicy | null;
  dmarc_record: string | null;
  overall_status: OverallStatus;
  report_sent: 0 | 1;
  session_token: string | null;
  spf_lookup_count: number | null;
  created_at: number;
}

export interface AggregateReport {
  id: number;
  customer_id: string;
  domain_id: number;
  org_name: string;
  report_id: string;
  date_begin: number;
  date_end: number;
  total_count: number;
  pass_count: number;
  fail_count: number;
  raw_xml: string | null;
  created_at: number;
}

export interface MonitorSubscription {
  id: number;
  email: string;
  domain: string;
  session_token: string | null;
  spf_record: string | null;
  dmarc_policy: string | null;
  dmarc_pct: number | null;
  dmarc_record: string | null;
  active: 0 | 1;
  last_checked_at: number | null;
  created_at: number;
}

export interface ReportRecord {
  id: number;
  report_id: number;
  customer_id: string;
  source_ip: string;
  count: number;
  disposition: Disposition;
  dkim_result: DkimResult | null;
  dkim_domain: string | null;
  spf_result: SpfResult | null;
  spf_domain: string | null;
  header_from: string | null;
  reverse_dns: string | null;
  base_domain: string | null;
  country_code: string | null;
  org: string | null;
  created_at: number;
}

export interface IpInfoRow {
  ip: string;
  reverse_dns: string | null;
  base_domain: string | null;
  country_code: string | null;
  org: string | null;
  asn: string | null;
  fetched_at: number;
}
