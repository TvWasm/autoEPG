import { setTimeout as sleep } from 'node:timers/promises';
import { createHash, randomUUID } from 'node:crypto';
import { errorMessage } from './diagnostics.js';

const WEB_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';

function connectionReason(error) {
  const causes = [error.cause, ...(error.cause?.errors ?? [])].filter(Boolean);
  const details = [...new Set(causes.map(e => e.code ?? e.message).filter(Boolean))];
  return details.length ? `${error.message} (${details.join(', ')})` : error.message;
}

function cached(key, options, work) {
  if (!options.cache) return work();
  if (!options.cache.has(key)) options.cache.set(key, work());
  return options.cache.get(key);
}

export async function officialRequest(url, { fetchImpl = fetch, delay = sleep, timeoutMs = 20_000, method, headers, body } = {}) {
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url, { method,
        headers: { 'User-Agent': WEB_USER_AGENT, Accept: 'application/json, text/plain, */*', ...headers },
        body, signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) {
        // Only record transport metadata, never an HTML challenge or echoed credentials.
        const server = response.headers?.get('server');
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}${server ? ` (server: ${server})` : ''}`);
      }
      return await response.text();
    } catch (error) {
      if (attempt === 2) throw new Error(`${errorMessage(url)}: ${errorMessage(connectionReason(error))}`, { cause: error });
      await delay(1000 * 2 ** attempt);
    }
  }
}

export function beijingTime(value) {
  const match = String(value).match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}(?::\d{2})?)$/);
  if (!match) throw new Error(`Invalid official schedule time: ${value}`);
  const iso = `${match[1]}T${match[2].length === 5 ? match[2] + ':00' : match[2]}+08:00`;
  const seconds = Date.parse(iso) / 1000;
  if (!Number.isSafeInteger(seconds) || new Date((seconds + 28800) * 1000).toISOString().slice(0, 19) !== iso.slice(0, 19)) {
    throw new Error(`Invalid official schedule time: ${value}`);
  }
  return seconds;
}

export function parseJsonp(value, callback) {
  const prefix = callback + '(';
  const text = value.trim().replace(/;$/, '');
  if (!text.startsWith(prefix) || !text.endsWith(')')) throw new Error('Unexpected official JSONP wrapper');
  return JSON.parse(text.slice(prefix.length, -1));
}

export async function sxtvProgrammes(channelId, date, options = {}) {
  if (!/^SXTV[1-6]$/.test(channelId)) throw new Error('Invalid SXTV channel ID');
  const url = `https://apphhplushttps.sxrtv.com/epg/${channelId}.json`;
  const rows = await cached(url, options, async () => parseJsonp(await officialRequest(url, options), 'liveList.jsonpCallback'));
  if (!Array.isArray(rows)) throw new Error('Invalid SXTV programme list');
  return rows.filter(row => row.start_time?.startsWith(date + ' ')).map(row => ({
    name: row.name, st: beijingTime(row.start_time), et: beijingTime(row.end_time),
  }));
}

export async function hebtvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid HEBTV channel ID');
  const tenantId = '0d91d6cfb98f5b206ac1e752757fc5a9';
  const url = 'https://api.cmc.hebrts.cn/spidercrms/api/live/liveShowSet/findNoPage';
  const body = JSON.parse(await officialRequest(url, { ...options, method: 'POST',
    headers: { 'Content-Type': 'application/json', tenantId },
    body: JSON.stringify({ sourceId: channelId, tenantId, day: date, dayEnd: date }),
  }));
  if (body.success !== true || !body.data || typeof body.data !== 'object') throw new Error('Invalid HEBTV schedule response');
  const rows = body.data[date] ?? [];
  if (!Array.isArray(rows)) throw new Error('Invalid HEBTV programme list');
  return rows.map(row => ({ name: row.name, st: beijingTime(row.startDateTime), et: beijingTime(row.endDateTime), programId: row.id }));
}

