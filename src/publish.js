import { GitHub, publishDirectory } from './releases.js';
import { loadRunReport, saveRunReport, sourceFailure, runContext } from './diagnostics.js';

const directory = process.argv[2] ?? 'dist';
let report;
let published = false;

try {
  const api = new GitHub(process.env.GITHUB_REPOSITORY, process.env.GH_TOKEN);
  report = await loadRunReport(directory) ?? { schemaVersion: 1, ...runContext(), failures: [], warnings: [] };
  report.publication = { status: 'running' };
  await saveRunReport(directory, report);
  const count = await publishDirectory(api, directory, process.env.GITHUB_SHA ?? 'main', {
    rebuild: process.env.REBUILD_RELEASES === 'true',
  });
  published = true;
  report.publication = { status: 'succeeded', releases: count, finishedAt: new Date().toISOString() };
  await saveRunReport(directory, report);
  console.log(`Published/refreshed ${count} daily releases`);
} catch (error) {
  report ??= await loadRunReport(directory).catch(() => null) ?? { schemaVersion: 1, ...runContext(), failures: [], warnings: [] };
  if (!published) report.publication = { status: 'failed', finishedAt: new Date().toISOString() };
  report.failures.push(sourceFailure({ source: 'github-releases', phase: published ? 'publication-report' : 'publication', error }));
  try { await saveRunReport(directory, report); } catch (writeError) { console.error(`Cannot save publication report: ${writeError.message}`); }
  console.error(report.failures.at(-1).message);
  process.exitCode = 1;
}
