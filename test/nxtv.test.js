import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { nxtvProgrammes } from '../src/official.js';
import { Provincial, PROVINCIAL_CATALOGUE } from '../src/provincial.js';
import { collect } from '../src/epg.js';

const fixture = JSON.parse(await readFile(new URL('./fixtures/provincial/nxtv.json', import.meta.url), 'utf8'));
test('Ningxia official three-channel response preserves exact airtimes and only its published day', async () => {
  let requests = 0;
  const options = { cache: new Map(), fetchImpl: async url => {
    assert.equal(url, 'https://api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv');
    requests++;
    return Response.json(fixture);
  } };
  for (const [id, count] of [['nxws', 45], ['nxgg', 22], ['nxwl', 30]]) {
    const rows = await nxtvProgrammes(id, '2026-10-22', options);
    assert.equal(rows.length, count);
    const original = fixture.data.menu.find(c => c.ename === id).playbill;
    assert.deepEqual(rows.map(r => [r.name, r.st, r.et]), original.map(r => [r.name, r.stimestamp, r.otimestamp]));
    assert.deepEqual(await nxtvProgrammes(id, '2026-10-21', options), []);
    assert.deepEqual(await nxtvProgrammes(id, '2026-10-23', options), []);
  }
  assert.equal(requests, 1);
});

test('Ningxia adapter rejects missing channels, invalid schemas and inconsistent official timestamps', async () => {
  await assert.rejects(nxtvProgrammes('other', '2026-10-22'), /channel ID/);
  for (const mutate of [b => { b.errcode = 500; }, b => { b.data.menu = []; },
    b => { b.data.menu[0].playbill[0].stimestamp++; }]) {
    const body = structuredClone(fixture); mutate(body);
    await assert.rejects(nxtvProgrammes('nxws', '2026-10-22', { fetchImpl: async () => Response.json(body) }));
  }
});

test('Ningxia additions join daily generation, preserving existing satellite identity and fallback dates', async () => {
  const catalogue = { ...PROVINCIAL_CATALOGUE, channels: PROVINCIAL_CATALOGUE.channels.filter(c => c.native?.type === 'nxtv') };
  const source = new Provincial({ catalogue, dates: ['2026-10-21', '2026-10-22', '2026-10-23'], today: '2026-10-22',
    fetchImpl: async () => Response.json(fixture) });
  const existing = [{ id: 'ningxiaweishi', aliases: ['宁夏卫视'], dates: ['2026-10-23'], groupId: 'weishi', logo: 'keep.png' }];
  const added = await source.channels(existing);
  assert.deepEqual(added.map(c => c.id), ['ningxiagonggong', 'ningxiawenlv']);
  assert.equal(existing[0].groupId, 'weishi');
  assert.equal(existing[0].logo, 'keep.png');
  assert.deepEqual(existing[0].dates, ['2026-10-22', '2026-10-23']);
  const dataset = await collect({ channels: async () => [...existing, ...added], programmes: (c, d) => source.programmes(c, d) },
    { today: '2026-10-22', pastDays: 0, futureDays: 0, minChannels: 3, delayMs: 0 });
  assert.equal(dataset.channels.length, 3);
  assert.equal(dataset.programmes.length, 97);
  assert.equal(source.report.importedCount, 2);
});