export async function hntvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid HNTV channel ID');
  const salt = await cached('hntv:web-signature', options, async () => {
    const html = await officialRequest('https://static.hntv.tv/kds/', options);
    const script = html.match(/src=["']([^"']*js\/pages\/kds\/kds\.[^"']+\.js)["']/)?.[1];
    if (!script) throw new Error('HNTV programme script missing');
    const content = await officialRequest(new URL(script, 'https://static.hntv.tv/kds/').href, options);
    const value = content.match(/getChannelList\(\)\{const \w+=this,\w+="([a-f0-9]{16})"/)?.[1];
    if (!value) throw new Error('HNTV public web signature configuration missing');
    return value;
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const sign = createHash('sha256').update(salt + timestamp).digest('hex');
  const midnight = beijingTime(date + ' 00:00:00');
  const body = JSON.parse(await officialRequest(`https://pubmod.hntv.tv/program/getAuth/vod/originStream/program/${channelId}/${midnight}`, {
    ...options, headers: { sign, timestamp, Referer: 'https://static.hntv.tv/kds/' },
  }));
  if (String(body.cid) !== channelId || !Array.isArray(body.programs)) throw new Error('Invalid HNTV schedule response');
  return body.programs.map(row => ({ name: row.title, st: Number(row.beginTime), et: Number(row.endTime), programId: row.signa }));
}

export async function hnntvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid HNNTV channel ID');
  const url = `https://www.hnntv.cn/api/schedule/byDay?channelId=${channelId}`;
  const body = await cached(url, options, async () => JSON.parse(await officialRequest(url, options)));
  if (body.businessCode !== '00000' || !Array.isArray(body.resultSet)) throw new Error('Invalid HNNTV schedule response');
  const rows = body.resultSet.find(day => day.date === date)?.schedules ?? [];
  if (!Array.isArray(rows)) throw new Error('Invalid HNNTV programme list');
  return rows.filter(row => row.status > 0).map(row => {
    if (row.date !== date) throw new Error('HNNTV response date mismatch');
    return { name: row.showName, st: beijingTime(row.startDatetime), et: beijingTime(row.endDatetime), programId: row.id };
  });
}

export async function iqiluProgrammes(channelId, date, options = {}) {
  if (!/^(?:2[4-9]|3[0-3])$/.test(channelId)) throw new Error('Invalid IQILU channel ID');
  // The official live player uses the /qilu path for all ten channels.
  const url = new URL('https://sdxw.iqilu.com/v1/app/play/program/qilu');
  url.search = new URLSearchParams({ channelID: channelId, date });
  const body = JSON.parse(await officialRequest(url.href, options));
  if (body.code !== 1 || !body.data || !Object.hasOwn(body.data, 'infos') ||
      (body.data.infos !== null && !Array.isArray(body.data.infos))) throw new Error('Invalid IQILU schedule response');
  const midnight = beijingTime(date + ' 00:00:00');
  return (body.data.infos ?? []).flatMap(row => {
    // Blank trailing table cells are exported by the site as midnight-to-midnight.
    // This exact empty placeholder carries neither a title nor an airtime interval.
    if (typeof row.name === 'string' && !row.name.trim() && row.start_time === '' && row.end_time === '' &&
        row.begintime === midnight && row.endtime === midnight) {
      options.omittedProgrammes?.push({ channel: options.channel?.id ?? channelId, date, title: row.name,
        start: row.begintime, stop: row.endtime, reason: 'official-empty-placeholder', source: url.href });
      return [];
    }
    return [{ name: row.name, st: row.begintime, et: row.endtime }];
  });
}

async function cloudliveProgrammes(channelId, date, options, root, companyId) {
  if (!/^\d{18}$/.test(channelId)) throw new Error('Invalid official cloudlive topic ID');
  const app = await cached(root + 'public-company-config/' + companyId, options, async () => {
    // Reproduce the public website's anonymous company signature. No login token.
    const timestamp = String(Math.round(Date.now() / 1000));
    const signature = createHash('md5').update(companyId + timestamp).digest('hex').split('');
    for (const [offset, digit] of [[0, 0], [7, 2], [14, 4], [21, 6], [30, 8]]) {
      signature.splice(offset, 2, timestamp[digit], timestamp[digit + 1]);
    }
    const params = { topic_id: channelId, preview: '', company_id: companyId, signature: signature.join(''), debug: '1' };
    const body = JSON.parse(await officialRequest(root + 'business?' + new URLSearchParams(params), options));
    const result = body.result;
    if (body.error_code !== 200 || !result || String(result.company_id) !== companyId ||
        !/^[a-f0-9]{32}$/.test(result.app_secret) || !/^\d+$/.test(String(result.tenant_id))) {
      throw new Error('Official cloudlive public company configuration missing');
    }
    return { app_secret: result.app_secret, tenant_id: String(result.tenant_id), company_id: companyId, lang_type: 'zh' };
  });
  const params = { topic_id: channelId, date, ...app };
  const body = JSON.parse(await officialRequest(root + 'program/list?' + new URLSearchParams(params), options));
  if (body.error_code !== 200 || !Array.isArray(body.result)) throw new Error('Invalid official cloudlive programme list');
  return body.result.map(row => {
    if (row.date !== date) throw new Error('Official cloudlive response date mismatch');
    return { name: row.title, st: row.star_time_timestamp, et: row.end_time_timestamp, programId: row.id };
  });
}

export function fjtvProgrammes(channelId, date, options = {}) {
  return cloudliveProgrammes(channelId, date, options, 'https://mapi-plus.fjtv.net/cloudlive-manage-mapi/api/topic/', '468');
}

export function qhbtvProgrammes(channelId, date, options = {}) {
  return cloudliveProgrammes(channelId, date, options, 'https://mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/', '1075');
}

export async function setvProgrammes(channelId, date, options = {}) {
  if (channelId !== 'setv') throw new Error('Invalid SETV channel ID');
  const url = 'https://api.setv.sh.cn/getLatestEPG';
  const body = await cached(url, options, async () => JSON.parse(await officialRequest(url, options)));
  if (body.result !== 'success' || !Array.isArray(body.data)) throw new Error('Invalid SETV programme list');
  const slots = new Map();
  for (const row of body.data) {
    if (!Number.isSafeInteger(row.time)) throw new Error('Invalid SETV programme timestamp');
    if (!slots.has(row.time)) slots.set(row.time, new Map());
    slots.get(row.time).set(row.title, row);
  }
  const starts = [...slots.keys()].sort((a, b) => a - b);
  const midnight = beijingTime(date + ' 00:00:00');
  return starts.flatMap((start, i) => {
    if (start < midnight || start >= midnight + 86400) return [];
    const stop = starts[i + 1];
    if (stop === undefined) {
      for (const row of slots.get(start).values()) options.omittedProgrammes?.push({ channel: options.channel?.id ?? channelId,
        date, title: row.title, start, reason: 'official-end-time-unpublished', source: url });
      return [];
    }
    return [...slots.get(start).values()].map(row => ({ name: row.title, st: start, et: stop }));
  });
}

export async function snrtvProgrammes(channelId, date, options = {}) {
  if (!/^(?:[12357]|11|star|nl)$/.test(channelId)) throw new Error('Invalid SNRTV channel ID');
  // This official endpoint has clock times only and serves the current guide.
  // Do not reinterpret it as an arbitrary requested historical/future date.
  if (options.today && date !== options.today) return [];
  const url = `https://qidian.sxtvs.com/api/v3/program/tv?channel=${channelId}`;
  const guide = await cached(url, options, async () => {
    const fetchImpl = options.fetchImpl ?? fetch;
    let serverTime;
    const script = await officialRequest(url, { ...options, fetchImpl: async (...args) => {
      const response = await fetchImpl(...args);
      serverTime = Date.parse(response.headers.get('Date'));
      return response;
    } });
    if (!Number.isFinite(serverTime)) throw new Error('SNRTV server date missing');
    const match = script.trim().match(/^var\s+snr_Playlist\s*=\s*(\[[\s\S]*\]);?$/);
    if (!match) throw new Error('Invalid SNRTV guide wrapper');
    const rows = JSON.parse(match[1]);
    if (!Array.isArray(rows)) throw new Error('Invalid SNRTV programme list');
    return { date: new Date(serverTime + 8 * 3600000).toISOString().slice(0, 10), rows };
  });
  if (date !== guide.date) return [];
  const parsed = guide.rows.map(row => {
    const st = beijingTime(date + ' ' + row.start);
    let et = beijingTime(date + ' ' + row.end);
    if (et < st) et += 86400;
    return { name: row.name, st, et };
  });
  // The site lists multiple labels for some exactly identical blocks (e.g.
  // anthem + news). Preserve every label in one block without inventing internal
  // boundaries. A different start/end remains a conflict for the core validator.
  const slots = new Map();
  for (const row of parsed) {
    const key = row.st + '/' + row.et;
    if (!slots.has(key)) slots.set(key, []);
    slots.get(key).push(row);
  }
  return [...slots.values()].flatMap(rows => {
    if (rows.some(row => typeof row.name !== 'string' || !row.name.trim())) return rows;
    const titles = [...new Set(rows.map(row => row.name.trim()))];
    if (titles.length > 1) options.combinedProgrammes?.push({ channel: options.channel?.id ?? channelId, date,
      start: rows[0].st, stop: rows[0].et, titles, reason: 'official-shared-interval-titles', source: url });
    return [{ ...rows[0], name: titles.join(' / ') }];
  });
}

async function yntvBrowser(options) {
  return cached('yntv:browser', options, async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    options.resources?.push(browser);
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const request = route.request();
      return ['image', 'font', 'media'].includes(request.resourceType()) || /\.m3u8|\.ts(?:\?|$)/.test(request.url())
        ? route.abort() : route.continue();
    });
    await page.goto('https://www.yntv.cn/live.html', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    return page;
  });
}

