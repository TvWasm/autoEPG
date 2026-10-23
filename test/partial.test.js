import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collect, writeArtifacts } from '../src/epg.js';
import { Provincial } from '../src/provincial.js';
import { EpgSources } from '../src/cctv.js';
import { sourceFailure } from '../src/diagnostics.js';

const date = '2026-10-22', st = Date.parse(date + 'T08:00:00+08:00') / 1000;
const good = { name: '正常节目', st, et: st + 3600 };
const channel = (id, sourceId = id) => ({ id, pid: id, name: id, dates: [date], aliases: [], groupId: 'provincial', source: 'provincial', sourceId });
const options = { today: date, pastDays: 0, futureDays: 0, minChannels: 50, minTodayCoverage: 0.9, delayMs: 0, allowPartial: true };

test('transport and schema failures exclude only their channel/date and valid EPGs remain publishable below old thresholds', async () => {
  const source = { channels: async () => [channel('healthy'), channel('timeout'), channel('malformed')],
    programmes: async c => { if (c.id === 'timeout') throw new Error('HTTP 503'); return c.id === 'malformed' ? [{ ...good, et: 0 }] : [good]; } };
  const data = await collect(source, options);
  assert.equal(data.manifest.partial, true);
  assert.equal(data.programmes.length, 1);
  assert.equal(data.programmes[0].channel, 'healthy');
  assert.equal(data.manifest.failures.length, 2);
  assert(data.manifest.warnings.some(w => w.code === 'today-coverage'));
  assert(data.manifest.warnings.some(w => w.code === 'min-channels'));
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-partial-'));
  try {
    const index = await writeArtifacts(directory, data);
    assert(index.releases.some(r => r.date === date));
    const m = JSON.parse(await readFile(join(directory, date, 'manifest.json')));
    assert.equal(m.partial, true);
    assert.equal(m.failures.length, 2);
    assert((await readFile(join(directory, date, 'epg.xml'), 'utf8')).includes('正常节目'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('persistent conflicts and refresh errors quarantine only affected dates', async () => {
  const a = channel('healthy'), b = channel('conflicting'), c = channel('refresh-error');
  const data = await collect({ channels: async () => [a, b, c],
    programmes: async c => c.id === 'healthy' ? [good] : [good, { ...good, name: '冲突节目' }],
    refreshProgrammes: async c => { if (c.id === 'refresh-error') throw new Error('HTTP 503'); return [good, { ...good, name: '冲突节目' }]; },
  }, options);
  assert.deepEqual(data.programmes.map(p => p.channel), ['healthy']);
  assert(data.manifest.failures.some(f => f.channel === 'conflicting' && f.phase === 'conflict'));
  assert(data.manifest.failures.some(f => f.channel === 'refresh-error' && f.phase === 'refresh'));
  assert.equal(data.manifest.scheduleRechecks.at(-1).reason, 'excluded-persistent-conflicts');
});

test('one broken provider opens a bounded circuit while healthy providers continue', async () => {
  let calls = 0;
  const bad = Array.from({ length: 12 }, (_, i) => channel('bad' + i, 'offline'));
  const data = await collect({ channels: async () => [...bad, channel('healthy')], programmes: async c => {
    if (c.sourceId === 'offline') { calls++; throw new Error('fetch failed: ECONNRESET'); } return [good];
  } }, { ...options, concurrency: 1 });
  assert.equal(calls, 3);
  assert.equal(data.manifest.failures.filter(f => f.phase === 'skipped').length, 9);
  assert.equal(data.programmes.length, 1);
});

test('a broken provincial adapter does not stop other adapters or remaining workers', async () => {
  let calls = 0;
  const entries = [...Array.from({ length: 12 }, (_, i) => ({ id: 'bad' + i, name: '坏源' + i, aliases: [], province: '测试', urls: ['https://official.example/'], native: { type: 'bad', channelId: String(i) } })),
    { id: 'healthy', name: '正常源', aliases: [], province: '测试', urls: ['https://official.example/'], native: { type: 'good', channelId: '1' } }];
  const source = new Provincial({ dates: [date], today: date, allowPartial: true, catalogue: { source: 'fixture', checkedAt: date, channels: entries },
    adapters: { bad: { name: '坏源', source: 'https://bad.example/', programmes: async () => { calls++; throw new Error('HTTP 503'); } },
      good: { name: '正常源', source: 'https://good.example/', programmes: async () => [good] } },
  });
  const channels = await source.channels();
  assert.deepEqual(channels.map(c => c.id), ['healthy']);
  assert(calls <= 6, 'at most three failures plus already in-flight workers');
  assert(source.failures.some(f => f.phase === 'skipped'));
  assert.equal(source.report.channels.find(c => c.id === 'bad0').status, 'fetch-failed');
  assert(source.warnings.some(w => w.code === 'provincial-missing-today'));
});

test('Yangshipin discovery failure still discovers official provincial and CCTV4 channels', async () => {
  const provincial = { failures: [], warnings: [], report: { targetCount: 1 },
    channels: async existing => { assert(existing.some(c => c.id === 'cctv1')); return [channel('healthy')]; } };
  const source = new EpgSources({ dates: [date], allowPartial: true, provincial,
    yangshipin: { channels: async () => { throw new Error('timeout'); } } });
  const channels = await source.channels();
  assert(channels.some(c => c.id === 'healthy'));
  assert(channels.some(c => c.id === 'cctv4europe'));
  assert(channels.some(c => c.id === 'cctv4america'));
  assert.equal(source.failures[0].source, 'yangshipin');
});

test('all failed sources and historical-only results never replace the current EPG', async () => {
  await assert.rejects(collect({ channels: async () => [channel('bad')], programmes: async () => { throw new Error('HTTP 503'); } }, options), error => {
    assert.equal(error.failures.length, 1); return /No programmes/.test(error.message);
  });
  const old = { ...channel('old'), dates: ['2026-10-21'] };
  await assert.rejects(collect({ channels: async () => [old], programmes: async () => [{ ...good, st: st - 86400, et: st - 86400 + 3600 }] },
    { ...options, pastDays: 1 }), /No valid current-day/);
  const error = sourceFailure({ source: 'test', error: new Error('https://official.example/?app_secret=secret&signature=private&date=2026-10-22') });
  assert(!error.message.includes('=secret'));
  assert(!error.message.includes('=private'));
});
