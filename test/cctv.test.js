import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CCTV_CHANNELS, EpgSources, cctvProgrammes } from '../src/cctv.js';
import { collect, renderXml, writeArtifacts } from '../src/epg.js';

test('real CCTV responses preserve independent schedules, second precision and player aliases', async () => {
  const dates = ['2026-10-22'];
  const source = new EpgSources({ dates, yangshipin: { channels: async () => [] },
    fetchImpl: async url => new Response(await readFile(new URL(`./fixtures/cctv/${new URL(url).searchParams.get('c')}.json`, import.meta.url))),
  });
  const dataset = await collect(source, { today: dates[0], pastDays: 0, futureDays: 0,
    minChannels: 2, minTodayCoverage: 1, delayMs: 0 });
  assert.equal(dataset.channels.length, 2);
  assert.deepEqual(dataset.manifest.missingToday, []);
  const europe = dataset.programmes.filter(p => p.channel === 'cctv4europe');
  const america = dataset.programmes.filter(p => p.channel === 'cctv4america');
  assert(europe.length > 30 && america.length > 30);
  assert.notEqual(europe[0].title, america[0].title);
  assert(dataset.programmes.some(p => p.start % 60 !== 0));
  const xml = renderXml(dataset.channels, dataset.programmes);
  assert(xml.includes('CCTV4(欧)') && xml.includes('CCTV4(美)'));
  assert(xml.includes('https://tv.cctv.com/live/cctveurope/'));
  assert(xml.includes('+0800'));
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-cctv-'));
  try {
    const index = await writeArtifacts(directory, dataset);
    const release = index.releases.find(r => r.date === dates[0]);
    for (const file of ['epg.xml', 'epg-cctv.xml']) {
      assert(release.assets.includes(file));
      const content = await readFile(join(directory, dates[0], file), 'utf8');
      for (const channel of dataset.channels) {
        assert(content.includes(`<channel id="${channel.id}">`));
        assert(content.includes(`channel="${channel.id}"`));
      }
    }
    const mappings = JSON.parse(await readFile(join(directory, dates[0], 'channels.json'), 'utf8'));
    assert(JSON.stringify(mappings).includes('CCTV4(欧)'));
    assert(JSON.stringify(mappings).includes('CCTV4(美)'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('unpublished CCTV dates are empty, malformed responses fail, HTTP errors retry', async () => {
  const channel = CCTV_CHANNELS[0];
  const options = { retries: 1, fetchImpl: async () => Response.json({ data: {
    cctveurope: { channelName: 'CCTV-4 (欧洲)' },
  } }) };
  assert.deepEqual(await cctvProgrammes(channel, '2026-10-29', options), []);
  await assert.rejects(cctvProgrammes(channel, '2026-10-22', {
    retries: 1, fetchImpl: async () => Response.json({ data: {} }),
  }), /Invalid CCTV/);
  let calls = 0;
  await cctvProgrammes(channel, '2026-10-22', { ...options, retries: 2, delay: async () => {},
    fetchImpl: async () => ++calls === 1 ? new Response('', { status: 503 }) : options.fetchImpl(),
  });
  assert.equal(calls, 2);
});

test('domestic CCTV falls back to the official CCTV API when Yangshipin is empty, invalid or offline', async () => {
  const date = '2026-10-23', st = Date.parse(date + 'T08:00:00+08:00') / 1000;
  const channel = { id: 'cctv1', pid: '600001859', name: 'CCTV1' };
  for (const work of [async () => [], async () => [{ name: '坏时间', st: 0, et: 1 }], async () => { throw new Error('HTTP 503'); }]) {
    const source = new EpgSources({ dates: [date], allowPartial: true, yangshipin: { programmes: work },
      retries: 1, fetchImpl: async url => {
        assert.equal(new URL(url).searchParams.get('c'), 'cctv1');
        assert.equal(new URL(url).searchParams.get('d'), '20261023');
        return Response.json({ data: { cctv1: { channelName: 'CCTV1', list: [{ title: '央视网当日节目', startTime: st, endTime: st + 3600 }] } } });
      } });
    const rows = await source.programmes(channel, date);
    assert.equal(rows[0].name, '央视网当日节目');
    assert(source.warnings.some(w => w.code === 'official-alternate'));
  }
});
