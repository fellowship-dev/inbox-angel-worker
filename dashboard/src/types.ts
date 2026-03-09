export interface Domain {
  id: number;
  domain: string;
  dmarc_policy: 'none' | 'quarantine' | 'reject' | null;
  rua_address: string;
  customer_id: string;
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
