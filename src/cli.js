import { parseArgs } from 'node:util';
import { EpgSources } from './cctv.js';
import { collect, dateKey, windowFor, writeArtifacts } from './epg.js';
import { saveRunReport, runContext, sourceFailure } from './diagnostics.js';
import { FallbackSource, loadPublishedFallback } from './fallback.js';

let output = 'dist', source;
const report = { schemaVersion: 1, startedAt: new Date().toISOString(), ...runContext(),
  generation: { status: 'running' }, publication: { status: 'pending' }, failures: [], warnings: [] };

try {
  const { values } = parseArgs({ options: {
    output: { type: 'string', default: 'dist' },
    date: { type: 'string', default: dateKey(Date.now() / 1000) },
    'past-days': { type: 'string', default: '3' },
    'future-days': { type: 'string', default: '3' },
    concurrency: { type: 'string', default: '4' },
    'min-channels': { type: 'string', default: '50' },
    'min-today-coverage': { type: 'string', default: '0.9' },
    strict: { type: 'boolean', default: false },
    'core-only': { type: 'boolean', default: false },
    'fallback-repository': { type: 'string', default: process.env.GITHUB_REPOSITORY ?? '' },
    help: { type: 'boolean', default: false },
  } });
  if (values.help) {
    console.log('npm run generate -- [--output dist] [--date YYYY-MM-DD] [--past-days 3] [--future-days 3] [--concurrency 4] [--min-channels 50] [--min-today-coverage 0.9] [--strict] [--core-only] [--fallback-repository owner/repo]');
  } else {
    output = values.output;
    report.referenceDate = values.date;
    await saveRunReport(output, report);
    const integer = (key, min, max) => {
      const value = Number(values[key]);
      if (!Number.isInteger(value) || value < min || value > max) throw new Error(`--${key} must be ${min}..${max}`);
      return value;
    };
    const minTodayCoverage = Number(values['min-today-coverage']);
    if (!Number.isFinite(minTodayCoverage) || minTodayCoverage <= 0 || minTodayCoverage > 1) {
      throw new Error('--min-today-coverage must be greater than 0 and at most 1');
    }
    const pastDays = integer('past-days', 0, 7), futureDays = integer('future-days', 0, 7);
    const range = windowFor(values.date, pastDays, futureDays);
    const dates = [];
    for (let day = range.start - 86400; day < range.stop; day += 86400) dates.push(dateKey(day));
    console.log(`Fetching ${values['core-only'] ? 'priority Yangshipin/CCTV' : 'Yangshipin, CCTV and provincial'} schedules for ${values.date} (Asia/Shanghai)`);
    const allowPartial = !values.strict;
    let fallback = { snapshots: [], warnings: [] };
    if (allowPartial && values['fallback-repository']) {
      fallback = await loadPublishedFallback(values['fallback-repository'], dates.filter(d => d >= values.date));
      console.log(`Validated ${fallback.snapshots.length} previously published daily fallback snapshots`);
    }
    source = new EpgSources({ dates, allowPartial,
      provincial: values['core-only'] ? null : new (await import('./provincial.js')).Provincial({ dates, today: values.date,
        allowPartial,
        onProgress: (done, total) => { if (done % 100 === 0 || done === total) console.log(`Official provincial schedules ${done}/${total}`); },
      }),
    });
    if (allowPartial && values['fallback-repository']) source = new FallbackSource(source, fallback.snapshots, { dates });
    const dataset = await collect(source, {
      today: values.date, pastDays, futureDays,
      concurrency: integer('concurrency', 1, 8), minChannels: integer('min-channels', 1, 1000),
      minTodayCoverage,
      allowPartial,
      onProgress: (done, total) => { if (done % 50 === 0 || done === total) console.log(`Schedules ${done}/${total}`); },
    });
    dataset.manifest.fallbackUsage = [...(source.usage?.values() ?? [])];
    dataset.manifest.publicationTier = values['core-only'] ? 'core' : 'full';
    dataset.manifest.warnings.push(...fallback.warnings);
    for (const warning of source.source?.warnings ?? source.warnings ?? []) {
      if (!dataset.manifest.warnings.some(w => JSON.stringify(w) === JSON.stringify(warning))) dataset.manifest.warnings.push(warning);
    }
    if (dataset.manifest.fallbackUsage.length) dataset.manifest.warnings.push({ code: 'cached-schedules',
      message: `使用 ${dataset.manifest.fallbackUsage.length} 个同频道同日期已发布节目单作为兜底，详见 manifest.json fallbackUsage` });
    dataset.manifest.partial ||= dataset.manifest.warnings.length > 0;
    if (dataset.manifest.discardedProgrammes.length) {
      console.warn(`Skipped ${dataset.manifest.discardedProgrammes.length} zero-duration programme records; details in manifest.json discardedProgrammes`);
    }
    if (dataset.manifest.provincialCoverage?.unavailable.length) {
      console.warn(`Provincial channels without available schedules: ${dataset.manifest.provincialCoverage.unavailable.map(c => c.name).join(', ')}; see provincial-coverage.json`);
    }
    if (dataset.manifest.provincialCoverage?.omittedProgrammes.length) {
      console.warn(`Omitted ${dataset.manifest.provincialCoverage.omittedProgrammes.length} official placeholders or unresolvable intervals; see provincial-coverage.json omittedProgrammes`);
    }
    if (dataset.manifest.scheduleRechecks.length) {
      console.warn(`Processed ${dataset.manifest.scheduleRechecks.length} conflict recheck event(s); see manifest.json scheduleRechecks`);
    }
    if (dataset.manifest.provincialCoverage?.combinedProgrammes.length) {
      console.warn(`Combined ${dataset.manifest.provincialCoverage.combinedProgrammes.length} official blocks with identical intervals and multiple titles; see provincial-coverage.json combinedProgrammes`);
    }
    const index = await writeArtifacts(output, dataset);
    report.generation = { status: dataset.manifest.partial ? 'partial' : 'complete', channelCount: dataset.manifest.channelCount,
      programmeCount: dataset.manifest.programmeCount, todayCoverage: dataset.manifest.todayChannelCoverage, requestedDates: dataset.manifest.requestedDates };
    report.failures = dataset.manifest.failures;
    report.warnings = dataset.manifest.warnings;
    report.fallbackUsage = dataset.manifest.fallbackUsage;
    report.publicationTier = dataset.manifest.publicationTier;
    report.generatedAt = dataset.manifest.generatedAt;
    await saveRunReport(output, report);
    if (report.failures.length) console.warn(`Partial EPG generated with ${report.failures.length} failed/skipped source request(s); see run-report.json and manifest.json`);
    console.log(JSON.stringify(index, (key, value) => key === 'provincialCoverage'
      ? { targetCount: value.targetCount, existingCount: value.existingCount,
        importedCount: value.importedCount, unavailableCount: value.unavailable.length,
        omittedProgrammeCount: value.omittedProgrammes.length, combinedProgrammeCount: value.combinedProgrammes.length }
      : value, 2));
  }
} catch (error) {
  report.generation = { ...report.generation, status: 'failed' };
  report.publication = { status: 'skipped' };
  report.failures = [...new Map([...(error.failures ?? []), ...(source?.failures ?? []),
    sourceFailure({ source: 'generation', phase: 'generation', error })].map(f => [JSON.stringify(f), f])).values()];
  report.warnings = error.warnings ?? source?.warnings ?? [];
  try { await saveRunReport(output, report); } catch (writeError) { console.error(`Cannot save run report: ${writeError.message}`); }
  console.error(report.failures.at(-1).message);
  process.exitCode = 1;
}