export async function yntvProgrammes(channelId, date, options = {}) {
  if (!/^yunnan(?:weishi|dushi|gonggong|guoji)$/.test(channelId)) throw new Error('Invalid YNTV channel ID');
  const url = 'https://yntv-api.yntv.cn/index/jmd/getJmd?' + new URLSearchParams({ name: channelId, da: date });
  const body = await cached(url, options, async () => {
    if (options.yntvRequest) return options.yntvRequest(url);
    try {
      const page = options.yntvPage ?? await yntvBrowser(options);
      return await page.evaluate(async url => {
        for (let attempt = 0; ; attempt++) {
          try {
            const response = await fetch(url, { signal: AbortSignal.timeout(20_000) });
            if (!response.ok) { await response.body?.cancel(); throw new Error(`YNTV HTTP ${response.status}`); }
            return await response.json();
          } catch (error) {
            if (attempt === 2) throw error;
            await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
          }
        }
      }, url);
    } catch {
      // A browser CORS/network error does not prove the public API is unreachable
      // from the runner's HTTP client. Keep the same endpoint and validation.
      return JSON.parse(await officialRequest(url, { ...options,
        headers: { Referer: 'https://www.yntv.cn/live.html', Origin: 'https://www.yntv.cn', ...options.headers },
      }));
    }
  });
  if (!Array.isArray(body.lists) || body.streamer !== `https://tvlive.yntv.cn/live/${channelId}/playlist_dvr_range-`) {
    throw new Error('Invalid YNTV schedule response');
  }
  // ID 1 is the endpoint's generic gap filler, not evidence of a published day.
  if (!body.lists.some(row => row.id !== 1)) return [];
  return body.lists.map(row => {
    const st = row.start;
    if (!Number.isSafeInteger(st) || !Number.isSafeInteger(row.duration) || row.duration < 0) throw new Error('Invalid YNTV programme duration');
    const clock = new Date((st + 28800) * 1000).toISOString().slice(11, 16);
    const name = typeof row.name === 'string' && row.name.startsWith(clock) ? row.name.slice(5).trim() : row.name;
    return { name, st, et: st + row.duration, programId: row.id };
  });
}

