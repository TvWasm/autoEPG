import { create } from 'xmlbuilder2';
import { setTimeout as sleep } from 'node:timers/promises';
import { mkdir, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { HOME } from './source.js';
import { GROUPS, groupedChannels, groupFile } from './channels.js';
import { sourceFailure, transportFailure } from './diagnostics.js';

const DAY = 86_400;
const OFFSET = 8 * 3600;

export function dateKey(seconds) {
  return new Date((seconds + OFFSET) * 1000).toISOString().slice(0, 10);
}
export function xmltvTime(seconds) {
  return new Date((seconds + OFFSET) * 1000).toISOString().slice(0, 19).replace(/[-:T]/g, '') + ' +0800';
}
export function windowFor(today, pastDays, futureDays) {
  const midnight = Date.parse(`${today}T00:00:00+08:00`) / 1000;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || !Number.isFinite(midnight) || dateKey(midnight) !== today) {
    throw new Error('Date must be a valid YYYY-MM-DD date');
  }
  return { start: midnight - pastDays * DAY, stop: midnight + (futureDays + 1) * DAY };
}
export function cleanText(value) {
  // XML 1.0 permits tabs, CR/LF, and these Unicode ranges only.
  return String(value).replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD\u{10000}-\u{10FFFF}]/gu, '').trim();
}

export function normalize(rows, channel, date, { onDiscard = () => {} } = {}) {
  const midnight = windowFor(date, 0, 0).start;
  return rows.flatMap(row => {
    const start = row.st, stop = row.et;
    const title = cleanText(row.name ?? '');
    if (!title || !Number.isSafeInteger(start) || !Number.isSafeInteger(stop) ||
        start < midnight || start >= midnight + 2 * DAY || stop < start || stop - start > DAY) {
      throw new Error(`Invalid programme ${channel.pid}/${date}/${row.programId ?? '?'}: title or timestamps`);
    }
    // Schedule edits can leave empty intervals beside their valid replacements.
    // They contain no airtime; omit them without guessing an end or changing other rows.
    if (stop === start) {
      onDiscard({ channel: channel.id, date, programId: row.programId ?? null,
        title, start, stop, reason: 'zero-duration' });
      return [];
    }
    return [{ channel: channel.id, title, start, stop }];
  });
}

export function deduplicate(programmes) {
  const unique = new Map();
  for (const programme of programmes) {
    const key = `${programme.channel}/${programme.start}`;
    const previous = unique.get(key);
    if (previous && (previous.title !== programme.title || previous.stop !== programme.stop)) {
      throw new Error(`Conflicting programmes at ${key}`);
    }
    unique.set(key, programme);
  }
  return [...unique.values()].sort((a, b) => a.channel.localeCompare(b.channel) || a.start - b.start);
}

