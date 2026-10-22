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