export async function xjtvsProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid XJTV channel ID');
  const url = new URL('https://slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList');
  url.search = new URLSearchParams({ tvChannelId: channelId, date: date + ' 00:00:00', json: 'true' });
  const body = JSON.parse(await officialRequest(url.href, { ...options,
    headers: { Referer: 'https://www.xjtvs.com.cn/', Origin: 'https://www.xjtvs.com.cn', ...options.headers },
  }));
  if (body.success !== true || !Array.isArray(body.data)) throw new Error('Invalid XJTV schedule response');
  return body.data.map(row => {
    if (row.TVDate !== date) throw new Error('XJTV response date mismatch');
    const st = beijingTime(date + ' ' + row.StartTime);
    let et = beijingTime(date + ' ' + row.EndTime);
    // Explicit end clock before start clock is the broadcaster's overnight interval.
    if (et < st) et += 86400;
    return { name: row.Name, st, et, programId: row.Id };
  });
}

export async function kankanewsProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid Kankanews channel ID');
  const config = await cached('kankanews:web-config', options, async () => {
    const html = await officialRequest('https://live.kankanews.com/huikan?id=2', options);
    const match = html.match(/src="([^"<>]*\/js\/app\.v([^"<>]+)\.js)"/);
    if (!match) throw new Error('Kankanews app script missing');
    const script = await officialRequest(new URL(match[1], 'https://live.kankanews.com/').href, options);
    const salt = script.match(/\+="([a-f0-9]{32})"/)?.[1];
    if (!salt) throw new Error('Kankanews public web signature configuration missing');
    return { version: match[2], salt };
  });
  const params = { channel_id: channelId, date };
  const headers = { platform: 'pc', version: config.version, nonce: randomUUID().replaceAll('-', '').slice(0, 8),
    timestamp: String(Math.floor(Date.now() / 1000)), 'Api-Version': 'v1' };
  const data = { ...params, ...headers };
  const content = Object.keys(data).sort().map(key => `${key}=${data[key]}&`).join('') + config.salt;
  const md5 = value => createHash('md5').update(value).digest('hex');
  const body = JSON.parse(await officialRequest('https://kapi.kankanews.com/content/pc/tv/programs?' + new URLSearchParams(params), {
    ...options, headers: { ...headers, sign: md5(md5(content)), Referer: 'https://live.kankanews.com/' },
  }));
  if (body.code === '1000' && Array.isArray(body.result?.list) && body.result.list.length === 0) return [];
  if (body.code !== '1000' || !Array.isArray(body.result?.programs) || String(body.result.id) !== channelId) {
    throw new Error(`Invalid Kankanews schedule response: ${body.code}`);
  }
  return body.result.programs.map(row => ({ name: row.name, st: row.start_time, et: row.end_time, programId: row.id }));
}