export async function collect(source, {
  today = dateKey(Date.now() / 1000), pastDays = 3, futureDays = 3,
  concurrency = 4, minChannels = 50, minTodayCoverage = 0.9,
  delayMs = 150, onProgress = () => {}, allowPartial = false,
} = {}) {
  const range = windowFor(today, pastDays, futureDays);
  const channels = await source.channels();
  const warnings = [...(source.warnings ?? [])];
  if (channels.length < minChannels) {
    const message = `Only ${channels.length} channels; expected at least ${minChannels}`;
    if (!allowPartial) throw new Error(message);
    warnings.push({ code: 'min-channels', message });
  }
  const first = dateKey(range.start), last = dateKey(range.stop - 1);
  // Include the preceding day's final programme if it crosses into our window.
  const firstFetch = dateKey(range.start - DAY);
  const tasks = channels.flatMap(channel => channel.dates
    .filter(date => date >= firstFetch && date <= last).map(date => ({ channel, date })));
  const failures = [...(source.failures ?? [])], batches = new Map(), scheduleRechecks = [], brokenSources = new Map();
  const failed = message => Object.assign(new Error(message), { failures, warnings });
  const describe = (channel, date) => source.describeSource?.(channel, date) ??
    { source: channel.sourceId ?? channel.source ?? 'yangshipin', sourceName: channel.sourceName ?? '央视频' };
  const recordFailure = (channel, date, error, phase) => {
    const details = describe(channel, date);
    failures.push(sourceFailure({ ...details, url: details.url ?? channel.sourceUrls?.[0] ?? channel.url, channel, date, error, phase }));
  };
  const readSchedule = async ({ channel, date }, refresh = false) => {
    const rows = refresh && source.refreshProgrammes
      ? await source.refreshProgrammes(channel, date) : await source.programmes(channel, date);
    const discarded = [];
    // The extra day is only a lookback for programmes crossing midnight.
    const relevant = date < first ? rows.filter(row => row.et > range.start) : rows;
    const parsed = normalize(relevant, channel, date, { onDiscard: p => discarded.push(p) });
    if (parsed.length && !parsed.some(p => dateKey(p.start) === date)) {
      throw new Error('Response contains no programmes starting on the requested date');
    }
    return { channel, date, empty: !rows.length, discarded,
      programmes: parsed.filter(p => p.start < range.stop && p.stop > range.start) };
  };
  let next = 0, completed = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, async () => {
    while (next < tasks.length) {
      const { channel, date } = tasks[next++];
      const provider = describe(channel, date).source;
      if (allowPartial && (brokenSources.get(provider) ?? 0) >= 3) {
        recordFailure(channel, date, 'Source circuit open after 3 consecutive transport failures; skipped remaining requests for this run', 'skipped');
        onProgress(++completed, tasks.length);
        continue;
      }
      try {
        batches.set(channel.id + '/' + date, await readSchedule({ channel, date }));
        brokenSources.set(provider, 0);
      } catch (error) {
        recordFailure(channel, date, error, 'fetch-or-validate');
        if (transportFailure(error)) brokenSources.set(provider, (brokenSources.get(provider) ?? 0) + 1);
      }
      onProgress(++completed, tasks.length);
      if (delayMs) await sleep(delayMs);
    }
  }));
  if (failures.length && !allowPartial) throw failed(`${failures.length} schedule request(s) failed:\n${failures.map(f => `${f.channelName ?? f.sourceName}/${f.date ?? ''}: ${f.message}`).join('\n')}`);
  // Re-read affected schedules to recover from an upstream edit during the run.
  // A persistent ambiguity still fails: neither row order nor programme ID wins.
  let result;
  for (let attempt = 0; ; attempt++) {
    const programmes = [...batches.values()].flatMap(batch => batch.programmes);
    try { result = deduplicate(programmes); break; } catch (error) {
      if (attempt === 2 && !allowPartial) throw error;
      const candidates = new Map();
      for (const batch of batches.values()) for (const p of batch.programmes) {
        const key = p.channel + '/' + p.start;
        if (!candidates.has(key)) candidates.set(key, []);
        candidates.get(key).push({ date: batch.date, ...p });
      }
      const conflicts = [...candidates.values()].filter(rows => rows.some(p => p.title !== rows[0].title || p.stop !== rows[0].stop));
      const affected = new Set(conflicts.flatMap(rows => rows.map(p => p.channel + '/' + p.date)));
      if (attempt === 2) {
        for (const key of affected) {
          const batch = batches.get(key);
          recordFailure(batch.channel, batch.date, error, 'conflict');
          batches.delete(key);
        }
        scheduleRechecks.push({ attempt, reason: 'excluded-persistent-conflicts', conflicts, requestCount: 0 });
        result = deduplicate([...batches.values()].flatMap(b => b.programmes));
        break;
      }
      scheduleRechecks.push({ attempt: attempt + 1, reason: 'conflicting-programmes', conflicts, requestCount: affected.size });
      if (delayMs) await sleep(delayMs);
      for (const key of affected) {
        const batch = batches.get(key);
        try { batches.set(key, await readSchedule(batch, true)); }
        catch (refreshError) {
          if (!allowPartial) throw refreshError;
          recordFailure(batch.channel, batch.date, refreshError, 'refresh');
          batches.delete(key);
        }
      }
    }
  }
  const empty = [...batches.values()].filter(b => b.empty).map(b => ({ channel: b.channel.id, date: b.date }));
  const discarded = [...batches.values()].flatMap(b => b.discarded);
  if (!result.length) throw failed('No programmes; refusing to publish an empty EPG');
  const todayChannels = new Set(result.filter(p => dateKey(p.start) === today).map(p => p.channel));
  const coverage = todayChannels.size / channels.length;
  if (coverage < minTodayCoverage) {
    const message = `Today's channel coverage ${(coverage * 100).toFixed(1)}% is below ${minTodayCoverage * 100}%`;
    if (!allowPartial) throw failed(message);
    warnings.push({ code: 'today-coverage', message });
  }
  const current = windowFor(today, 0, 0);
  if (allowPartial && !result.some(p => p.start < current.stop && p.stop > current.start)) {
    throw failed('No valid current-day programmes; refusing to replace the current EPG');
  }
  const counts = new Map();
  for (const p of result) counts.set(p.channel, (counts.get(p.channel) ?? 0) + 1);
  const manifest = {
    generatedAt: new Date().toISOString(), referenceDate: today, source: HOME,
    sources: [...new Set([HOME, ...channels.flatMap(c => c.sourceUrls ?? (c.url ? [c.url] : []))])],
    ...(source.provincialCoverage ? { provincialCoverage: source.provincialCoverage } : {}),
    format: 'XMLTV', channelSchemaVersion: 2, encoding: 'UTF-8', timezone: 'Asia/Shanghai', logoFormat: 'PNG',
    partial: failures.length > 0 || warnings.length > 0, failures, warnings,
    requestedDates: { from: first, to: last },
    channelCount: channels.length, programmeCount: result.length,
    channelsWithProgrammes: counts.size, todayChannelCoverage: coverage,
    earliestStart: new Date(result.reduce((min, p) => Math.min(min, p.start), Infinity) * 1000).toISOString(),
    latestStop: new Date(result.reduce((max, p) => Math.max(max, p.stop), -Infinity) * 1000).toISOString(),
    requestCount: tasks.length + scheduleRechecks.reduce((sum, r) => sum + r.requestCount, 0),
    emptySchedules: empty.sort((a, b) => a.channel.localeCompare(b.channel) || a.date.localeCompare(b.date)),
    scheduleRechecks,
    discardedProgrammes: discarded.sort((a, b) => a.date.localeCompare(b.date) || a.channel.localeCompare(b.channel) ||
      a.start - b.start || String(a.programId).localeCompare(String(b.programId))),
    missingToday: channels.filter(c => !todayChannels.has(c.id)).map(c => ({ id: c.id, name: c.name })),
  };
  return { channels, programmes: result, manifest };
}

