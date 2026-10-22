import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { XMLParser } from 'fast-xml-parser';
import { Provincial, PROVINCIAL_CATALOGUE } from '../src/provincial.js';
import { beijingTime, officialRequest, parseJsonp, cztvProgrammes, jstvProgrammes, kankanewsProgrammes, gdtvProgrammes, gxtvProgrammes, hntvProgrammes, hnntvProgrammes, iqiluProgrammes, fjtvProgrammes, snrtvProgrammes, yntvProgrammes, qhbtvProgrammes, setvProgrammes } from '../src/official.js';
import { EpgSources } from '../src/cctv.js';
import { collect, writeArtifacts, normalize, deduplicate } from '../src/epg.js';
import { publishDirectory } from '../src/releases.js';

const fixtures = Object.fromEntries(await Promise.all([
  ['cztv', 'cztv-112.json'], ['sxtv', 'sxtv-3.jsonp'], ['hebtv', 'hebtv-114.json'], ['jstv', 'jstv-668.json'],
  ['gdtv', 'gdtv-44.json'], ['xjtvs', 'xjtvs-3.json'], ['kankanews', 'kankanews-2.json'], ['gxtv', 'gxtv-variety.json'],
].map(async ([key, file]) => [key, await readFile(new URL('./fixtures/provincial/' + file, import.meta.url), 'utf8')])));

function mockOfficialNetwork() {
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    const u = new URL(url);
    requests.push({ url, init });
    if (u.hostname === 'p.cztv.com') return new Response(url.endsWith('/20261022') ? fixtures.cztv
      : JSON.stringify({ content: { list: [{ station_id: 0, station_date: '20261022', list: [] }] } }));
    if (u.hostname === 'apphhplushttps.sxrtv.com') return new Response(fixtures.sxtv);
    if (u.hostname === 'api.cmc.hebrts.cn') {
      assert.equal(init.method, 'POST');
      const { day } = JSON.parse(init.body);
      return new Response(day === '2026-10-22' ? fixtures.hebtv : JSON.stringify({ success: true, data: {} }));
    }
    if (u.hostname === 'live.jstv.com') {
      if (u.pathname === '/') return new Response('<script src="assets/js/app.fake.js"></script>');
      if (u.pathname.endsWith('/app.fake.js')) return new Response('component:()=>t.e(311);t.u=function(e){return"assets/js/"+e+".hash.js"}');
      return new Response('apiAuth:"https://api-auth-lizhi.jstv.com",appId:"public-app",appSecretId:"public-key",appSecret:"public-salt"');
    }
    if (u.hostname === 'api-auth-lizhi.jstv.com') {
      assert.equal(init.method, 'POST');
      assert.equal(JSON.parse(init.body).platform, 41);
      assert.match(u.searchParams.get('Sign'), /^[a-f0-9]{32}$/);
      return Response.json({ data: { accessToken: 'anonymous-fixture-token' } });
    }
    if (u.hostname === 'live-lizhi.jstv.com') {
      assert.equal(init.headers.Authorization, 'Bearer anonymous-fixture-token');
      return new Response(fixtures.jstv);
    }
    if (u.hostname === 'slstapi.xjtvs.com.cn') {
      const date = u.searchParams.get('date').slice(0, 10);
      return new Response(date === '2026-10-22' ? fixtures.xjtvs : JSON.stringify({ success: true, data: [] }));
    }
    if (u.hostname === 'live.kankanews.com') {
      return new Response(u.pathname.includes('/js/') ? 'r+="28c8edde3d61a0411511d3b1866f0636"'
        : '<script src="/_knews_nuxt/js/app.v2.45.0.js"></script>');
    }
    if (u.hostname === 'kapi.kankanews.com') {
      assert.equal(init.headers.platform, 'pc');
      assert.match(init.headers.sign, /^[a-f0-9]{32}$/);
      return new Response(u.searchParams.get('date') === '2026-10-22' ? fixtures.kankanews
        : JSON.stringify({ code: '1000', result: { list: [] } }));
    }
    if (u.hostname === 'api2019.gxtv.cn') {
      const params = new URLSearchParams(init.body);
      assert.equal(init.method, 'POST');
      assert.equal(params.get('channelName'), '综艺旅游频道');
      return new Response(params.get('dateStr') === '2026-10-22' ? fixtures.gxtv : JSON.stringify({ successful: true, data: [] }));
    }
    throw new Error('Non-broadcaster or unexpected data request: ' + url);
  };
  return { fetchImpl, requests, cache: new Map(), delay: async () => {},
    gdtvRequest: async url => {
      assert.equal(new URL(url).hostname, 'gdtv-api.gdtv.cn');
      return JSON.parse(fixtures.gdtv);
    },
  };
}

