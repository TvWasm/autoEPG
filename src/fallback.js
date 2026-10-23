import { createHash } from 'node:crypto';
import { create } from 'xmlbuilder2';
import { dateKey, windowFor, normalize, deduplicate } from './epg.js';
import { sourceFailure, errorMessage, transportFailure } from './diagnostics.js';

const digest = bytes => createHash('sha256').update(bytes).digest('hex');

// This is a cache of real published schedules, never a template for another day.
export function validateSnapshot(input, date) {
  const range = windowFor(date, 0, 0);
  if (input?.schemaVersion !== 1 || input.date !== date || !Array.isArray(input.channels) ||
      !Array.isArray(input.programmes) || !Number.isFinite(Date.parse(input.generatedAt))) throw new Error('Invalid fallback snapshot');
  const channels = new Map();
  for (const c of input.channels) {
    if (!c || typeof c.id !== 'string' || !/^[\w.-]+$/.test(c.id) || !c.name || channels.has(c.id) ||
        !['cctv', 'weishi', 'provincial'].includes(c.groupId)) throw new Error('Invalid fallback channel');
    channels.set(c.id, c);
  }
  const programmes = input.programmes.flatMap(p => {
    const c = channels.get(p.channel);
    if (!c || p.start >= range.stop || p.stop <= range.start) throw new Error('Fallback programme outside its release date');
    const observedAt = p.observedAt ?? input.generatedAt;
    if (!Number.isFinite(Date.parse(observedAt))) throw new Error('Invalid fallback observation time');
    return normalize([{ name: p.title, st: p.start, et: p.stop }], c, dateKey(p.start)).map(row => ({ ...row, observedAt }));
  });
  if (!programmes.length) throw new Error('Empty fallback snapshot');
  return { ...input, programmes: deduplicate(programmes) };
}

export function legacySnapshot(xml, channels, manifest, date) {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new Error('Unsupported fallback XML declarations');
  const root = create(xml).node.documentElement;
  if (root.nodeName !== 'tv' || manifest.date !== date) throw new Error('Invalid fallback XML date');
  const clock = text => {
    const m = text?.match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2}) \+0800$/);
    if (!m) throw new Error('Invalid fallback XMLTV time');
    return Date.parse(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}+08:00`) / 1000;
  };
  const programmes = Array.from(root.getElementsByTagName('programme'), node => ({
    channel: node.getAttribute('channel'), title: node.getElementsByTagName('title')[0]?.textContent,
    start: clock(node.getAttribute('start')), stop: clock(node.getAttribute('stop')),
  }));
  return validateSnapshot({ schemaVersion: 1, date, channels, programmes, generatedAt: manifest.generatedAt }, date);
}

export async function loadPublishedFallback(repository, dates, { fetchImpl = fetch, timeoutMs = 12_000 } = {}) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '')) throw new Error('Invalid fallback repository');
  const snapshots = [], warnings = [];
  const download = async url => {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length;
      if (length > 20 * 1024 * 1024) throw new Error('Fallback asset exceeds 20 MiB');
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  };
  // Bound parallel downloads, so recovery does not compete with every provider.
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(3, dates.length) }, async () => {
    while (next < dates.length) {
      const date = dates[next++];
      windowFor(date, 0, 0);
      const base = `https://github.com/${repository}/releases/download/${date}/`;
      try {
        const sums = (await download(base + 'SHA256SUMS')).toString();
        const hashes = new Map(sums.trim().split('\n').map(line => {
          const m = line.match(/^([a-f0-9]{64})  ([\w.-]+)$/);
          if (!m) throw new Error('Invalid fallback checksum list');
          return [m[2], m[1]];
        }));
        const verified = async name => {
          if (!hashes.has(name)) throw new Error(`Missing fallback checksum: ${name}`);
          const bytes = await download(base + name);
          if (digest(bytes) !== hashes.get(name)) throw new Error(`Fallback checksum mismatch: ${name}`);
          return bytes.toString();
        };
        let snapshot;
        if (hashes.has('snapshot.json')) snapshot = validateSnapshot(JSON.parse(await verified('snapshot.json')), date);
        else {
          const [xml, channels, manifest] = await Promise.all(['epg.xml', 'channels.json', 'manifest.json'].map(verified));
          snapshot = legacySnapshot(xml, JSON.parse(channels), JSON.parse(manifest), date);
        }
        snapshots.push({ ...snapshot, origin: base });
      } catch (error) {
        warnings.push({ code: 'fallback-unavailable', date, message: `已发布兜底 ${date} 无法读取：${errorMessage(error)}` });
      }
    }
  }));
  return { snapshots: snapshots.sort((a, b) => a.date.localeCompare(b.date)), warnings };
}

