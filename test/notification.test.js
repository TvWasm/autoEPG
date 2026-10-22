import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { notificationReport, needsNotification, notificationSummary, notificationLevel } from '../src/notification.js';
import { writeDiagnosticReports } from '../src/report.js';

const report = () => ({ generation: { status: 'partial' }, publication: { status: 'succeeded' },
  failures: [{ source: 'official', channelName: '测试频道', date: '2026-10-22', phase: 'fetch', message: 'HTTP 503' }], warnings: [] });

test('source failures warn after successful publication; actual publication failures still fail', () => {
  const value = report();
  assert(needsNotification(value));
  assert.equal(notificationLevel(value), 'warning');
  assert.equal(notificationLevel(value, { strict: true }), 'error');
  assert.match(notificationSummary(value), /发布完成/);
  assert.match(notificationSummary(value), /已发布 EPG 保留/);
  assert.match(notificationSummary(value), /测试频道 \/ 2026-10-22/);
  value.publication.status = 'failed';
  assert.equal(notificationLevel(value), 'error');
  assert.match(notificationSummary(value), /发布未全部完成/);
  assert(!notificationSummary(value).includes('正常数据已发布'));
});

test('missing reports, timeouts, skipped publication and test failures cannot pass silently', () => {
  const missing = notificationReport(null, { EPG_PUBLISH_JOB_RESULT: 'failure' });
  assert(needsNotification(missing));
  assert.equal(missing.publication.status, 'unknown');
  const skipped = notificationReport(null, { EPG_TEST_RESULT: 'failure', EPG_PUBLICATION_RESULT: 'skipped' });
  assert.equal(skipped.publication.status, 'skipped');
  assert(skipped.failures.some(f => f.phase === 'test'));
  const published = notificationReport(report(), { EPG_PUBLISH_JOB_RESULT: 'failure', EPG_PUBLICATION_RESULT: 'failure' });
  assert.equal(published.publication.status, 'succeeded');
  const pending = report(); pending.failures = []; pending.publication.status = 'pending';
  assert(needsNotification(pending));
});

test('summary redacts URL secrets and renders untrusted source text as inert details', () => {
  const value = report(); value.failures[0].message = '<script>bad</script>\n::error::injected https://example.test/?token=private';
  const summary = notificationSummary(value);
  assert(!summary.includes('<script>'));
  assert(!summary.includes('=private'));
  assert(!summary.includes('\n::error::injected'));
});

test('source overview shows later providers even when one outage fills the detail limit', () => {
  const value = report();
  value.failures = Array.from({ length: 105 }, () => ({ source: 'first', phase: 'skipped', message: 'circuit open' }));
  value.failures.push({ source: 'last', phase: 'fetch', message: 'HTTP 403 (server: edge)' });
  const summary = notificationSummary(value);
  assert.match(summary, /last.*HTTP 403/);
  assert.match(summary, /105 项跳过/);
});

test('CLI warns for partial publication, supports strict alerts and fails for missing or corrupt reports', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'epg-notification-'));
  try {
    const summary = join(directory, 'summary.md');
    const env = { ...process.env, EPG_STRICT_SOURCE_ALERTS: 'false', GITHUB_STEP_SUMMARY: summary, EPG_TEST_RESULT: 'success', EPG_PUBLISH_JOB_RESULT: 'success', EPG_GENERATION_RESULT: 'success', EPG_PUBLICATION_RESULT: 'success' };
    const run = () => spawnSync(process.execPath, [resolve('src/notify.js'), directory], { env, encoding: 'utf8' });
    await writeFile(join(directory, 'run-report.json'), JSON.stringify(report()));
    let result = run(); assert.equal(result.status, 0, result.stderr); assert.match(result.stderr, /::warning::/);
    assert.match(await readFile(summary, 'utf8'), /已发布 EPG 保留/);
    assert.match(await readFile(join(directory, 'diagnostics', 'report.txt'), 'utf8'), /测试频道/);
    env.EPG_STRICT_SOURCE_ALERTS = 'true';
    result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /::error::/);
    env.EPG_STRICT_SOURCE_ALERTS = 'false';
    const healthy = report(); healthy.failures = []; healthy.generation.status = 'complete';
    await writeFile(join(directory, 'run-report.json'), JSON.stringify(healthy));
    result = run(); assert.equal(result.status, 0, result.stderr);
    await rm(join(directory, 'run-report.json'));
    assert.equal(run().status, 1);
    await writeFile(join(directory, 'run-report.json'), '{invalid');
    assert.equal(run().status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('infrastructure failures, unknown generation and missing reports remain fatal even if publication succeeded', () => {
  for (const phase of ['publication', 'publication-report', 'test', 'generation', 'job', 'report']) {
    const value = report(); value.failures[0].phase = phase;
    assert.equal(notificationLevel(value), 'error', phase);
  }
  assert.equal(notificationLevel(notificationReport(null, { EPG_PUBLICATION_RESULT: 'success' })), 'error');
  const value = report(); value.generation.status = 'unknown';
  assert.equal(notificationLevel(value), 'error');
});

test('readable reports retain every detail, distinguish skipped requests, redact secrets and escape HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'epg-readable-report-'));
  try {
    const value = report(); value.generation.channelCount = 155; value.generation.programmeCount = 38902;
    value.failures = Array.from({ length: 130 }, (_, i) => ({ source: 'official', sourceName: '测试省台',
      channelName: '测试频道', date: '2026-10-22', phase: i ? 'skipped' : 'fetch',
      url: 'https://example.test/?token=private', message: i ? `跳过-${i}` : '<script>alert(1)</script> HTTP 403' }));
    await writeDiagnosticReports(directory, value, 'warning');
    const text = await readFile(join(directory, 'report.txt'), 'utf8');
    const html = await readFile(join(directory, 'report.html'), 'utf8');
    const json = JSON.parse(await readFile(join(directory, 'report.json'), 'utf8'));
    assert.match(text, /实际错误记录 1；熔断跳过 129/);
    assert.match(text, /跳过-129/);
    assert.match(html, /跳过-129/);
    assert(!html.includes('<script>'));
    assert(!text.includes('=private'));
    assert(!html.includes('=private'));
    assert.equal(json.failures.length, 130);
    assert.equal(json.checkLevel, 'warning');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
