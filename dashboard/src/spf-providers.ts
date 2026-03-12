/** Known email provider SPF include mechanisms */
export interface SpfProvider {
  include: string;
  name: string;
}

export const SPF_PROVIDERS: SpfProvider[] = [
  { include: '_spf.google.com', name: 'Google Workspace' },
  { include: 'spf.protection.outlook.com', name: 'Microsoft 365' },
  { include: 'sendgrid.net', name: 'SendGrid' },
  { include: 'amazonses.com', name: 'Amazon SES' },
  { include: 'mailgun.org', name: 'Mailgun' },
  { include: 'mandrillapp.com', name: 'Mandrill (Mailchimp)' },
  { include: 'servers.mcsv.net', name: 'Mailchimp' },
  { include: 'spf.brevo.com', name: 'Brevo' },
  { include: 'mailjet.com', name: 'Mailjet' },
  { include: 'spf.postmarkapp.com', name: 'Postmark' },
  { include: 'resend.com', name: 'Resend' },
  { include: '_spf.protonmail.ch', name: 'Proton Mail' },
  { include: 'hubspot.net', name: 'HubSpot' },
  { include: 'mail.zendesk.com', name: 'Zendesk' },
  { include: 'zoho.com', name: 'Zoho Mail' },
  { include: 'mxroute.com', name: 'MXRoute' },
];

/** Detect which known providers are present in an SPF record string */
export function detectProviders(spfRecord: string): SpfProvider[] {
  return SPF_PROVIDERS.filter(p => spfRecord.includes(`include:${p.include}`));
}

/** Extract all include: mechanisms from an SPF record (including unknown ones) */
export function extractIncludes(spfRecord: string): string[] {
  const matches = spfRecord.match(/include:([^\s]+)/g) ?? [];
  return matches.map(m => m.replace('include:', ''));
}

/** Extract non-include mechanisms from an SPF record (mx, a, ip4:, ip6:, redirect=, etc.) */
export function extractOtherMechanisms(spfRecord: string): string[] {
  return spfRecord.split(/\s+/).filter(part =>
    part !== 'v=spf1' &&
    !part.startsWith('include:') &&
    !part.match(/^[~+?-]?all$/)
  );
}

/** Build an SPF record from includes + other mechanisms */
export function buildSpfRecord(includes: string[], qualifier: '~all' | '-all' = '~all', otherMechanisms: string[] = []): string {
  const parts = ['v=spf1', ...includes.map(i => `include:${i}`), ...otherMechanisms, qualifier];
  return parts.join(' ');
}