export async function gxtvProgrammes(channelId, date, options = {}) {
  if (!/^[a-f0-9]{32}$/.test(channelId) || !options.channel?.native?.channelName) throw new Error('Invalid GXTV channel configuration');
  const load = day => cached(`gxtv/${channelId}/${day}`, options, async () => {
    const body = JSON.parse(await officialRequest('https://api2019.gxtv.cn/memberApi/programList/selectListByChannelId', {
      ...options, method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8', Referer: 'https://tv.gxtv.cn/' },
      body: new URLSearchParams({ channelId, channelName: options.channel.native.channelName, dateStr: day,
        deptId: '0a509685ba1a11e884e55cf3fc49331c', platformId: 'bd7d620a502d43c09b35469b3cd8c211' }).toString(),
    }));
    if (body.code === 0 && body.message === '暂无数据' && body.data == null) return [];
    if (!body.successful || !Array.isArray(body.data)) throw new Error(`Invalid GXTV programme list (${channelId}, ${day}, code=${body.code}, message=${body.message})`);
    return body.data.map(row => ({ name: row.programName, st: beijingTime(row.programTime),
      duration: row.programmeLength, programId: row.id }));
  });
  const rows = (await load(date)).sort((a, b) => a.st - b.st);
  if (!rows.length) return [];
  const nextDate = new Date(Date.parse(date + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
  const next = rows.at(-1).duration === 0 ? (await load(nextDate)).sort((a, b) => a.st - b.st)[0] : null;
  return rows.flatMap((row, i) => {
    if (!Number.isSafeInteger(row.duration) || row.duration < 0) throw new Error('Invalid GXTV programme duration');
    const stop = row.duration ? row.st + row.duration : (rows[i + 1] ?? next)?.st;
    if (stop === undefined) {
      options.omittedProgrammes?.push({ channel: options.channel.id, date, title: row.name, start: row.st,
        reason: 'official-end-time-unpublished', source: 'https://api2019.gxtv.cn/memberApi/programList/selectListByChannelId' });
      return [];
    }
    return [{ name: row.name, st: row.st, et: stop, programId: row.programId }];
  });
}

function webValue(script, name) {
  const value = script.match(new RegExp(name + ':"([^"\\n]+)"'))?.[1];
  if (!value) throw new Error(`JSTV public web configuration missing ${name}`);
  return /^(lujdd|uekcd|kmvts|hqudc)/.test(value) ? Buffer.from(value.slice(5, -5), 'base64').toString() : value;
}

async function jstvToken(options) {
  return cached('jstv:anonymous-token', options, async () => {
    // Follow the official site's app/chunk URLs instead of executing downloaded JavaScript in Node.
    const html = await officialRequest('https://live.jstv.com/', options);
    const appPath = html.match(/src="([^"<>]*\/app\.[^"<>]+\.js)"/)?.[1];
    if (!appPath) throw new Error('JSTV app script missing');
    const app = await officialRequest(new URL(appPath, 'https://live.jstv.com/').href, options);
    const chunkId = app.match(/component:\(\)=>\w+\.e\((\d+)\)/)?.[1];
    const chunkHash = app.match(/\.u=function\(\w+\)\{return"assets\/js\/"\+\w+\+"(\.[^"]+\.js)"/)?.[1];
    if (!chunkId || !chunkHash) throw new Error('JSTV live script missing');
    const script = await officialRequest(`https://live.jstv.com/assets/js/${chunkId}${chunkHash}`, options);
    const data = { platform: 41, uuid: randomUUID().replaceAll('-', ''), appId: webValue(script, 'appId') };
    const root = webValue(script, 'apiAuth');
    if (new URL(root).hostname !== 'api-auth-lizhi.jstv.com') throw new Error('Unexpected JSTV authentication host');
    const url = new URL(root + '/JwtAuth/GetWebToken');
    url.search = 'AppID=' + webValue(script, 'appSecretId');
    const now = Math.floor(Date.now() / 1000);
    const bytes = [now & 255, (now & 65280) >> 8, (now & 16711680) >> 16, (now & 4278190080) >> 24]
      .map(byte => (byte & 240) ^ 240 | (1 + (byte & 15)) & 15);
    const tt = bytes[3] | bytes[2] << 8 | bytes[1] << 16 | bytes[0] << 24;
    const content = Object.keys(data).sort().map(key => key + data[key]).join('');
    const signature = createHash('md5').update(webValue(script, 'appSecret') + url.pathname + url.search + content + now).digest('hex');
    url.search += `&TT=${tt}&Sign=${signature}`;
    const response = JSON.parse(await officialRequest(url.href, { ...options, method: 'POST',
      headers: { 'Content-Type': 'application/json', Referer: 'https://live.jstv.com/' }, body: JSON.stringify(data),
    }));
    if (!response.data?.accessToken) throw new Error('JSTV anonymous web token missing');
    return response.data.accessToken;
  });
}

export async function jstvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid JSTV channel ID');
  const url = `https://live-lizhi.jstv.com/api/Channel/Epg?channelId=${channelId}&days=6&isNeedTomorrow=0`;
  const guide = await cached(url, options, async () => {
    const token = await jstvToken(options);
    return JSON.parse(await officialRequest(url, { ...options, headers: { Authorization: 'Bearer ' + token } }));
  });
  if (!Array.isArray(guide.data?.epg) || String(guide.data.channelId) !== channelId) throw new Error('Invalid JSTV schedule response');
  const rows = guide.data.epg.find(day => day.date === date)?.data ?? [];
  if (!Array.isArray(rows)) throw new Error('Invalid JSTV programme list');
  return rows.map(row => ({ name: row.programName, st: beijingTime(row.startTime), et: beijingTime(row.endTime), programId: row.id }));
}

async function gdtvBrowser(options) {
  return cached('gdtv:browser', options, async () => {
    const { chromium } = await import('playwright');
    const browser = await chromium.launch({ headless: true });
    options.resources?.push(browser);
    const page = await browser.newPage();
    await page.route('**/*', route => {
      const request = route.request(), url = new URL(request.url());
      if (['image', 'font', 'media'].includes(request.resourceType()) || /\.m3u8|\.ts(?:\?|$)|\/incrReadCount/.test(url.href) ||
          (!['gdtv.cn', 'itouchtv.cn'].some(host => url.hostname === host || url.hostname.endsWith('.' + host)) && !['script', 'stylesheet'].includes(request.resourceType()))) {
        return route.abort();
      }
      return route.continue();
    });
    await page.goto('https://www.gdtv.cn/tvChannelDetail/43', { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.webpackJsonp && window.webpackJsonp.push !== Array.prototype.push, undefined, { timeout: 20_000 });
    await page.evaluate(() => {
      window.webpackJsonp.push([[], { autoepg: (module, exports, require) => { window.__autoEpgRequire = require; } }, [['autoepg']]]);
    });
    // The signing module is the same one used by the live page. Anonymous, isolated browser context.
    await page.waitForFunction(() => Boolean(window.__autoEpgRequire?.m?.[725]), undefined, { timeout: 20_000 });
    return page;
  });
}

export async function gdtvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid GDTV channel ID');
  const dates = options.dates ?? [date];
  const from = [...dates].sort()[0], to = [...dates].sort().at(-1);
  const url = `https://gdtv-api.gdtv.cn/api/tv/v2/tvMenu?tvChannelPk=${channelId}&beginAt=${from}&endAt=${to}`;
  const body = await cached(url, options, async () => {
    if (options.gdtvRequest) return options.gdtvRequest(url);
    const page = await gdtvBrowser(options);
    return page.evaluate(async url => {
      for (let attempt = 0; ; attempt++) {
        try {
          const headers = await window.__autoEpgRequire(725).default('GET', url, '');
          const response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`GDTV HTTP ${response.status}`); }
          return await response.json();
        } catch (error) {
          if (attempt === 2) throw error;
          await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
        }
      }
    }, url);
  });
  if (!Array.isArray(body.resultList)) throw new Error('Invalid GDTV schedule response');
  const rows = body.resultList.find(day => day.dateAt === date)?.tvMenus ?? [];
  const parsed = rows.map(row => ({ name: row.name, st: Number(row.beginAt) / 1000, et: Number(row.endAt) / 1000, programId: row.pk }));
  // The official guide occasionally gives a single programme a multi-day end.
  // Quarantine only isolated, recognisable bad intervals; never infer an end.
  const midnight = beijingTime(date + ' 00:00:00');
  const oversized = parsed.filter(row => typeof row.name === 'string' && row.name.trim() &&
    Number.isSafeInteger(row.st) && row.st >= midnight && row.st < midnight + 2 * 86400 &&
    Number.isSafeInteger(row.et) && row.et - row.st > 86400);
  if (oversized.length > 2 || oversized.length / parsed.length > 0.1) throw new Error(`GDTV excessive invalid durations (${channelId}, ${date})`);
  for (const row of oversized) options.omittedProgrammes?.push({ channel: options.channel?.id ?? channelId, date,
    programId: row.programId, title: row.name, start: row.st, stop: row.et,
    reason: 'official-duration-exceeds-day', source: url });
  const rejected = new Set(oversized);
  return parsed.filter(row => !rejected.has(row));
}

