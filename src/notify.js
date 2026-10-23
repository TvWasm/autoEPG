import { appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadRunReport, sourceFailure, errorMessage } from './diagnostics.js';
import { notificationReport, notificationLevel, notificationSummary } from './notification.js';
import { writeDiagnosticReports } from './report.js';

try {
  let report, readError;
  try { report = await loadRunReport(process.argv[2] ?? 'dist'); }
  catch (error) { readError = error; }
  let env = process.env;
  const core = process.argv[3] ? await loadRunReport(process.argv[3]).catch(() => null) : null;
  if (core?.publication?.status === 'succeeded' && report?.publication?.status !== 'succeeded') {
    const enhancement = report;
    report = core;
    report.warnings.push({ code: 'core-publication-retained', message: '完整省台更新未完成，央视频/央视网优先发布已完成且可用。' });
    for (const failure of enhancement?.failures ?? []) report.failures.push({ ...failure, originalPhase: failure.phase, phase: 'enhancement' });
    env = { ...process.env, EPG_PUBLISH_JOB_RESULT: process.env.EPG_CORE_JOB_RESULT,
      EPG_GENERATION_RESULT: process.env.EPG_CORE_GENERATION_RESULT, EPG_PUBLICATION_RESULT: process.env.EPG_CORE_PUBLICATION_RESULT };
    readError = null;
  }
  const notification = notificationReport(report, env);
  if (readError) notification.failures.push(sourceFailure({ source: 'run-report', phase: 'report', error: readError }));
  const level = notificationLevel(notification, { strict: process.env.EPG_STRICT_SOURCE_ALERTS?.toLowerCase() === 'true' });
  const diagnostics = await writeDiagnosticReports(join(process.argv[2] ?? 'dist', 'diagnostics'), notification, level);
  const summary = notificationSummary(notification);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  // Prefix every detail line so upstream text cannot inject workflow commands.
  console.log(diagnostics.text.split('\n').map(line => '  ' + line).join('\n'));
  if (level !== 'success') {
    console.error(`::${level}::EPG publication ${notification.publication.status === 'succeeded' ? 'succeeded; published EPG retained' : 'not confirmed successful'}; ${diagnostics.sources.length} affected sources, ${notification.warnings.length} quality warnings. Full details: epg-diagnostics/report.html and report.txt.`);
  } else console.log('EPG published successfully; no source errors or warnings.');
  if (level === 'error') process.exitCode = 1;
} catch (error) {
  console.error('Post-publication check failed: ' + errorMessage(error).replace(/[\r\n]/g, ' '));
  process.exitCode = 1;
}
