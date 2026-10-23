import protobuf from 'protobufjs';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { channelProfile, groupedChannels } from './channels.js';
import { projectLogo, projectLogoBytes } from './logos.js';
import { readFileSync } from 'node:fs';

export const HOME = 'https://www.yangshipin.cn/tv/home';
const API = 'https://capi.yangshipin.cn/api/';
const schema = await protobuf.load(fileURLToPath(new URL('./yangshipin.proto', import.meta.url)));

function errorDetail(error) {
  const seen = new Set();
  const describe = (value, depth = 0) => {
    if (!value || seen.has(value) || depth > 4) return '';
    seen.add(value);
    const message = [value.code, value.message].filter(Boolean).join(': ');
    const causes = [value.cause, ...(value.errors ?? [])].map(cause => describe(cause, depth + 1)).filter(Boolean);
    return [message, ...causes].filter(Boolean).join('; ');
  };
  return describe(error).slice(0, 1000);
}

export function pngLogo(value) {
  if (!value) return '';
  const url = new URL(value);
  if (!['https:', 'http:'].includes(url.protocol) || !/\.png$/i.test(url.pathname)) {
    throw new Error(`Expected a PNG channel logo: ${value}`);
  }
  // Yangshipin's .png paths normally carry a CDN directive that returns WebP.
  if (url.hostname === 'resources.yangshipin.cn' && url.search === '?imageMogr2/format/webp') url.search = '';
  url.hash = '';
  return url.href;
}

export function channelAliases(name) {
  const aliases = new Set([name, name.normalize('NFKC')]);
  const cctv = name.match(/^CCTV(\d+)(\+?)$/);
  if (cctv) aliases.add(`CCTV-${cctv[1]}${cctv[2]}`);
  if (name === 'CCTV16-HD') { aliases.add('CCTV16'); aliases.add('CCTV-16'); }
  if (name.normalize('NFKC') === 'CCTV16(4K)') { aliases.add('CCTV16-4K'); aliases.add('CCTV-16-4K'); }
  if (name === '福建东南卫视') aliases.add('东南卫视');
  if (name === '中国教育电视台1频道') { aliases.add('CETV1'); aliases.add('CETV-1'); }
  return [...aliases];
}

export async function verifyPngLogos(channels, { fetchImpl = fetch, delay = sleep } = {}) {
  const urls = [...new Set(channels.map(c => c.logo).filter(Boolean))];
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
    while (next < urls.length) {
      const url = urls[next++];
      // Versioned repository assets are checked locally, including before the first push.
      const local = projectLogoBytes(url);
      if (local) {
        if (!local.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
          throw new Error(`Project logo is not PNG: ${url}`);
        }
        continue;
      }
      for (let attempt = 0; ; attempt++) {
        try {
          // No Referer or login headers: these links must work in IPTV clients too.
          const response = await fetchImpl(url, {
            signal: AbortSignal.timeout(20_000), headers: { Accept: 'image/png', Range: 'bytes=0-7' },
          });
          if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
          const bytes = new Uint8Array(await response.arrayBuffer());
          const signature = [137, 80, 78, 71, 13, 10, 26, 10];
          if (!signature.every((value, i) => bytes[i] === value)) throw new Error('Response is not PNG');
          break;
        } catch (error) {
          if (attempt === 2) throw new Error(`PNG logo check failed for ${url}: ${errorDetail(error)}`, { cause: error });
          await delay(1000 * 2 ** attempt);
        }
      }
    }
  }));
  return urls.length;
}

export function decode(type, bytes) {
  const message = schema.lookupType(`yangshipin.${type}`);
  const data = message.toObject(message.decode(bytes), { longs: Number, arrays: true });
  if (data.code !== 200) throw new Error(`Upstream code ${data.code}: ${data.message ?? 'invalid response'}`);
  return data;
}