export async function cztvProgrammes(channelId, date, options = {}) {
  if (!/^\d+$/.test(channelId)) throw new Error('Invalid CZTV channel ID');
  const compact = date.replaceAll('-', '');
  const url = `https://p.cztv.com/api/paas/program/${channelId}/${compact}`;
  const body = JSON.parse(await officialRequest(url, options));
  const station = body.content?.list?.[0];
  if (!station || !Array.isArray(station.list)) throw new Error('Invalid CZTV schedule response');
  // Unpublished dates return a generic station-0 current-day guide. Never export it.
  if (station.station_id === 0) return [];
  if (station.station_date !== compact) throw new Error('CZTV response date mismatch');
  return station.list.map(row => {
    const start = Number(row.play_time) / 1000, duration = Number(row.duration) / 1000;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(duration) || duration < 0) {
      throw new Error('Invalid CZTV programme timestamp/duration');
    }
    return { name: row.program_title, st: start, et: start + duration, programId: row.program_id };
  });
}

export async function nxtvProgrammes(channelId, date, options = {}) {
  if (!['nxws', 'nxgg', 'nxwl'].includes(channelId)) throw new Error('Invalid NXTV channel ID');
  const url = 'https://api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv';
  const body = await cached(url, options, async () => JSON.parse(await officialRequest(url, { ...options,
    headers: { Referer: 'https://www.nxtv.cn/', Origin: 'https://www.nxtv.cn', ...options.headers },
  })));
  if (body.errcode !== 200 || body.data?.appid !== 'nxtv-tv' || !Array.isArray(body.data.menu)) {
    throw new Error('Invalid NXTV schedule response');
  }
  const station = body.data.menu.find(row => row.ename === channelId);
  if (!station || !Array.isArray(station.playbill)) throw new Error('NXTV channel programme list missing');
  // The official website supplies only its published day. Never relabel it.
  const rows = station.playbill.map(row => {
    const start = String(row.stime).replaceAll('/', '-');
    const stop = String(row.otime).replaceAll('/', '-');
    const st = beijingTime(start), et = beijingTime(stop);
    if (st !== row.stimestamp || et !== row.otimestamp) throw new Error('NXTV timestamp/date mismatch');
    return { name: row.name, st, et, date: start.slice(0, 10) };
  });
  return rows.filter(row => row.date === date).map(({ date: _date, ...row }) => row);
}

