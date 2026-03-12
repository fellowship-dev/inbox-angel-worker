import { describe, it, expect } from 'vitest';
import { SPF_PROVIDERS, detectProviders, extractIncludes, extractOtherMechanisms, buildSpfRecord } from '../dashboard/src/spf-providers';

describe('SPF_PROVIDERS', () => {
  it('has at least 15 known providers', () => {
    expect(SPF_PROVIDERS.length).toBeGreaterThanOrEqual(15);
  });

  it('each provider has include and name', () => {
    for (const p of SPF_PROVIDERS) {
      expect(p.include).toBeTruthy();
      expect(p.name).toBeTruthy();
    }
  });

  it('has no duplicate includes', () => {
    const includes = SPF_PROVIDERS.map(p => p.include);
    expect(new Set(includes).size).toBe(includes.length);
  });
});

describe('detectProviders', () => {
  it('detects Google Workspace from SPF record', () => {
    const record = 'v=spf1 include:_spf.google.com ~all';
    const detected = detectProviders(record);
    expect(detected).toHaveLength(1);
    expect(detected[0].name).toBe('Google Workspace');
  });

  it('detects multiple providers', () => {
    const record = 'v=spf1 include:_spf.google.com include:sendgrid.net include:amazonses.com ~all';
    const detected = detectProviders(record);
    expect(detected).toHaveLength(3);
    expect(detected.map(p => p.name)).toEqual(['Google Workspace', 'SendGrid', 'Amazon SES']);
  });

  it('returns empty for record with no known providers', () => {
    const record = 'v=spf1 include:custom.example.com ~all';
    expect(detectProviders(record)).toHaveLength(0);
  });

  it('returns empty for empty string', () => {
    expect(detectProviders('')).toHaveLength(0);
  });

  it('does not false-match partial includes', () => {
    // 'google.com' should not match '_spf.google.com'
    const record = 'v=spf1 include:google.com ~all';
    expect(detectProviders(record)).toHaveLength(0);
  });
});

describe('extractIncludes', () => {
  it('extracts all include mechanisms', () => {
    const record = 'v=spf1 include:_spf.google.com include:sendgrid.net ~all';
    expect(extractIncludes(record)).toEqual(['_spf.google.com', 'sendgrid.net']);
  });

  it('returns empty for record with no includes', () => {
    expect(extractIncludes('v=spf1 ip4:192.168.1.0/24 ~all')).toEqual([]);
  });

  it('handles single include', () => {
    expect(extractIncludes('v=spf1 include:_spf.google.com -all')).toEqual(['_spf.google.com']);
  });

  it('handles empty string', () => {
    expect(extractIncludes('')).toEqual([]);
  });
});

describe('extractOtherMechanisms', () => {
  it('extracts mx mechanism', () => {
    expect(extractOtherMechanisms('v=spf1 include:_spf.protonmail.ch mx ~all')).toEqual(['mx']);
  });

  it('extracts ip4 and ip6', () => {
    expect(extractOtherMechanisms('v=spf1 ip4:192.168.1.0/24 ip6:2001:db8::/32 ~all')).toEqual(['ip4:192.168.1.0/24', 'ip6:2001:db8::/32']);
  });

  it('extracts redirect', () => {
    expect(extractOtherMechanisms('v=spf1 redirect=example.com')).toEqual(['redirect=example.com']);
  });

  it('returns empty when only includes and all', () => {
    expect(extractOtherMechanisms('v=spf1 include:_spf.google.com ~all')).toEqual([]);
  });

  it('handles a mechanism', () => {
    expect(extractOtherMechanisms('v=spf1 a include:_spf.google.com ~all')).toEqual(['a']);
  });
});

describe('buildSpfRecord', () => {
  it('builds record with single include', () => {
    expect(buildSpfRecord(['_spf.google.com'])).toBe('v=spf1 include:_spf.google.com ~all');
  });

  it('builds record with multiple includes', () => {
    expect(buildSpfRecord(['_spf.google.com', 'sendgrid.net'])).toBe(
      'v=spf1 include:_spf.google.com include:sendgrid.net ~all'
    );
  });

  it('defaults to ~all qualifier', () => {
    expect(buildSpfRecord(['_spf.google.com'])).toContain('~all');
  });

  it('supports -all qualifier', () => {
    expect(buildSpfRecord(['_spf.google.com'], '-all')).toBe('v=spf1 include:_spf.google.com -all');
  });

  it('builds empty record with just qualifier', () => {
    expect(buildSpfRecord([])).toBe('v=spf1 ~all');
  });

  it('preserves other mechanisms', () => {
    expect(buildSpfRecord(['_spf.protonmail.ch'], '~all', ['mx'])).toBe('v=spf1 include:_spf.protonmail.ch mx ~all');
  });

  it('preserves ip4 mechanisms', () => {
    expect(buildSpfRecord(['_spf.google.com'], '~all', ['ip4:192.168.1.0/24'])).toBe('v=spf1 include:_spf.google.com ip4:192.168.1.0/24 ~all');
  });
});