export function renderXml(channels, programmes, { sourceName = channels.some(c => c.source === 'provincial') ? '央视频 / 央视网 / 省级 EPG' : '央视频' } = {}) {
  const doc = create({ version: '1.0', encoding: 'UTF-8' });
  const tv = doc.ele('tv', {
    'generator-info-name': 'autoEPG', 'generator-info-url': 'https://github.com/TvWasm/autoEPG',
    'source-info-name': sourceName, 'source-info-url': HOME,
  });
  const ids = new Set();
  const ordered = groupedChannels(channels);
  for (const c of ordered) {
    if (ids.has(c.id)) throw new Error(`Duplicate channel ${c.id}`);
    ids.add(c.id);
    const channel = tv.ele('channel', { id: c.id });
    for (const name of new Set([c.name, ...(c.aliases ?? [])])) {
      channel.ele('display-name', { lang: 'zh' }).txt(cleanText(name));
    }
    if (/^https?:\/\//.test(c.logo)) channel.ele('icon', { src: c.logo });
    channel.ele('url').txt(c.url ?? `${HOME}?pid=${c.pid}`);
  }
  const rank = new Map(ordered.map((c, i) => [c.id, i]));
  for (const p of [...programmes].sort((a, b) => rank.get(a.channel) - rank.get(b.channel) || a.start - b.start)) {
    if (!ids.has(p.channel)) throw new Error(`Unknown channel ${p.channel}`);
    tv.ele('programme', { start: xmltvTime(p.start), stop: xmltvTime(p.stop), channel: p.channel })
      .ele('title', /\p{Script=Han}/u.test(p.title) ? { lang: 'zh' } : {}).txt(cleanText(p.title));
  }
  return doc.end({ prettyPrint: true }) + '\n';
}

export async function writeArtifacts(directory, dataset) {
  const releases = [];
  const { from, to } = dataset.manifest.requestedDates;
  const start = windowFor(from, 0, 0).start;
  const stop = windowFor(to, 0, 0).stop;
  for (let day = start; day < stop; day += DAY) {
    const date = dateKey(day);
    const programmes = dataset.programmes.filter(p => p.start < day + DAY && p.stop > day);
    if (!programmes.length) continue;
    const xml = Buffer.from(renderXml(dataset.channels, programmes));
    const manifest = {
      ...dataset.manifest, date, requestedDates: { from: date, to: date }, programmeCount: programmes.length,
      channelsWithProgrammes: new Set(programmes.map(p => p.channel)).size,
      earliestStart: new Date(programmes.reduce((min, p) => Math.min(min, p.start), Infinity) * 1000).toISOString(),
      latestStop: new Date(programmes.reduce((max, p) => Math.max(max, p.stop), -Infinity) * 1000).toISOString(),
      emptySchedules: dataset.manifest.emptySchedules.filter(s => s.date === date),
      discardedProgrammes: (dataset.manifest.discardedProgrammes ?? []).filter(p => dateKey(p.start) === date),
      xmlBytes: xml.length,
    };
    const files = { 'epg.xml': xml };
    manifest.variants = [{ file: 'epg.xml', days: 1, from: date, to: date, programmeCount: programmes.length, bytes: xml.length }];
    if (date === dataset.manifest.referenceDate) {
      for (const days of [2, 3]) {
        const end = day + days * DAY;
        // A short, explicitly requested local window must not masquerade as 2/3 days.
        if (end > stop) continue;
        const combined = dataset.programmes.filter(p => p.start < end && p.stop > day);
        const name = `epg${days}.xml`;
        files[name] = Buffer.from(renderXml(dataset.channels, combined));
        manifest.variants.push({ file: name, days, from: date, to: dateKey(end - 1),
          programmeCount: combined.length, bytes: files[name].length });
      }
    }
    const variants = [...manifest.variants];
    const groups = [];
    for (const group of GROUPS) {
      const members = dataset.channels.filter(c => c.groupId === group.id);
      if (!members.length) continue;
      const ids = new Set(members.map(c => c.id));
      const feeds = [];
      for (const variant of variants) {
        const name = groupFile(variant.file, group.id);
        const subset = dataset.programmes.filter(p => ids.has(p.channel) && p.start < day + variant.days * DAY && p.stop > day);
        files[name] = Buffer.from(renderXml(members, subset, { sourceName: group.name }));
        const feed = { file: name, days: variant.days, from: variant.from, to: variant.to,
          programmeCount: subset.length, bytes: files[name].length, groupId: group.id };
        feeds.push(feed);
        manifest.variants.push(feed);
      }
      groups.push({ id: group.id, name: group.name, channelIds: members.map(c => c.id), feeds });
    }
    files['channels.json'] = Buffer.from(JSON.stringify(dataset.channels, null, 2) + '\n');
    if (dataset.manifest.provincialCoverage) {
      files['provincial-coverage.json'] = Buffer.from(JSON.stringify(dataset.manifest.provincialCoverage, null, 2) + '\n');
    }
    files['groups.json'] = Buffer.from(JSON.stringify({ source: '央视频', channelSchemaVersion: 2, groups }, null, 2) + '\n');
    files['manifest.json'] = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    files['SHA256SUMS'] = Buffer.from(Object.entries(files).map(([name, data]) =>
      `${createHash('sha256').update(data).digest('hex')}  ${name}\n`).join(''));
    const folder = join(directory, date);
    await mkdir(folder, { recursive: true });
    for (const [name, data] of Object.entries(files)) {
      const target = join(folder, name);
      await writeFile(`${target}.tmp`, data);
      await rename(`${target}.tmp`, target);
    }
    releases.push({ date, programmeCount: programmes.length, xmlBytes: xml.length, assets: Object.keys(files) });
  }
  await mkdir(directory, { recursive: true });
  const index = { ...dataset.manifest, releases };
  await writeFile(join(directory, 'releases.json.tmp'), JSON.stringify(index, null, 2) + '\n');
  await rename(join(directory, 'releases.json.tmp'), join(directory, 'releases.json'));
  return index;
}
