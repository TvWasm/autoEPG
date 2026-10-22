import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile, readdir, stat } from 'node:fs/promises';
import { join, dirname, resolve, basename } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chromium } from 'playwright';
import { gdtvProgrammes, yntvProgrammes } from '../src/official.js';
import { normalize, deduplicate } from '../src/epg.js';
import { errorMessage } from '../src/diagnostics.js';

const { values } = parseArgs({ options: {
  mode: { type: 'string' }, rounds: { type: 'string', default: '3' },
  date: { type: 'string', default: new Date(Date.now() + 28800000).toISOString().slice(0, 10) },
  output: { type: 'string', default: 'output/browser-benchmark' },
} });
const modes = ['http', 'shell', 'chromium', 'hybrid'];
const dates = [-1, 0, 1].map(delta => new Date(Date.parse(values.date + 'T00:00:00Z') + delta * 86400000).toISOString().slice(0, 10));
const webHeaders = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36' };

async function directoryBytes(path) {
  let total = 0;
  for (const item of await readdir(path, { withFileTypes: true })) {
    const name = join(path, item.name);
    if (item.isDirectory()) total += await directoryBytes(name);
    else if (item.isFile()) total += (await stat(name)).size;
  }
  return total;
}

async function browserMemory(browsers) {
  const pids = new Set();
  for (const browser of browsers) {
    const cdp = await browser.newBrowserCDPSession();
    try { for (const process of (await cdp.send('SystemInfo.getProcessInfo')).processInfo) pids.add(process.id); }
    finally { await cdp.detach(); }
  }
  if (!pids.size) return 0;
  if (process.platform === 'win32') {
    const ps = join(process.env.SystemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const result = execFileSync(ps, ['-NoProfile', '-Command',
      `(Get-Process -Id ${[...pids].map(Number).join(',')} -ErrorAction SilentlyContinue | Measure-Object WorkingSet64 -Sum).Sum`],
    { windowsHide: true, encoding: 'utf8' });
    return Number(result.trim());
  }
  let rss = 0;
  for (const pid of pids) {
    const info = await readFile(`/proc/${Number(pid)}/status`, 'utf8').catch(() => '');
    rss += Number(info.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024;
  }
  return rss;
}

async function trial(mode) {
  const started = performance.now(), browsers = [], pages = new Map(), pending = [];
  const metrics = { requests: 0, blocked: 0, responseBytes: 0 };
  const pageFor = async source => {
    if (pages.has(source)) return pages.get(source);
    const promise = (async () => {
      const browser = await chromium.launch({ headless: true, ...(mode === 'chromium' ? { channel: 'chromium' } : {}) });
      browsers.push(browser);
      const page = await browser.newPage();
      page.on('request', () => metrics.requests++);
      page.on('requestfinished', request => pending.push(request.sizes().then(s => metrics.responseBytes += s.responseBodySize).catch(() => {})));
      await page.route('**/*', route => {
        const request = route.request(), url = new URL(request.url()), type = request.resourceType();
        const official = ['gdtv.cn', 'itouchtv.cn'].some(host => url.hostname === host || url.hostname.endsWith('.' + host));
        const block = ['image', 'font', 'media'].includes(type) || /\.m3u8|\.ts(?:\?|$)|\/incrReadCount/.test(url.href) ||
          (source === 'gdtv' && !official && (mode === 'hybrid' || !['script', 'stylesheet'].includes(type))) ||
          (mode === 'hybrid' && type === 'stylesheet');
        if (block) { metrics.blocked++; return route.abort(); }
        return route.continue();
      });
      await page.goto(source === 'gdtv' ? 'https://www.gdtv.cn/tvChannelDetail/43' : 'https://www.yntv.cn/live.html',
        { waitUntil: 'domcontentloaded', timeout: 30000 });
      if (source === 'gdtv') {
        await page.waitForFunction(() => window.webpackJsonp && window.webpackJsonp.push !== Array.prototype.push, undefined, { timeout: 20000 });
        await page.evaluate(() => window.webpackJsonp.push([[], { benchmark: (module, exports, require) => { window.__benchmarkRequire = require; } }, [['benchmark']]]));
        await page.waitForFunction(() => Boolean(window.__benchmarkRequire?.m?.[725]), undefined, { timeout: 20000 });
      }
      return page;
    })();
    pages.set(source, promise);
    return promise;
  };
  const direct = async (url, source) => {
    metrics.requests++;
    const origin = source === 'gdtv' ? 'https://www.gdtv.cn' : 'https://www.yntv.cn';
    const response = await fetch(url, { headers: { ...webHeaders, Referer: origin + '/', Origin: origin }, signal: AbortSignal.timeout(15000) });
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    const text = await response.text(); metrics.responseBytes += Buffer.byteLength(text);
    return JSON.parse(text);
  };
  const options = { cache: new Map(), dates, omittedProgrammes: [],
    gdtvRequest: async url => {
      if (mode === 'http') return direct(url, 'gdtv');
      const page = await pageFor('gdtv');
      return page.evaluate(async url => {
        const headers = await window.__benchmarkRequire(725).default('GET', url, '');
        const response = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }, url);
    },
    yntvRequest: async url => {
      if (['http', 'hybrid'].includes(mode)) return direct(url, 'yntv');
      const page = await pageFor('yntv');
      return page.evaluate(async url => {
        const response = await fetch(url, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        return response.json();
      }, url);
    },
  };
  const cells = [];
  try {
    for (const [source, fn, id] of [['gdtv', gdtvProgrammes, '44'], ['yntv', yntvProgrammes, 'yunnandushi']]) {
      for (const date of dates) {
        try {
          const rows = deduplicate(normalize(await fn(id, date, options), { id: source, pid: id }, date)).sort((a, b) => a.start - b.start || a.stop - b.stop || a.title.localeCompare(b.title));
          if (date === values.date && !rows.length) throw new Error('No published current-day programmes');
          cells.push({ source, date, ok: true, count: rows.length,
            hash: createHash('sha256').update(JSON.stringify(rows)).digest('hex') });
        } catch (error) { cells.push({ source, date, ok: false, error: errorMessage(error) }); }
      }
    }
    const elapsedMs = Math.round(performance.now() - started);
    const browserRssBytes = await browserMemory(browsers).catch(() => null);
    await Promise.allSettled(pending);
    return { mode, elapsedMs, browserRssBytes, browserCount: browsers.length, ...metrics, cells,
      omittedProgrammes: options.omittedProgrammes, nodeRssBytes: process.memoryUsage().rss };
  } finally { await Promise.allSettled(browsers.map(browser => browser.close())); }
}

if (values.mode) {
  if (!modes.includes(values.mode)) throw new Error('Invalid mode');
  const result = await trial(values.mode);
  process.stdout.write(JSON.stringify(result));
} else {
  const rounds = Number(values.rounds);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 6) throw new Error('rounds must be 1..6');
  await mkdir(values.output, { recursive: true });
  const results = [];
  // Rotate trial order to reduce one-sided effects from upstream/network changes.
  for (let round = 0; round < rounds; round++) {
    for (const mode of [...modes.slice(round % modes.length), ...modes.slice(0, round % modes.length)]) {
      const child = spawnSync(process.execPath, [resolve(process.argv[1]), '--mode', mode, '--date', values.date],
        { encoding: 'utf8', timeout: 180000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 });
      let result;
      try { result = JSON.parse(child.stdout); }
      catch { result = { mode, cells: [], error: errorMessage(child.error ?? child.stderr ?? 'Child failed') }; }
      results.push({ round: round + 1, ...result });
      await writeFile(join(values.output, 'results.json'), JSON.stringify({ date: values.date, rounds, dates, results }, null, 2));
      console.log(JSON.stringify({ round: round + 1, mode, elapsedMs: result.elapsedMs, browserMiB: result.browserRssBytes == null ? null : Math.round(result.browserRssBytes / 1048576),
        passed: result.cells.filter(c => c.ok).length, total: result.cells.length, error: result.error }));
    }
  }
  const summaries = modes.map(mode => {
    const trials = results.filter(r => r.mode === mode);
    const times = trials.map(t => t.elapsedMs).filter(Number.isFinite).sort((a, b) => a - b);
    const cells = trials.flatMap(t => t.cells);
    return { mode, medianMs: times[Math.floor(times.length / 2)], maxMs: times.at(-1),
      passed: cells.filter(c => c.ok).length, total: rounds * dates.length * 2,
      maxBrowserMiB: Math.round(Math.max(...trials.map(t => t.browserRssBytes ?? 0)) / 1048576),
      uniqueDataVersions: Object.fromEntries(['gdtv', 'yntv'].flatMap(source => dates.map(date => [source + '/' + date,
        new Set(cells.filter(c => c.ok && c.source === source && c.date === date).map(c => c.hash)).size]))) };
  });
  const fullPath = chromium.executablePath();
  const root = dirname(dirname(dirname(fullPath)));
  const installBytes = {};
  for (const name of (await readdir(root)).filter(n => /^chromium(?:_headless_shell)?-/.test(n))) {
    if (name.endsWith(basename(dirname(dirname(fullPath))).split('-').at(-1))) installBytes[name] = await directoryBytes(join(root, name));
  }
  const report = { platform: process.platform, date: values.date, dates, rounds, summaries, installBytes,
    crossModeDataVersions: Object.fromEntries(['gdtv', 'yntv'].flatMap(source => dates.map(date => [source + '/' + date, new Set(results.flatMap(t => t.cells).filter(c => c.ok && c.source === source && c.date === date).map(c => c.hash)).size]))),
    note: 'Memory is summed browser-process resident memory sampled after the requests, not peak RSS. HTTP GDTV has no signature and is an intentionally incomplete control. Browser candidates use the same parser/validation. Network and source edits can affect results.', results };
  await writeFile(join(values.output, 'results.json'), JSON.stringify(report, null, 2));
  await writeFile(join(values.output, 'summary.txt'), JSON.stringify({ ...report, results: undefined }, null, 2));
  console.log(JSON.stringify(summaries));
}
