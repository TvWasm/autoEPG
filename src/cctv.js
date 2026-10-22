import { setTimeout as sleep } from 'node:timers/promises';
import { Yangshipin } from './source.js';
import { groupedChannels } from './channels.js';
import { projectLogo } from './logos.js';
import { sourceFailure } from './diagnostics.js';

export const CCTV_CHANNELS = [
  { id: 'cctv4europe', pid: 'cctveurope', name: 'CCTV4(欧)',
    aliases: ['CCTV4(欧)', 'CCTV4（欧）', 'CCTV-4 (欧洲)', 'CCTV4欧洲', 'CCTV-4 中文国际（欧）'] },
  { id: 'cctv4america', pid: 'cctvamerica', name: 'CCTV4(美)',
    aliases: ['CCTV4(美)', 'CCTV4（美）', 'CCTV-4 (美洲)', 'CCTV4美洲', 'CCTV-4 中文国际（美）'] },
];

export async function cctvProgrammes(channel, date, {
  fetchImpl = fetch, retries = 3, timeoutMs = 20_000, delay = sleep,
} = {}) {
  const url = new URL('https://api.cntv.cn/epg/getEpgInfoByChannelNew');
  url.search = new URLSearchParams({ c: channel.pid, serviceId: 'tvcctv', d: date.replaceAll('-', '') });
  for (let attempt = 0; ; attempt++) {
    try {
      const response = await fetchImpl(url.href, {
        signal: AbortSignal.timeout(timeoutMs), headers: { Referer: channel.url },
      });
      if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
      const data = (await response.json()).data?.[channel.pid];
      if (!data || typeof data.channelName !== 'string' ||
          (data.list !== undefined && !Array.isArray(data.list))) throw new Error('Invalid CCTV schedule response');
      // CCTV omits list when the requested day's schedule is not published.
      return (data.list ?? []).map(row => ({
        name: row.title, st: row.startTime, et: row.endTime, programId: row.eventId || undefined,
      }));
    } catch (error) {
      if (attempt + 1 >= retries) throw new Error(`${url.href}: ${error.message}`, { cause: error });
      await delay(1000 * 2 ** attempt);
    }
  }
}

export class EpgSources {
  constructor({ dates, yangshipin = new Yangshipin(), provincial = null, allowPartial = false, ...options }) {
    this.dates = dates;
    this.yangshipin = yangshipin;
    this.options = options;
    this.provincial = provincial;
    this.allowPartial = allowPartial;
    this.failures = [];
    this.warnings = [];
  }
  async channels() {
    this.failures.length = 0;
    this.warnings.length = 0;
    let channels = [], extra = [];
    try { channels = await this.yangshipin.channels(); }
    catch (error) {
      this.failures.push(sourceFailure({ source: 'yangshipin', sourceName: '央视频', phase: 'discovery', error }));
      if (!this.allowPartial) throw error;
    }
    if (this.provincial) {
      try { extra = await this.provincial.channels(channels); }
      catch (error) {
        this.failures.push(sourceFailure({ source: 'provincial', sourceName: '省台官网发现', phase: 'discovery', error }));
        if (!this.allowPartial) throw error;
      }
      this.failures.push(...(this.provincial.failures ?? []));
      this.warnings.push(...(this.provincial.warnings ?? []));
    }
    this.provincialCoverage = this.provincial?.report;
    return groupedChannels([...channels, ...extra, ...CCTV_CHANNELS.map((channel, i) => ({
      ...channel, source: 'cctv', sourceName: channel.name,
      url: `https://tv.cctv.com/live/${channel.pid}/`,
      groupId: 'cctv', group: '央视频道', order: 45 + i,
      legacyIds: [], logo: projectLogo('cctv4'), dates: [...this.dates],
    }))]);
  }
  programmes(channel, date) {
    if (channel.source === 'provincial') {
      if (this.provincial.hasSchedule(channel, date) || channel.groupId === 'provincial') return this.provincial.programmes(channel, date);
      return this.yangshipin.programmes(channel, date);
    }
    return channel.source === 'cctv'
      ? cctvProgrammes(channel, date, this.options) : this.yangshipin.programmes(channel, date);
  }
  async refreshProgrammes(channel, date) {
    if (channel.source !== 'provincial') return this.programmes(channel, date);
    const rows = await this.provincial.refreshProgrammes(channel, date);
    return rows.length || channel.groupId === 'provincial' ? rows : this.yangshipin.programmes(channel, date);
  }
  describeSource(channel, date) {
    if (channel.source === 'provincial' && (this.provincial.hasSchedule(channel, date) || channel.groupId === 'provincial')) {
      return { source: channel.sourceId ?? 'provincial', sourceName: channel.sourceName, url: channel.sourceUrls?.[0] };
    }
    if (channel.source === 'cctv') return { source: 'cctv', sourceName: '央视网', url: channel.url };
    return { source: 'yangshipin', sourceName: '央视频', url: 'https://www.yangshipin.cn/tv/home' };
  }
}