test('province catalogue merges simulcasts, keeps stable IDs and excludes municipal broadcasters', () => {
  const { channels } = PROVINCIAL_CATALOGUE;
  assert.equal(channels.length, 227);
  assert.equal(channels.filter(c => c.catalogueOrigin === 'official-supplement').length, 2);
  assert.equal(new Set(channels.map(c => c.id)).size, channels.length);
  assert(channels.every(c => /^[a-z][a-z0-9]*$/.test(c.id) && c.urls.length && c.aliases.includes(c.name)));
  assert(!channels.some(c => /^(深圳|厦门|吉林市|长沙|成都|杭州)/.test(c.name)));
  assert(channels.find(c => c.id === 'jiangsuweishi').aliases.includes('江苏卫视4K'));
});

test('official timestamps and JSONP are parsed without executing remote code', () => {
  assert.equal(beijingTime('2026-10-22 00:00:12'), Date.parse('2026-10-22T00:00:12+08:00') / 1000);
  for (const value of ['2026-02-30 00:00:00', '2026-10-22 25:00', 'bad']) assert.throws(() => beijingTime(value));
  assert.deepEqual(parseJsonp('liveList.jsonpCallback([1,2]);', 'liveList.jsonpCallback'), [1, 2]);
  assert.throws(() => parseJsonp('runDangerousCode([1]);', 'liveList.jsonpCallback'));
  assert.throws(() => parseJsonp('liveList.jsonpCallback((()=>[1])());', 'liveList.jsonpCallback'));
});

