import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { join } from 'node:path';

export function errorMessage(error) {
  return String(error?.message ?? error).replace(/([?&](?:access_?token|app_secret|sign(?:ature)?|auth_key|token|password)=)[^&\s)]+/gi, '$1[redacted]').slice(0, 2000);
}

export function sourceFailure({ source = 'unknown', sourceName = source, url, phase = 'fetch', channel, date, error }) {
  return { source, sourceName, ...(url ? { url: errorMessage(url) } : {}), phase,
    ...(channel ? { channel: channel.id, channelName: channel.name } : {}),
    ...(date ? { date } : {}), message: errorMessage(error) };
}

export function transportFailure(error) {
  return /HTTP (?:401|403|429|5\d\d)|fetch failed|timeout|timed out|ECONN|ENOTFOUND|ERR_|Executable doesn't exist|browser.*closed/i.test(errorMessage(error));
}

export async function saveRunReport(directory, report) {
  await mkdir(directory, { recursive: true });
  const target = join(directory, 'run-report.json');
  await writeFile(target + '.tmp', JSON.stringify(report, null, 2) + '\n');
  await rename(target + '.tmp', target);
}

export async function loadRunReport(directory) {
  try { return JSON.parse(await readFile(join(directory, 'run-report.json'), 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export function runContext(env = process.env) {
  const base = env.GITHUB_SERVER_URL ?? 'https://github.com';
  return { repository: env.GITHUB_REPOSITORY ?? '',
    runUrl: env.GITHUB_REPOSITORY && env.GITHUB_RUN_ID ? `${base}/${env.GITHUB_REPOSITORY}/actions/runs/${env.GITHUB_RUN_ID}` : '',
    releaseUrl: env.GITHUB_REPOSITORY ? `${base}/${env.GITHUB_REPOSITORY}/releases/latest` : '' };
}
