import { appendFile } from 'node:fs/promises';
import { loadRunReport, sourceFailure, errorMessage } from './diagnostics.js';
import { notificationReport, needsNotification, notificationSummary } from './notification.js';

try {
  let report, readError;
  try { report = await loadRunReport(process.argv[2] ?? 'dist'); }
  catch (error) { readError = error; }
  const notification = notificationReport(report);
  if (readError) notification.failures.push(sourceFailure({ source: 'run-report', phase: 'report', error: readError }));
  const summary = notificationSummary(notification);
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary + '\n');
  // Details stay in the summary/artifact; source text cannot inject workflow commands.
  if (needsNotification(notification)) {
    console.error(`::error::EPG post-publication check found ${notification.failures.length} failures and ${notification.warnings.length} warnings; publication status: ${notification.publication.status === 'succeeded' ? 'succeeded (published EPG retained)' : 'not confirmed successful'}. See job summary and epg-run-report artifact.`);
    process.exitCode = 1;
  } else console.log('EPG published successfully; no source errors or warnings.');
} catch (error) {
  console.error('Post-publication check failed: ' + errorMessage(error).replace(/[\r\n]/g, ' '));
  process.exitCode = 1;
}