test('eight real official guides join every release variant with sources and missing-channel evidence', async () => {
  const names = ['浙江之江纪录', '山西经济与科技', '河北经济生活', '江苏新闻', '广东珠江', '新疆2套', '上海新闻综合', '广西综艺旅游', '安徽卫视', '安徽公共'];
  const catalogue = { ...PROVINCIAL_CATALOGUE, channels: PROVINCIAL_CATALOGUE.channels.filter(c => names.includes(c.name)) };
  const network = mockOfficialNetwork();
  const source = new Provincial({ dates: ['2026-10-21', '2026-10-22', '2026-10-23', '2026-10-24'],
    today: '2026-10-22', catalogue, ...network });
  const existing = [{ id: 'anhuiweishi', aliases: ['安徽台'] }];
  const channels = await source.channels(existing);
  assert.equal(channels.length, 8);
  assert(existing[0].aliases.includes('安徽卫视'));
  assert.equal(source.report.policy, 'official-broadcaster-websites-only');
  assert.equal(source.report.existingCount, 1);
  assert.equal(source.report.unavailable[0].name, '安徽公共');
  assert.equal(source.report.unavailable[0].status, 'official-adapter-pending');
  assert(source.report.omittedProgrammes.some(p => p.reason === 'official-end-time-unpublished'));
  assert.equal(network.requests.filter(r => new URL(r.url).hostname === 'api-auth-lizhi.jstv.com').length, 1);
  assert.equal(network.requests.filter(r => new URL(r.url).hostname === 'apphhplushttps.sxrtv.com').length, 1);
  const dataset = await collect({ channels: async () => channels, programmes: (c, date) => source.programmes(c, date),
    provincialCoverage: source.report,
  }, { today: '2026-10-22', pastDays: 0, futureDays: 2, minChannels: 8, minTodayCoverage: 1, delayMs: 0 });
  assert(dataset.programmes.length > 100);
  assert(dataset.manifest.discardedProgrammes.some(row => row.reason === 'zero-duration'));
  assert(dataset.programmes.every(p => p.stop > p.start));
  const directory = await mkdtemp(join(tmpdir(), 'autoepg-official-'));
  try {
    const index = await writeArtifacts(directory, dataset);
    const folder = join(directory, '2026-10-22');
    const parser = new XMLParser({ ignoreAttributes: false, isArray: n => ['channel', 'programme'].includes(n) });
    for (const file of ['epg.xml', 'epg2.xml', 'epg3.xml', 'epg-provincial.xml', 'epg2-provincial.xml', 'epg3-provincial.xml']) {
      assert(index.releases[0].assets.includes(file));
      const tv = parser.parse(await readFile(join(folder, file), 'utf8')).tv;
      assert.equal(tv.channel.length, 8);
      assert(tv.programme.length > 100);
    }
    const report = JSON.parse(await readFile(join(folder, 'provincial-coverage.json'), 'utf8'));
    assert.equal(report.unavailable.length, 1);
    assert.equal(report.sources.length, 8);
    await assert.rejects(publishDirectory({ call: async () => { throw new Error('reached publisher'); } },
      directory, 'commit', { today: '2026-10-22' }), /reached publisher/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('empty future official schedules stay empty; malformed, stale and failed responses stop publication', async () => {
  const options = mockOfficialNetwork();
  assert.deepEqual(await cztvProgrammes('112', '2026-10-25', options), []);
  assert.deepEqual(await jstvProgrammes('668', '2026-10-25', options), []);
  assert.deepEqual(await kankanewsProgrammes('2', '2026-10-25', options), []);
  await assert.rejects(cztvProgrammes('112', '2026-10-23', {
    fetchImpl: async () => new Response(fixtures.cztv),
  }), /date mismatch/);
  let calls = 0;
  await assert.rejects(officialRequest('https://p.cztv.com/', {
    fetchImpl: async () => { calls++; return new Response('', { status: 503 }); }, delay: async () => {},
  }), /HTTP 503/);
  assert.equal(calls, 3);
  const entry = PROVINCIAL_CATALOGUE.channels.find(c => c.name === '浙江之江纪录');
  await assert.rejects(new Provincial({ ...options, today: '2026-10-25', dates: ['2026-10-25'],
    catalogue: { ...PROVINCIAL_CATALOGUE, channels: [entry] },
  }).channels(), /coverage is below 90%/);
});

test('isolated real GDTV multi-day duration is quarantined with original times; widespread damage fails', async () => {
  const rows = JSON.parse(await readFile(new URL('./fixtures/provincial/gdtv-invalid-duration.json', import.meta.url)));
  const omittedProgrammes = [];
  const request = list => async () => ({ resultList: [{ dateAt: '2026-10-23', tvMenus: list.map(r =>
    ({ pk: r.programId, name: r.name, beginAt: r.st * 1000, endAt: r.et * 1000 })) }] });
  const options = { channel: { id: 'guangdonglocal17' }, omittedProgrammes, gdtvRequest: request(rows) };
  const kept = await gdtvProgrammes('44', '2026-10-23', options);
  assert.equal(kept.length, rows.length - 1);
  const invalid = rows.find(r => r.programId === 294678155);
  assert.equal(omittedProgrammes[0].start, invalid.st);
  assert.equal(omittedProgrammes[0].stop, invalid.et);
  assert.equal(omittedProgrammes[0].reason, 'official-duration-exceeds-day');
  assert.deepEqual(kept, rows.filter(r => r !== invalid));
  await assert.rejects(gdtvProgrammes('44', '2026-10-23', { gdtvRequest: request([invalid, ...rows]) }), /excessive invalid/);
});

test('GXTV explicit no-data response is empty, while unsuccessful unknown responses fail', async () => {
  const options = { channel: { native: { channelName: '综艺旅游频道' } },
    fetchImpl: async () => Response.json({ code: 0, message: '暂无数据', successful: false, data: null }) };
  assert.deepEqual(await gxtvProgrammes('f3335975f9fe11e88bcfe41f13b60c62', '2026-10-18', options), []);
  await assert.rejects(gxtvProgrammes('f3335975f9fe11e88bcfe41f13b60c62', '2026-10-18', {
    ...options, fetchImpl: async () => Response.json({ code: -1, message: 'error', data: null }),
  }), /Invalid GXTV/);
});

test('Henan and Hainan official snapshots preserve actual intervals and cache multi-day responses', async () => {
  const hn = JSON.parse(await readFile(new URL('./fixtures/provincial/hntv-146.json', import.meta.url)));
  const hnn = JSON.parse(await readFile(new URL('./fixtures/provincial/hnntv-3.json', import.meta.url)));
  let calls = 0;
  const options = { cache: new Map(), fetchImpl: async (url, init) => {
    const u = new URL(url);
    if (u.hostname === 'static.hntv.tv') return new Response(u.pathname.endsWith('.js')
      ? 'getChannelList(){const t=this,e="6ca114a836ac7d73"' : '<script src="js/pages/kds/kds.fake.js"></script>');
    if (u.hostname === 'pubmod.hntv.tv') {
      assert.match(init.headers.sign, /^[a-f0-9]{64}$/);
      return Response.json(hn);
    }
    assert.equal(u.hostname, 'www.hnntv.cn'); calls++; return Response.json(hnn);
  } };
  const a = await hntvProgrammes('146', '2026-10-22', options);
  assert.equal(a.length, hn.programs.length);
  assert.equal(a[0].st, Number(hn.programs[0].beginTime));
  const b = await hnntvProgrammes('3', '2026-10-22', options);
  assert.equal(b.length, hnn.resultSet[0].schedules.filter(r => r.status > 0).length);
  assert.deepEqual(await hnntvProgrammes('3', '2026-10-23', options), []);
  assert.equal(calls, 1);
});

test('existing satellite keeps ID and group and uses broadcaster-first whole-date selection', async () => {
  const entry = PROVINCIAL_CATALOGUE.channels.find(c => c.id === 'zhejiangweishi');
  const today = '2026-10-22', tomorrow = '2026-10-23';
  const official = [{ name: 'Official', st: beijingTime(today + ' 07:00'), et: beijingTime(today + ' 07:30') }];
  const existing = { id: entry.id, pid: '123', name: entry.name, aliases: [], dates: [today, tomorrow], groupId: 'weishi', group: '卫视频道', order: 1, logo: '' };
  let yspCalls = 0;
  const source = new EpgSources({ dates: [today, tomorrow],
    yangshipin: { channels: async () => [existing], programmes: async () => { yspCalls++; return []; } },
    provincial: new Provincial({ dates: [today, tomorrow], today, catalogue: { ...PROVINCIAL_CATALOGUE, channels: [entry] },
      adapters: { cztv: { name: '浙江官网', source: 'https://p.cztv.com/', programmes: async (id, date) => date === today ? official : [] } },
    }),
  });
  const channel = (await source.channels()).find(c => c.id === entry.id);
  assert.equal(channel.groupId, 'weishi');
  assert.equal(channel.pid, '123');
  assert.deepEqual(await source.programmes(channel, today), official);
  assert.equal(yspCalls, 0);
  assert.deepEqual(await source.programmes(channel, tomorrow), []);
  assert.equal(yspCalls, 1);
  assert.equal(source.provincialCoverage.channels[0].selection, 'broadcaster-first-per-date');
});

test('conflicting provincial snapshots trigger a fresh official request and close browser resources', async () => {
  const entry = PROVINCIAL_CATALOGUE.channels.find(c => c.name === '浙江之江纪录');
  const date = '2026-10-22', st = beijingTime(date + ' 08:00'), et = st + 1800;
  let calls = 0, closes = 0;
  const provincial = new Provincial({ dates: [date], today: date, catalogue: { ...PROVINCIAL_CATALOGUE, channels: [entry] },
    adapters: { cztv: { name: '浙江官网', source: 'https://p.cztv.com/', programmes: async (id, date, options) => {
      options.resources.push({ close: async () => { closes++; } });
      return ++calls === 1 ? [{ name: 'Old edit', st, et }, { name: 'Current edit', st, et }] : [{ name: 'Current edit', st, et }];
    } } },
  });
  const data = await collect({ channels: () => provincial.channels(), programmes: (c, d) => provincial.programmes(c, d),
    refreshProgrammes: (c, d) => provincial.refreshProgrammes(c, d),
  }, { today: date, pastDays: 0, futureDays: 0, minChannels: 1, delayMs: 0 });
  assert.equal(calls, 2);
  assert.equal(closes, 2);
  assert.equal(data.programmes[0].title, 'Current edit');
  assert.equal(data.manifest.requestCount, 2);
  assert.equal(provincial.report.scheduleRefreshes.length, 1);
});

test('Shandong official seconds are retained, unpublished null is empty, and schema failures remain fatal', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/provincial/iqilu-25.json', import.meta.url)));
  const rows = await iqiluProgrammes('25', '2026-10-22', { fetchImpl: async url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'sdxw.iqilu.com');
    assert.equal(u.searchParams.get('channelID'), '25');
    assert.equal(u.searchParams.get('date'), '2026-10-22');
    return Response.json(snapshot);
  } });
  assert.equal(rows.length, snapshot.data.infos.length);
  assert.equal(rows[0].et, snapshot.data.infos[0].endtime);
  assert(rows.some(r => r.st % 60 !== 0));
  assert.deepEqual(await iqiluProgrammes('25', '2026-10-23', { fetchImpl: async () => Response.json({ code: 1, data: { infos: null } }) }), []);
  for (const body of [{ code: 1, data: {} }, { code: 0, data: { infos: [] } }]) {
    await assert.rejects(iqiluProgrammes('25', '2026-10-23', { fetchImpl: async () => Response.json(body) }), /Invalid IQILU/);
  }
});

test('Shandong blank zero-airtime table cells are audited without allowing titled or positive intervals to disappear', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/provincial/iqilu-empty-placeholder.json', import.meta.url)));
  const omittedProgrammes = [];
  const rows = await iqiluProgrammes('30', '2026-10-22', { omittedProgrammes, fetchImpl: async () => Response.json(snapshot) });
  assert.equal(rows.length, snapshot.data.infos.length - 1);
  assert.equal(omittedProgrammes.length, 1);
  assert.equal(omittedProgrammes[0].reason, 'official-empty-placeholder');
  const placeholder = snapshot.data.infos.at(-1);
  placeholder.endtime++;
  const preserved = await iqiluProgrammes('30', '2026-10-22', { fetchImpl: async () => Response.json(snapshot) });
  assert.equal(preserved.length, snapshot.data.infos.length);
  await assert.rejects(collect({ channels: async () => [{ id: 'test', pid: 'test', name: 'test', dates: ['2026-10-22'] }],
    programmes: async () => preserved }, { today: '2026-10-22', pastDays: 0, futureDays: 0, minChannels: 1, delayMs: 0 }), /Invalid programme/);
});