export class FallbackSource {
  constructor(source, snapshots, { dates } = {}) {
    this.source = source;
    this.dates = dates;
    this.snapshots = snapshots;
    this.failures = [];
    this.warnings = [];
    this.usage = new Map();
    this.broken = new Map();
  }
  async channels() {
    let live = [];
    try { live = await this.source.channels(); }
    catch (error) { this.failures.push(sourceFailure({ source: 'live-discovery', phase: 'discovery', error })); }
    this.failures.push(...(this.source.failures ?? []));
    this.warnings.push(...(this.source.warnings ?? []));
    this.provincialCoverage = this.source.provincialCoverage;
    this.liveIds = new Set(live.map(c => c.id));
    const merged = new Map(live.map(c => [c.id, { ...c, dates: [...new Set([...c.dates, ...this.dates])] } ]));
    this.rows = new Map();
    for (const snapshot of this.snapshots) {
      for (const c of snapshot.channels) if (!merged.has(c.id)) merged.set(c.id, { ...c, dates: [...this.dates] });
      for (const p of snapshot.programmes) {
        const key = p.channel + '/' + dateKey(p.start);
        if (!this.rows.has(key)) this.rows.set(key, new Map());
        // Adjacent daily releases repeat midnight programmes. Prefer the copy
        // from the newest snapshot, then deduplicate before using the batch.
        const existing = this.rows.get(key).get(p.start);
        if (!existing || (p.observedAt ?? snapshot.generatedAt) > existing.generatedAt) this.rows.get(key).set(p.start, { ...p,
          generatedAt: p.observedAt ?? snapshot.generatedAt, origin: snapshot.origin, releaseDate: snapshot.date });
      }
    }
    for (const [id, channel] of merged) if (!this.liveIds.has(id)) {
      channel.dates = [...this.rows.keys()].filter(key => key.startsWith(id + '/')).map(key => key.slice(id.length + 1))
        .filter(date => this.dates.includes(date));
      if (!channel.dates.length) merged.delete(id);
    }
    return [...merged.values()];
  }
  describeSource(channel, date) {
    if (!this.liveIds?.has(channel.id)) return { source: 'published-cache', sourceName: '已发布同日节目单' };
    return this.source.describeSource?.(channel, date) ?? { source: channel.source ?? 'yangshipin' };
  }
  async programmes(channel, date, refresh = false) {
    let error;
    const provider = this.describeSource(channel, date).source;
    if (this.liveIds.has(channel.id) && (this.broken.get(provider) ?? 0) < 3) {
      try {
        const rows = refresh && this.source.refreshProgrammes
          ? await this.source.refreshProgrammes(channel, date) : await this.source.programmes(channel, date);
        const parsed = deduplicate(normalize(rows, channel, date));
        if (parsed.length && parsed.some(p => dateKey(p.start) === date)) {
          this.broken.set(provider, 0);
          this.usage.delete(channel.id + '/' + date);
          return rows.filter(row => dateKey(row.st) === date);
        }
        error = new Error('Official source has no published schedule for this date');
      } catch (cause) {
        error = cause;
        if (transportFailure(cause)) this.broken.set(provider, (this.broken.get(provider) ?? 0) + 1);
      }
    } else error = new Error(this.liveIds.has(channel.id) ? 'Live source circuit open after repeated transport failures' : 'Channel unavailable in live discovery');
    const key = channel.id + '/' + date;
    const cached = [...(this.rows.get(key)?.values() ?? [])];
    if (!cached.length) { if (this.liveIds.has(channel.id) && /no published schedule/.test(error.message)) return []; throw error; }
    deduplicate(cached);
    this.usage.set(key, { channel: channel.id, channelName: channel.name, date, reason: errorMessage(error),
      programmeCount: cached.length, generatedAt: [...new Set(cached.map(p => p.generatedAt))],
      releases: [...new Set(cached.map(p => p.releaseDate))] });
    return cached.map(p => ({ name: p.title, st: p.start, et: p.stop }));
  }
  refreshProgrammes(channel, date) { return this.programmes(channel, date, true); }
}