export async function request(url, type, {
  fetchImpl = fetch, retries = 3, timeoutMs = 20_000, delay = sleep,
} = {}) {
  let lastError;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetchImpl(url, {
        signal: AbortSignal.timeout(timeoutMs),
        headers: { 'User-Agent': 'autoEPG/1.0 (+https://github.com/TvWasm/autoEPG)', Referer: HOME },
      });
      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`HTTP ${response.status}`);
      }
      return decode(type, new Uint8Array(await response.arrayBuffer()));
    } catch (error) {
      lastError = error;
      if (attempt + 1 < retries) await delay(1000 * 2 ** attempt);
    }
  }
  throw new Error(`${url}: ${errorDetail(lastError)}`, { cause: lastError });
}

export function extractChannels(page) {
  const channels = new Map();
  for (const module of page.data?.feedModuleList ?? []) {
    if (module.moduleType !== 'tvChannel') continue;
    for (const c of module.dataTvChannelList ?? []) {
      if (!/^\d+$/.test(c.pid) || !c.channelName?.trim()) throw new Error('Invalid upstream channel');
      const dates = [...new Set(c.programDates ?? [])].sort();
      if (dates.some(d => !/^\d{4}-\d{2}-\d{2}$/.test(d) ||
        Number.isNaN(Date.parse(d)) || new Date(d).toISOString().slice(0, 10) !== d)) {
        throw new Error(`Invalid programme date for ${c.pid}`);
      }
      const profile = channelProfile(c.pid, c.channelName.trim(), c.channelType);
      const channel = {
        ...profile, pid: c.pid,
        logo: projectLogo(profile.id) ?? pngLogo(c.tvLogo), dates,
      };
      channel.aliases = [...new Set([...channel.aliases, ...channelAliases(c.channelName.trim())])];
      const previous = channels.get(c.pid);
      if (previous && previous.name !== channel.name) throw new Error(`Conflicting channel ${c.pid}`);
      if (previous) channel.dates = [...new Set([...previous.dates, ...dates])].sort();
      channels.set(c.pid, channel);
    }
  }
  if (!channels.size) throw new Error('No TV channels found; upstream schema may have changed');
  const result = groupedChannels([...channels.values()]);
  if (new Set(result.map(c => c.id)).size !== result.length) throw new Error('Duplicate normalized channel IDs');
  return result;
}

export class Yangshipin {
  constructor(options = {}) { this.options = options; }
  async channels() {
    const nav = await request(`${API}oms/pc/navigation/home_top_nav`, 'NavigationResponse', this.options);
    const tab = nav.data?.tabList?.find(t => t.channelTag === 2);
    if (!tab?.feedId) throw new Error('TV navigation missing; upstream schema may have changed');
    const page = await request(`${API}oms/pc/page/${encodeURIComponent(tab.feedId)}`, 'PageResponse', this.options);
    const channels = extractChannels(page);
    try { await verifyPngLogos(channels, this.options); }
    catch (error) {
      if (!this.options.allowLogoFailure) throw error;
      this.options.onWarning?.({ code: 'logo-unavailable', message: error.message });
      for (const channel of channels) if (!projectLogoBytes(channel.logo)) channel.logo = '';
    }
    return channels;
  }
  async programmes(channel, date) {
    const response = await request(`${API}yspepg/program/${channel.pid}/${date.replaceAll('-', '')}`,
      'ProgrammeResponse', this.options);
    return response.dataList;
  }
}

// Versioned channel identities survive navigation/schema outages. These are
// only identifiers; all programme times still come from the official APIs.
export function knownYangshipinChannels(dates) {
  const profiles = JSON.parse(readFileSync(new URL('./channel-profiles.json', import.meta.url), 'utf8'));
  return groupedChannels(Object.entries(profiles).map(([pid, profile]) => ({
    ...channelProfile(pid, profile.name, profile.order < 40 ? 'yangshi' : 'weishi'),
    pid, dates: [...dates], logo: projectLogo(profile.id) ?? '',
  })));
}