test('Fujian retrieves public company configuration once and requires explicit matching programme dates', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/provincial/fjtv-zhpd.json', import.meta.url)));
  let configs = 0;
  const options = { cache: new Map(), fetchImpl: async url => {
    const u = new URL(url);
    assert.equal(u.hostname, 'mapi-plus.fjtv.net');
    if (u.pathname.endsWith('/business')) {
      configs++;
      assert.equal(u.searchParams.get('company_id'), '468');
      assert.match(u.searchParams.get('signature'), /^[a-f0-9]{32}$/);
      return Response.json({ error_code: 200, result: { app_secret: 'a'.repeat(32), tenant_id: '0', company_id: '468' } });
    }
    assert.equal(u.searchParams.get('app_secret'), 'a'.repeat(32));
    return Response.json(u.searchParams.get('date') === '2026-10-22' ? snapshot : { error_code: 200, result: [] });
  } };
  const rows = await fjtvProgrammes('665248990102917120', '2026-10-22', options);
  assert.equal(rows.length, snapshot.result.length);
  assert.equal(rows[0].st, snapshot.result[0].star_time_timestamp);
  assert.deepEqual(await fjtvProgrammes('665248990102917120', '2026-10-25', options), []);
  assert.equal(configs, 1);
  await assert.rejects(fjtvProgrammes('665248990102917120', '2026-10-23', {
    ...options, fetchImpl: async () => Response.json(snapshot),
  }), /date mismatch/);
});

