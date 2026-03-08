// Resolves the customer and domain records from a DMARC policy domain.
//
// Reports are routed by the policy_domain field in the report XML, not by
// the recipient address — this allows a fixed rua address like
// rua@reports.yourdomain.com to serve all domains for a customer.
//
// Returns null if the domain is unknown (not provisioned in D1).

import { getDomainByName, getCustomer } from '../db/queries';
import { Customer, Domain } from '../db/types';

export interface ResolvedCustomer {
  customer: Customer;
  domain: Domain;
}

/**
 * Looks up customer + domain from a DMARC policy domain name.
 * Returns null if the domain is not registered.
 */
export async function resolveCustomer(
  db: D1Database,
  policyDomain: string,
): Promise<ResolvedCustomer | null> {
  const domain = await getDomainByName(db, policyDomain.toLowerCase());
  if (!domain) return null;

  const customer = await getCustomer(db, domain.customer_id);
  if (!customer) return null;

  return { customer, domain };
}
