export interface Domain {
  id: number;
  domain: string;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  rua_address: string;
  customer_id: string;
  created_at: number; // unix timestamp
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
}

export interface DayReport {
  date: string;
  summary: { total: number; passed: number; failed: number };
  sources: ReportSource[];
}
