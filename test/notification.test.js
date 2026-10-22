import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { notificationReport, needsNotification, notificationSummary } from '../src/notification.js';

const report = () => ({ generation: { status: 'partial' }, publication: { status: 'succeeded' },
  failures: [{ source: 'official', channelName: '测试频道', date: '2026-10-22', phase: 'fetch', message: 'HTTP 503' }], warnings: [] });

test('source failures trigger a failed check after publication and explain retained EPG', () => {
  const value = report();
  assert(needsNotification(value));
  assert.match(notificationSummary(value), /发布完成/);
  assert.match(notificationSummary(value), /已发布 EPG 保留/);
  assert.match(notificationSummary(value), /测试频道 \/ 2026-10-22/);
  value.publication.status = 'failed';
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

test('CLI returns failure for partial or missing reports, success for healthy publication, without mail setup', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'epg-notification-'));
  try {
    const summary = join(directory, 'summary.md');
    const env = { ...process.env, GITHUB_STEP_SUMMARY: summary, EPG_TEST_RESULT: 'success', EPG_PUBLISH_JOB_RESULT: 'success', EPG_GENERATION_RESULT: 'success', EPG_PUBLICATION_RESULT: 'success' };
    const run = () => spawnSync(process.execPath, [resolve('src/notify.js'), directory], { env, encoding: 'utf8' });
    await writeFile(join(directory, 'run-report.json'), JSON.stringify(report()));
    let result = run(); assert.equal(result.status, 1); assert.match(result.stderr, /::error::/);
    assert.match(await readFile(summary, 'utf8'), /已发布 EPG 保留/);
    const healthy = report(); healthy.failures = []; healthy.generation.status = 'complete';
    await writeFile(join(directory, 'run-report.json'), JSON.stringify(healthy));
    result = run(); assert.equal(result.status, 0, result.stderr);
    await rm(join(directory, 'run-report.json'));
    assert.equal(run().status, 1);
    await writeFile(join(directory, 'run-report.json'), '{invalid');
    assert.equal(run().status, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
