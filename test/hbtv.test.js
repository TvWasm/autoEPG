import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hbtvProgrammes } from '../src/official.js';
import { Provincial, PROVINCIAL_CATALOGUE } from '../src/provincial.js';
import { collect, writeArtifacts } from '../src/epg.js';
import { XMLParser } from 'fast-xml-parser';

const fixtures = Object.fromEntries(await Promise.all(['204', '338', '339', '178', '180', '340'].map(async code =>
  [code, JSON.parse(await readFile(new URL(`./fixtures/provincial/hbtv-${code}.json`, import.meta.url), 'utf8'))])));
fixtures['337'] = { code: 200, data: [] };
fixtures['179'] = { code: 200, data: [] };

function network(transform = body => body) {
  const requests = [];
  return { requests, cache: new Map(), fetchImpl: async (url, init) => {
    requests.push(url);
    if (url === 'https://res.cjyun.org/t/common/app/iptv/') return new Response('<script src=./static/js/manifest.aabbcc.js></script>');
    if (url.endsWith('/manifest.aabbcc.js')) return new Response('x+{0:"aabbcc",1:"ddeeff"}[e]');
    if (url.endsWith('/0.aabbcc.js')) return new Response('r.a.defaults.headers.Authorization="anonymousWebFixture"');
    const u = new URL(url);
    assert.equal(u.hostname, 'cjy-iptv.hbtv.com.cn');
    assert.equal(u.pathname, '/wxcms3/remote-wx/api/cj-cloud/play/null/show');
    assert.equal(init.headers.Authorization, 'anonymousWebFixture');
    const code = u.searchParams.get('channelCode').slice(-3);
    return Response.json(transform(structuredClone(u.searchParams.get('date') === '2026-10-22' ? fixtures[code] : { code: 200, data: [] })));
  } };
}

test('HBTV uses anonymous official web configuration and retains six real schedules including cross-midnight times', async () => {
  const options = network();
  const catalogue = { ...PROVINCIAL_CATALOGUE, channels: PROVINCIAL_CATALOGUE.channels.filter(c => c.native?.type === 'hbtv') };
  assert.equal(catalogue.channels.length, 8);
  const source = new Provincial({ catalogue, dates: ['2026-10-21', '2026-10-22', '2026-10-23'], today: '2026-10-22', ...options });
  const channels = await source.channels();
  assert.equal(channels.length, 6);
  assert.equal(source.report.unavailable.length, 2);
  assert(source.report.unavailable.every(c => c.status === 'no-published-schedule'));
  assert.equal(source.warnings.length, 0);
  assert.equal(options.requests.filter(u => u.includes('res.cjyun.org')).length, 3);
  const dataset = await collect({ channels: async () => channels, programmes: (c, d) => source.programmes(c, d) },
    { today: '2026-10-22', pastDays: 0, futureDays: 0, minChannels: 6, delayMs: 0 });
  assert.equal(dataset.programmes.length, 197);
  const satellite = await source.programmes(channels.find(c => c.id === 'hubeiweishi'), '2026-10-22');
  assert(satellite.some(p => p.name.includes('新闻联播') && p.st === Date.parse('2026-10-22T19:00:04+08:00') / 1000));
  assert(dataset.programmes.some(p => p.stop > Date.parse('2026-10-23T00:00:00+08:00') / 1000));
  const directory = await mkdtemp(join(tmpdir(), 'epg-hbtv-'));
  try {
    await writeArtifacts(directory, dataset);
    const xml = new XMLParser().parse(await readFile(join(directory, '2026-10-22', 'epg.xml'), 'utf8'));
    assert.equal(xml.tv.channel.length, 6);
    assert.equal(xml.tv.programme.length, 197);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('HBTV rejects schema drift, wrong channel/date and invalid times without reassigning programmes', async () => {
  const id = '99180001000000050000000000000338';
  for (const mutate of [b => { b.code = 403; }, b => { b.data = null; },
    b => { b.data[0].channelcode = 'other'; }, b => { b.data[0].starttime = '2026-10-21 00:00:00'; },
    b => { b.data[0].endtime = '2026-10-22 25:00:00'; }]) {
    await assert.rejects(hbtvProgrammes(id, '2026-10-22', network(b => { mutate(b); return b; })));
  }
  assert.deepEqual(await hbtvProgrammes(id, '2026-10-23', network()), []);
  await assert.rejects(hbtvProgrammes('338', '2026-10-22', network()), /channel code/);
});

test('HBTV website changes and individual failures remain visible while healthy official channels generate', async () => {
  const options = network(b => { if (b.data[0]?.channelcode.endsWith('338')) b.code = 503; return b; });
  const catalogue = { ...PROVINCIAL_CATALOGUE, channels: PROVINCIAL_CATALOGUE.channels.filter(c => c.native?.type === 'hbtv') };
  const source = new Provincial({ catalogue, dates: ['2026-10-22'], today: '2026-10-22', allowPartial: true, ...options });
  const channels = await source.channels();
  assert.equal(channels.length, 5);
  assert(source.failures.some(f => f.channel === 'hubeilocal179'));
  await assert.rejects(hbtvProgrammes('99180001000000050000000000000338', '2026-10-22', {
    fetchImpl: async () => new Response('<html>website changed</html>'),
  }), /manifest missing/);
});

test('known empty official channels are polled and automatically imported when a schedule appears', async () => {
  const catalogue = { ...PROVINCIAL_CATALOGUE, channels: PROVINCIAL_CATALOGUE.channels.filter(c => c.id === 'hubeilocal181') };
  const options = network(body => {
    if (!body.data.length) body.data = [{ ...fixtures['338'].data[0], channelcode: catalogue.channels[0].native.channelId }];
    return body;
  });
  const source = new Provincial({ catalogue, dates: ['2026-10-22'], today: '2026-10-22', ...options });
  const channels = await source.channels();
  assert.equal(channels.length, 1);
  assert.equal(channels[0].id, 'hubeilocal181');
  assert.equal(source.report.importedCount, 1);
});