test('Shaanxi clock-only official guide is confined to the server day and parsed without executing code', async () => {
  const script = await readFile(new URL('./fixtures/provincial/snrtv-1.txt', import.meta.url), 'utf8');
  const options = { cache: new Map(), today: '2026-10-22', fetchImpl: async () => new Response(script, {
    headers: { Date: 'Thu, 22 Oct 2026 02:27:11 GMT' },
  }) };
  const rows = await snrtvProgrammes('1', '2026-10-22', options);
  assert(rows.length > 20);
  assert.equal(rows[0].st, beijingTime('2026-10-22 00:00'));
  assert.deepEqual(await snrtvProgrammes('1', '2026-10-23', options), []);
  assert.deepEqual(await snrtvProgrammes('1', '2026-10-21', { ...options, today: '2026-10-21' }), []);
  await assert.rejects(snrtvProgrammes('1', '2026-10-22', { fetchImpl: async () => new Response(script) }), /server date missing/);
  await assert.rejects(snrtvProgrammes('1', '2026-10-22', { fetchImpl: async () => new Response('var snr_Playlist = runCode();', {
    headers: { Date: 'Thu, 22 Oct 2026 02:27:11 GMT' },
  }) }), /wrapper/);
});

test('Shaanxi exact shared intervals retain every title without guessing boundaries; unequal intervals remain conflicts', async () => {
  const script = await readFile(new URL('./fixtures/provincial/snrtv-star.txt', import.meta.url), 'utf8');
  const combinedProgrammes = [];
  const headers = { Date: 'Thu, 22 Oct 2026 02:27:11 GMT' };
  const rows = await snrtvProgrammes('star', '2026-10-22', { combinedProgrammes, fetchImpl: async () => new Response(script, { headers }) });
  const start = beijingTime('2026-10-22 07:00'), stop = beijingTime('2026-10-22 07:29');
  const block = rows.filter(r => r.st === start);
  assert.equal(block.length, 1);
  assert.equal(block[0].et, stop);
  assert.equal(block[0].name, '中华人民共和国国歌 / 陕西新闻联播（重）');
  assert.deepEqual(combinedProgrammes[0].titles, ['中华人民共和国国歌', '陕西新闻联播（重）']);
  const altered = script.replace('"start":"07:00","end":"07:29","name":"\\u9655', '"start":"07:00","end":"07:30","name":"\\u9655');
  const bad = await snrtvProgrammes('star', '2026-10-22', { fetchImpl: async () => new Response(altered, { headers }) });
  assert.throws(() => deduplicate(normalize(bad, { id: 'test', pid: 'test' }, '2026-10-22')), /Conflicting/);
});

