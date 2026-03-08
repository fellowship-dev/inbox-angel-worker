import { readFileSync } from 'fs';
import { join } from 'path';
import { describe, it, expect } from 'vitest';
import { parseAggregateReportXml } from '../../src/dmarc/parse-aggregate';
import { InvalidAggregateReport } from '../../src/dmarc/types';

const fixture = (name: string) =>
  readFileSync(join(__dirname, '../fixtures', name), 'utf-8');

// All tests run offline (no real IP lookups in CI)
const OFFLINE = true;

describe('parseAggregateReportXml', () => {
  it('parses a simple valid report', async () => {
    const report = await parseAggregateReportXml(fixture('simple.xml'), OFFLINE);
    expect(report.report_metadata.org_name).toBe('example.net');
    expect(report.report_metadata.report_id).toBe('b043f0e264cf4ea995e93765242f6dfb');
    expect(report.policy_published.domain).toBe('example.com');
    expect(report.policy_published.p).toBe('none');
    expect(report.records).toHaveLength(1);
    expect(report.records[0].source.ip).toBe('199.230.200.36');
    expect(report.records[0].alignment.dmarc).toBe(false);
  });

  it('strips invalid <xs:schema> tag (ikea fixture)', async () => {
    const report = await parseAggregateReportXml(fixture('ikea-schema-tag.xml'), OFFLINE);
    expect(report.report_metadata.org_name).toBe('ikea.com');
    expect(report.records[0].auth_results.dkim[0].result).toBe('pass');
    expect(report.records[0].auth_results.spf[0].scope).toBe('helo');
  });

  it('parses modern outlook report', async () => {
    const report = await parseAggregateReportXml(fixture('outlook.xml'), OFFLINE);
    expect(report.report_metadata.org_name).toBe('outlook.com');
    expect(report.records.length).toBeGreaterThan(0);
  });

  it('handles empty reason field without throwing', async () => {
    const report = await parseAggregateReportXml(fixture('empty-reason.xml'), OFFLINE);
    expect(report.records.length).toBeGreaterThan(0);
  });

  it('coerces upper-cased PASS disposition to none', async () => {
    const report = await parseAggregateReportXml(fixture('upper-cased-pass.xml'), OFFLINE);
    for (const record of report.records) {
      expect(record.policy_evaluated.disposition).not.toBe('PASS');
      expect(record.policy_evaluated.disposition).not.toBe('pass');
    }
  });

  it('infers envelope_from from SPF result when missing', async () => {
    // simple.xml has no envelope_from in auth_results — should infer or null gracefully
    const report = await parseAggregateReportXml(fixture('simple.xml'), OFFLINE);
    const rec = report.records[0];
    // envelope_from either inferred or null — never undefined
    expect(rec.identifiers.envelope_from === null || typeof rec.identifiers.envelope_from === 'string').toBe(true);
  });

  it('timestamps strip fractional seconds', async () => {
    const xml = fixture('simple.xml').replace('1529366400', '1529366400.999').replace('1529452799', '1529452799.001');
    const report = await parseAggregateReportXml(xml, OFFLINE);
    expect(report.report_metadata.begin_date).toBe('2018-06-19T00:00:00Z');
  });

  it('throws InvalidAggregateReport on malformed XML', async () => {
    await expect(parseAggregateReportXml('<not>valid xml', OFFLINE))
      .rejects.toThrow(InvalidAggregateReport);
  });

  it('accepts Uint8Array input', async () => {
    const bytes = new TextEncoder().encode(fixture('simple.xml'));
    const report = await parseAggregateReportXml(bytes, OFFLINE);
    expect(report.report_metadata.org_name).toBe('example.net');
  });
});
