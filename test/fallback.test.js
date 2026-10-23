import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { FallbackSource, validateSnapshot, loadPublishedFallback, legacySnapshot } from '../src/fallback.js';
import { collect, writeArtifacts, renderXml } from '../src/epg.js';

const date = '2026-10-23', old = '2026-10-22T01:00:00Z';
const start = Date.parse(date + 'T08:00:00+08:00') / 1000;
const channel = { id: 'cctv1', pid: '600001859', name: 'CCTV1', aliases: [], dates: [date], groupId: 'cctv' };
const programme = { channel: channel.id, title: '已发布当日节目', start, stop: start + 3600 };
const snapshot = () => ({ schemaVersion: 1, date, generatedAt: old, channels: [channel], programmes: [programme] });
const options = { today: date, pastDays: 0, futureDays: 0, minChannels: 1, delayMs: 0, allowPartial: true };
const source = work => ({ channels: async () => [channel], programmes: work });
const wrapped = work => new FallbackSource(source(work), [validateSnapshot(snapshot(), date)], { dates: [date] });

test('same-channel same-date fallback survives network, invalid, conflicting and empty live responses', async () => {
  for (const work of [async () => { throw new Error('HTTP 503'); }, async () => [],
    async () => [{ name: '坏时间', st: 0, et: 1 }],
    async () => [{ name: 'A', st: start, et: start + 3600 }, { name: 'B', st: start, et: start + 3600 }]]) {
    const adapter = wrapped(work);
    const data = await collect(adapter, options);
    assert.equal(data.programmes[0].title, programme.title);
    assert.equal(adapter.usage.size, 1);
    assert.deepEqual([...adapter.usage.values()][0].generatedAt, [old]);
  }
});

test('fresh validated data wins over the fallback; cached dates never shift into today', async () => {
  const adapter = wrapped(async () => [{ name: '最新节目', st: start, et: start + 7200 }]);
  const data = await collect(adapter, options);
  assert.equal(data.programmes[0].title, '最新节目');
  assert.equal(adapter.usage.size, 0);
  assert.throws(() => validateSnapshot({ ...snapshot(), date: '2026-10-22' }, date), /Invalid/);
  assert.throws(() => validateSnapshot({ ...snapshot(), programmes: [{ ...programme, start: start - 86400, stop: start - 80000 }] }, date), /outside/);
  const wrong = { ...snapshot(), date: '2026-10-22', programmes: [{ ...programme, start: start - 86400, stop: start - 80000 }] };
  const unavailable = new FallbackSource(source(async () => { throw new Error('HTTP 503'); }), [validateSnapshot(wrong, wrong.date)], { dates: [date] });
  await assert.rejects(collect(unavailable, options), /No programmes/);
});

test('discovery outage retains cached channel IDs, cross-midnight real times and original observation time after re-publication', async () => {
  const crossing = { ...programme, start: start - 9 * 3600, stop: start - 7 * 3600, observedAt: old };
  const cached = validateSnapshot({ ...snapshot(), programmes: [crossing, programme] }, date);
  const adapter = new FallbackSource({ channels: async () => { throw new Error('discovery timeout'); } }, [cached], { dates: ['2026-10-22', date] });
  const data = await collect(adapter, options);
  assert(data.programmes.some(p => p.start === crossing.start && p.stop === crossing.stop));
  data.manifest.fallbackUsage = [...adapter.usage.values()];
  const directory = await mkdtemp(join(tmpdir(), 'epg-snapshot-'));
  try {
    await writeArtifacts(directory, data);
    const next = validateSnapshot(JSON.parse(await readFile(join(directory, date, 'snapshot.json'))), date);
    assert(next.programmes.every(p => p.observedAt === old));
    assert(next.programmes.some(p => p.title === programme.title));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('download verifies SHA256, rejects corrupt snapshots and can bootstrap existing published XML assets', async () => {
  const json = JSON.stringify(snapshot());
  const hashes = text => createHash('sha256').update(text).digest('hex');
  const get = async files => loadPublishedFallback('example/epg', [date], { fetchImpl: async url => {
    const name = new URL(url).pathname.split('/').at(-1);
    return new Response(files[name] ?? '', { status: files[name] ? 200 : 404 });
  } });
  assert.equal((await get({ 'SHA256SUMS': hashes(json) + '  snapshot.json\n', 'snapshot.json': json })).snapshots.length, 1);
  const corrupt = await get({ 'SHA256SUMS': '0'.repeat(64) + '  snapshot.json\n', 'snapshot.json': json });
  assert.equal(corrupt.snapshots.length, 0);
  assert.match(corrupt.warnings[0].message, /checksum/);
  const files = { 'epg.xml': renderXml([channel], [programme]), 'channels.json': JSON.stringify([channel]),
    'manifest.json': JSON.stringify({ date, generatedAt: old }) };
  files.SHA256SUMS = Object.entries(files).map(([name, body]) => hashes(body) + '  ' + name + '\n').join('');
  const loaded = await get(files);
  assert.equal(loaded.snapshots.length, 1);
  assert.equal(loaded.snapshots[0].programmes[0].title, programme.title);
  assert.throws(() => legacySnapshot('<!DOCTYPE tv><tv/>', [channel], { date }, date), /Unsupported/);
});

test('today is attempted before old dates can exhaust a source circuit', async () => {
  const order = [];
  const data = await collect({ channels: async () => [{ ...channel, dates: ['2026-10-20', '2026-10-21', '2026-10-22', date] }],
    programmes: async (_c, day) => { order.push(day); if (day !== date) throw new Error('HTTP 503'); return [{ name: '今日', st: start, et: start + 3600 }]; },
  }, { ...options, pastDays: 2, concurrency: 1 });
  assert.equal(order[0], date);
  assert.equal(data.programmes[0].title, '今日');
});

test('cached recovery still limits repeated requests against an offline provider', async () => {
  let calls = 0;
  const channels = Array.from({ length: 10 }, (_, i) => ({ ...channel, id: 'c' + i }));
  const cached = validateSnapshot({ ...snapshot(), channels, programmes: channels.map(c => ({ ...programme, channel: c.id })) }, date);
  const adapter = new FallbackSource({ channels: async () => channels, programmes: async () => { calls++; throw new Error('fetch failed: ECONNRESET'); } },
    [cached], { dates: [date] });
  const data = await collect(adapter, { ...options, concurrency: 1 });
  assert.equal(calls, 3);
  assert.equal(data.programmes.length, 10);
  assert.equal(adapter.usage.size, 10);
});