async function hbtvWebHeaders(options) {
  return cached('hbtv:public-web-headers', options, async () => {
    const root = 'https://res.cjyun.org/t/common/app/iptv/';
    const html = await officialRequest(root, options);
    const manifest = html.match(/src=["']?(\.\/static\/js\/manifest\.[a-f0-9]+\.js)/)?.[1];
    if (!manifest) throw new Error('HBTV public website manifest missing');
    const runtime = await officialRequest(new URL(manifest, root).href, options);
    const hash = runtime.match(/\b0:"([a-f0-9]+)"/)?.[1];
    if (!hash) throw new Error('HBTV public website configuration chunk missing');
    const script = await officialRequest(new URL(`static/js/0.${hash}.js`, root).href, options);
    const authorization = script.match(/defaults\.headers\.Authorization="([A-Za-z0-9]+)"/)?.[1];
    if (!authorization) throw new Error('HBTV anonymous website header missing');
    return { Authorization: authorization, Referer: root };
  });
}

export async function hbtvProgrammes(channelId, date, options = {}) {
  if (!/^99180001000000050000000000000\d{3}$/.test(channelId)) throw new Error('Invalid HBTV channel code');
  const midnight = beijingTime(date + ' 00:00:00');
  const url = new URL('https://cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/null/show');
  url.search = new URLSearchParams({ channelCode: channelId, date });
  const headers = await hbtvWebHeaders(options);
  const body = JSON.parse(await officialRequest(url.href, { ...options, headers }));
  if (body.code !== 200 || !Array.isArray(body.data)) throw new Error('Invalid HBTV schedule response');
  return body.data.map(row => {
    if (row.channelcode !== channelId) throw new Error('HBTV response channel mismatch');
    const st = beijingTime(row.starttime ?? row.startime), et = beijingTime(row.endtime);
    if (st < midnight || st >= midnight + 86400) throw new Error('HBTV response date mismatch');
    return { name: row.name, st, et, programId: row.code };
  });
}

export const OFFICIAL_ADAPTERS = {
  hbtv: { name: '湖北广播电视台长江云 TV', source: 'https://cjy-iptv.hbtv.com.cn/wxcms3/remote-wx/api/cj-cloud/play/null/show', programmes: hbtvProgrammes },
  nxtv: { name: '宁夏广播电视台黄河云', source: 'https://api.ningxiahuangheyun.com/?mod=get_appdata&appid=nxtv-tv', programmes: nxtvProgrammes },
  qhbtv: { name: '青海广播电视台', source: 'https://mapi.qhbtv.com.cn/cloudlive-manage-mapi/api/topic/program/list', programmes: qhbtvProgrammes },
  setv: { name: '上海教育电视台', source: 'https://api.setv.sh.cn/getLatestEPG', programmes: setvProgrammes },
  yntv: { name: '云南广播电视台', source: 'https://yntv-api.yntv.cn/index/jmd/getJmd', programmes: yntvProgrammes },
  fjtv: { name: '福建省广播影视集团', source: 'https://mapi-plus.fjtv.net/cloudlive-manage-mapi/api/topic/program/list', programmes: fjtvProgrammes },
  snrtv: { name: '陕西广电融媒体集团', source: 'https://qidian.sxtvs.com/api/v3/program/tv', programmes: snrtvProgrammes },
  iqilu: { name: '山东广播电视台闪电新闻', source: 'https://sdxw.iqilu.com/v1/app/play/program/qilu', programmes: iqiluProgrammes },
  hntv: { name: '河南广播电视台', source: 'https://pubmod.hntv.tv/program/getAuth/vod/originStream/program/', programmes: hntvProgrammes },
  hnntv: { name: '海南广播电视总台', source: 'https://www.hnntv.cn/api/schedule/byDay', programmes: hnntvProgrammes },
  cztv: { name: '浙江广播电视集团', source: 'https://p.cztv.com/api/paas/program/', programmes: cztvProgrammes },
  sxtv: { name: '山西广播电视台', source: 'https://apphhplushttps.sxrtv.com/epg/', programmes: sxtvProgrammes },
  hebtv: { name: '河北广播电视台', source: 'https://api.cmc.hebrts.cn/spidercrms/api/live/liveShowSet/findNoPage', programmes: hebtvProgrammes },
  jstv: { name: '江苏省广播电视总台', source: 'https://live-lizhi.jstv.com/api/Channel/Epg', programmes: jstvProgrammes },
  gdtv: { name: '广东广播电视台', source: 'https://gdtv-api.gdtv.cn/api/tv/v2/tvMenu', programmes: gdtvProgrammes },
  xjtvs: { name: '新疆广播电视台', source: 'https://slstapi.xjtvs.com.cn/api/TVLiveV100/TVGuideList', programmes: xjtvsProgrammes },
  kankanews: { name: '上海广播电视台看看新闻', source: 'https://kapi.kankanews.com/content/pc/tv/programs', programmes: kankanewsProgrammes },
  gxtv: { name: '广西广播电视台', source: 'https://api2019.gxtv.cn/memberApi/programList/selectListByChannelId', programmes: gxtvProgrammes },
};