test('Yunnan browser guide retains explicit seconds and durations, strips display clocks, and rejects wrong channels', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/provincial/yntv-dushi.json', import.meta.url)));
  let calls = 0;
  const options = { cache: new Map(), yntvRequest: async url => {
    calls++;
    const u = new URL(url);
    assert.equal(u.hostname, 'yntv-api.yntv.cn');
    assert.equal(u.searchParams.get('name'), 'yunnandushi');
    assert.equal(u.searchParams.get('da'), '2026-10-22');
    return snapshot;
  } };
  const rows = await yntvProgrammes('yunnandushi', '2026-10-22', options);
  assert.equal(rows.length, snapshot.lists.length);
  assert.equal(rows[0].st, snapshot.lists[0].start);
  assert.equal(rows[0].st % 60, 1);
  assert.equal(rows[0].name, '精彩节目');
  assert.equal(rows.at(-1).et, snapshot.lists.at(-1).start + snapshot.lists.at(-1).duration);
  assert.equal(snapshot.lists.at(-1).endtime, null);
  await yntvProgrammes('yunnandushi', '2026-10-22', options);
  assert.equal(calls, 1);
  assert.deepEqual(await yntvProgrammes('yunnandushi', '2026-10-23', {
    yntvRequest: async () => ({ ...snapshot, lists: [snapshot.lists[0]] }),
  }), []);
  await assert.rejects(yntvProgrammes('yunnandushi', '2026-10-22', {
    yntvRequest: async () => ({ ...snapshot, streamer: 'https://other.example/' }),
  }), /Invalid YNTV/);
});

