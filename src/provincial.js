import { readFileSync } from 'node:fs';
import { OFFICIAL_ADAPTERS } from './official.js';
import { sourceFailure, transportFailure } from './diagnostics.js';
export { cztvProgrammes } from './official.js';

export const PROVINCIAL_CATALOGUE = JSON.parse(readFileSync(new URL('./provincial-channels.json', import.meta.url), 'utf8'));

export class Provincial {
  constructor({ dates, today, catalogue = PROVINCIAL_CATALOGUE, adapters = OFFICIAL_ADAPTERS, allowPartial = false, ...options }) {
    this.dates = dates;
    this.today = today;
    this.catalogue = catalogue;
    this.adapters = adapters;
    this.options = { ...options, dates, today, cache: new Map(), resources: [], omittedProgrammes: [], combinedProgrammes: [] };
    this.rows = new Map();
    this.report = null;
    this.allowPartial = allowPartial;
    this.failures = [];
    this.warnings = [];
  }
  async channels(existing = []) {
    this.rows.clear();
    this.failures.length = 0;
    this.warnings.length = 0;
    this.options.omittedProgrammes.length = 0;
    this.options.combinedProgrammes.length = 0;
    const selected = this.catalogue.channels.filter(entry => entry.native && this.adapters[entry.native.type]);
    const tasks = selected.flatMap(entry => this.dates.map(date => ({ entry, date })));
    const native = new Map(selected.map(entry => [entry.id, new Map()]));
    const brokenSources = new Map();
    let next = 0, completed = 0;
    try { const workers = await Promise.allSettled(Array.from({ length: Math.min(4, tasks.length) }, async () => {
      while (next < tasks.length) {
        const { entry, date } = tasks[next++];
        const adapter = this.adapters[entry.native.type];
        if (this.allowPartial && (brokenSources.get(entry.native.type) ?? 0) >= 3) {
          this.failures.push(sourceFailure({ source: entry.native.type, sourceName: adapter.name, url: adapter.source,
            phase: 'skipped', channel: entry, date, error: 'Source circuit open after 3 consecutive transport failures; skipped remaining requests for this run' }));
          this.options.onProgress?.(++completed, tasks.length);
          continue;
        }
        let rows;
        try { rows = await adapter.programmes(entry.native.channelId, date, { ...this.options, channel: entry }); }
        catch (error) {
          if (transportFailure(error)) brokenSources.set(entry.native.type, (brokenSources.get(entry.native.type) ?? 0) + 1);
          this.failures.push(sourceFailure({ source: entry.native.type, sourceName: adapter.name, url: adapter.source, channel: entry, date, error }));
          if (!this.allowPartial) throw new Error(`${entry.name}/${date}: ${error.message}`, { cause: error });
          this.options.onProgress?.(++completed, tasks.length);
          continue;
        }
        brokenSources.set(entry.native.type, 0);
        if (rows.length) native.get(entry.id).set(date, rows);
        this.options.onProgress?.(++completed, tasks.length);
      }
    }));
      const failure = workers.find(worker => worker.status === 'rejected');
      if (failure) throw failure.reason;
    } finally {
      const closed = await Promise.allSettled(this.options.resources.map(resource => resource.close()));
      for (const result of closed) if (result.status === 'rejected') {
        this.failures.push(sourceFailure({ source: 'provincial-browser', phase: 'cleanup', error: result.reason }));
        if (!this.allowPartial) throw result.reason;
      }
      this.options.cache.clear();
      this.options.resources.length = 0;
    }
    const result = [], coverage = [];
    for (const entry of this.catalogue.channels) {
      const current = existing.find(channel => channel.id === entry.id);
      const page = entry.urls.find(url => !url.includes('yangshipin.cn')) ?? entry.urls[0];
      const adapter = this.adapters[entry.native?.type];
      const byDate = native.get(entry.id) ?? new Map();
      const dates = [...byDate.keys()].sort();
      for (const [date, rows] of byDate) this.rows.set(entry.id + '/' + date, rows);
      if (current) {
        current.aliases = [...new Set([...current.aliases, ...entry.aliases])];
        if (dates.length) {
          current.source = 'provincial';
          current.sourceId = entry.native.type;
          current.sourceName = adapter.name;
          current.sourceUrls = [adapter.source, 'https://www.yangshipin.cn/tv/home'];
          current.url = page;
          current.dates = [...new Set([...current.dates, ...dates])].sort();
        }
        coverage.push({ id: entry.id, name: entry.name, province: entry.province, status: 'existing', officialPage: page,
          ...(adapter ? { source: adapter.source, officialDates: dates, selection: 'broadcaster-first-per-date' } : {}) });
        continue;
      }
      const failed = this.failures.filter(f => f.channel === entry.id);
      const status = dates.length ? 'imported' : failed.length ? 'fetch-failed' : adapter ? 'no-published-schedule' : 'official-adapter-pending';
      coverage.push({ id: entry.id, name: entry.name, province: entry.province, status, dates, officialPage: page,
        ...(adapter ? { source: adapter.source } : {}), ...(failed.length ? { failedDates: [...new Set(failed.map(f => f.date))].sort() } : {}) });
      if (!dates.length) continue;
      result.push({ id: entry.id, pid: entry.id, name: entry.name, aliases: entry.aliases,
        source: 'provincial', sourceId: entry.native.type, sourceName: adapter.name, sourceUrls: [adapter.source],
        url: page, logo: '', dates, province: entry.province,
        groupId: 'provincial', group: '省级频道', order: 1000, legacyIds: [],
      });
    }
    this.report = { catalogue: this.catalogue.source, checkedAt: this.catalogue.checkedAt, generatedAt: new Date().toISOString(),
      policy: 'official-broadcaster-websites-only',
      sources: [...new Set(selected.map(entry => this.adapters[entry.native.type]))].map(({ name, source }) => ({ name, url: source })),
      targetCount: coverage.length, existingCount: coverage.filter(c => c.status === 'existing').length,
      importedCount: result.length, unavailable: coverage.filter(c => !['existing', 'imported'].includes(c.status)),
      channels: coverage, omittedProgrammes: this.options.omittedProgrammes, combinedProgrammes: this.options.combinedProgrammes,
      failures: this.failures, warnings: this.warnings,
    };
    const invalidIntervals = this.options.omittedProgrammes.filter(p => p.reason === 'official-duration-exceeds-day');
    if (invalidIntervals.length) this.warnings.push({ code: 'official-invalid-interval',
      message: `${invalidIntervals.length} invalid official programme interval(s) were quarantined; original times are recorded in provincial-coverage.json`, records: invalidIntervals });
    const required = selected.filter(entry => entry.native.required !== false);
    const todayCount = required.filter(entry => native.get(entry.id)?.has(this.today)).length;
    if (this.allowPartial && this.today && todayCount < required.length) {
      const missing = required.filter(entry => !native.get(entry.id)?.has(this.today));
      this.warnings.push({ code: 'provincial-missing-today', message: `${missing.length} configured official channel(s) have no current-day schedule`,
        channels: missing.map(c => ({ id: c.id, name: c.name })) });
    }
    if (required.length && this.today && todayCount / required.length < 0.9) {
      const message = 'Official provincial current-day coverage is below 90%';
      if (!this.allowPartial) throw new Error(message + '; refusing a partial publication');
      this.warnings.push({ code: 'provincial-today-coverage', message, available: todayCount, expected: required.length });
    }
    return result;
  }
  programmes(channel, date) { return this.rows.get(channel.id + '/' + date) ?? []; }
  hasSchedule(channel, date) { return this.rows.has(channel.id + '/' + date); }
  async refreshProgrammes(channel, date) {
    const entry = this.catalogue.channels.find(c => c.id === channel.id);
    const adapter = this.adapters[entry?.native?.type];
    if (!adapter) throw new Error(`No official adapter for ${channel.id}`);
    const options = { ...this.options, dates: [date], channel: entry,
      cache: new Map(), resources: [], omittedProgrammes: [], combinedProgrammes: [] };
    let rows;
    try { rows = await adapter.programmes(entry.native.channelId, date, options); }
    finally { await Promise.all(options.resources.map(resource => resource.close())); }
    const key = channel.id + '/' + date;
    if (rows.length) this.rows.set(key, rows); else this.rows.delete(key);
    for (const field of ['omittedProgrammes', 'combinedProgrammes']) {
      const audit = this.options[field];
      for (let i = audit.length - 1; i >= 0; i--) if (audit[i].channel === channel.id && audit[i].date === date) audit.splice(i, 1);
      audit.push(...options[field]);
    }
    const dates = [...this.rows.keys()].filter(k => k.startsWith(channel.id + '/')).map(k => k.slice(channel.id.length + 1)).sort();
    const coverage = this.report.channels.find(c => c.id === channel.id);
    if (coverage.status === 'existing') coverage.officialDates = dates;
    else {
      channel.dates = dates;
      coverage.dates = dates;
      coverage.status = dates.length ? 'imported' : 'no-published-schedule';
    }
    this.report.importedCount = this.report.channels.filter(c => c.status === 'imported').length;
    this.report.unavailable = this.report.channels.filter(c => !['existing', 'imported'].includes(c.status));
    (this.report.scheduleRefreshes ??= []).push({ channel: channel.id, date, programmeCount: rows.length, refreshedAt: new Date().toISOString() });
    return rows;
  }
}