test('Qinghai and Fujian public company configuration caches remain isolated', async () => {
  const qh = JSON.parse(await readFile(new URL('./fixtures/provincial/qhbtv-jingji.json', import.meta.url)));
  const fj = JSON.parse(await readFile(new URL('./fixtures/provincial/fjtv-zhpd.json', import.meta.url)));
  const calls = [];
  const options = { cache: new Map(), fetchImpl: async url => {
    const u = new URL(url), isQinghai = u.hostname === 'mapi.qhbtv.com.cn';
    const company = isQinghai ? '1075' : '468', secret = (isQinghai ? 'b' : 'a').repeat(32);
    if (u.pathname.endsWith('/business')) {
      assert.equal(u.searchParams.get('company_id'), company);
      calls.push(company);
      return Response.json({ error_code: 200, result: { app_secret: secret, company_id: company, tenant_id: '0' } });
    }
    assert.equal(u.searchParams.get('app_secret'), secret);
    assert.equal(u.searchParams.get('company_id'), company);
    return Response.json(isQinghai ? qh : fj);
  } };
  const [a, b] = await Promise.all([qhbtvProgrammes('786227316454875136', '2026-10-22', options),
    fjtvProgrammes('665248990102917120', '2026-10-22', options)]);
  assert.equal(a.length, qh.result.length);
  assert.equal(b.length, fj.result.length);
  assert.deepEqual(calls.sort(), ['1075', '468']);
});

test('Shanghai Education uses the next published start and audits the final unknown end', async () => {
  const snapshot = JSON.parse(await readFile(new URL('./fixtures/provincial/setv.json', import.meta.url)));
  const omittedProgrammes = [];
  const options = { cache: new Map(), omittedProgrammes, fetchImpl: async () => Response.json(snapshot) };
  const rows = await setvProgrammes('setv', '2026-10-20', options);
  assert(rows.length > 30);
  const ordered = [...snapshot.data].sort((a, b) => a.time - b.time);
  assert.equal(rows[0].st, ordered[0].time);
  assert.equal(rows[0].et, ordered[1].time);
  const today = await setvProgrammes('setv', '2026-10-22', options);
  assert(today.length > 30);
  assert.equal(omittedProgrammes.length, 1);
  assert.equal(omittedProgrammes[0].start, ordered.at(-1).time);
  assert.equal(omittedProgrammes[0].reason, 'official-end-time-unpublished');
  assert.deepEqual(await setvProgrammes('setv', '2026-10-23', options), []);
  await assert.rejects(setvProgrammes('setv', '2026-10-22', { fetchImpl: async () => Response.json({ result: 'success', data: [{ time: 'bad' }] }) }), /timestamp/);
  const conflicting = { result: 'success', data: [snapshot.data[0], { ...snapshot.data[0], title: 'Other title' }, snapshot.data[1]] };
  const bad = await setvProgrammes('setv', '2026-10-20', { fetchImpl: async () => Response.json(conflicting) });
  assert.throws(() => deduplicate(normalize(bad, { id: 'setv', pid: 'setv' }, '2026-10-20')), /Conflicting/);
});
