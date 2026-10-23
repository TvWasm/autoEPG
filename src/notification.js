import { errorMessage, runContext, sourceFailure } from './diagnostics.js';

const failed = status => ['failure', 'cancelled', 'timed_out', 'action_required'].includes(status);

export function notificationReport(input, env = process.env) {
  const report = structuredClone(input ?? { schemaVersion: 1, failures: [], warnings: [] });
  report.failures ??= [];
  report.warnings ??= [];
  report.generation ??= { status: 'unknown' };
  report.publication ??= { status: 'unknown' };
  for (const [key, value] of Object.entries(runContext(env))) if (value) report[key] = value;
  if (!input) report.warnings.push({ code: 'missing-run-report', message: '运行报告缺失，无法确认抓取完整性，请查看 Actions 日志。' });
  if (failed(env.EPG_TEST_RESULT)) report.failures.push(sourceFailure({ source: 'tests', phase: 'test', error: '完整测试未通过；省台增强发布可能被跳过，央视频/央视网独立发布结果见本报告。' }));
  if (failed(env.EPG_GENERATION_RESULT)) {
    report.generation.status = 'failed';
    if (!report.failures.some(f => f.phase === 'generation')) report.failures.push(sourceFailure({ source: 'generation', phase: 'generation', error: '抓取/导出作业失败或超时，请查看运行日志。' }));
  }
  if (env.EPG_PUBLICATION_RESULT === 'success') report.publication.status = 'succeeded';
  else if (failed(env.EPG_PUBLICATION_RESULT)) {
    if (report.publication.status !== 'succeeded') report.publication.status = 'failed';
    if (!report.failures.some(f => f.phase === 'publication')) report.failures.push(sourceFailure({ source: 'github-releases', phase: 'publication', error: '发布步骤异常，可能存在尚未完成的日期版本，请查看运行日志。' }));
  } else if (env.EPG_PUBLICATION_RESULT === 'skipped') report.publication.status = 'skipped';
  if (failed(env.EPG_PUBLISH_JOB_RESULT)) {
    report.failures.push(sourceFailure({ source: 'workflow', phase: 'job', error: '发布作业异常结束；若已有成功发布记录，该记录仍然有效。' }));
    if (['pending', 'running'].includes(report.publication.status)) report.publication.status = 'unknown';
  }
  return report;
}

export function needsNotification(report) {
  return report.failures.length > 0 || report.warnings.length > 0 || report.publication.status !== 'succeeded';
}

export function notificationLevel(report, { strict = false } = {}) {
  const fatalPhases = ['test', 'generation', 'publication', 'publication-report', 'job', 'report'];
  if (report.publication.status !== 'succeeded' || !['complete', 'partial'].includes(report.generation.status) ||
      report.warnings.some(w => w.code === 'missing-run-report') ||
      report.failures.some(f => fatalPhases.includes(f.phase))) return 'error';
  return needsNotification(report) ? (strict ? 'error' : 'warning') : 'success';
}

const safe = value => errorMessage(String(value ?? '')).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

export function notificationSummary(report) {
  const labels = { succeeded: '发布完成', failed: '发布未全部完成，请查看日志', skipped: '未执行发布' };
  const lines = ['## EPG 运行报告', '',
    `发布结果：${labels[report.publication.status] ?? '发布结果未确认'}`,
    `生成结果：${safe(report.generation.status)}`,
    `失败/跳过请求：${report.failures.length}；告警：${report.warnings.length}`, ''];
  if (report.publication.status === 'succeeded' && needsNotification(report)) {
    lines.push('正常数据已发布，已发布 EPG 保留。普通源异常默认只告警，不将工作流标记为失败；完整明细见 epg-diagnostics 构件中的 report.html、report.txt 和 report.json。', '');
  }
  // List every failed provider before the bounded detail list: repeated skipped
  // dates from one outage must not hide the causes of later providers.
  for (const [source, failures] of Map.groupBy(report.failures, f => f.sourceName ?? f.source)) {
    const skipped = failures.filter(f => f.phase === 'skipped').length;
    const example = failures.find(f => f.phase !== 'skipped') ?? failures[0];
    const text = `${source}：${failures.length - skipped} 项错误，${skipped} 项跳过；原因：${example.message}`;
    lines.push(...safe(text).split(/\r?\n/).map(line => '    ' + line), '');
  }
  for (const failure of report.failures.slice(0, 100)) {
    const text = `[${failure.phase}] ${failure.sourceName ?? failure.source}${failure.channelName ? ' / ' + failure.channelName : ''}${failure.date ? ' / ' + failure.date : ''}: ${failure.message}`;
    lines.push(...safe(text).split(/\r?\n/).map(line => '    ' + line), '');
  }
  for (const warning of report.warnings) {
    const text = `告警：${warning.message}${warning.channels?.length ? '；涉及频道：' + warning.channels.map(c => c.name ?? c.id).join('、') : ''}`;
    lines.push(...safe(text).split(/\r?\n/).map(line => '    ' + line), '');
  }
  if (report.failures.length > 100) lines.push('其余明细见 epg-diagnostics 构件，完整报告不截断。', '');
  lines.push('可读诊断报告作为 epg-diagnostics 构件保留 14 天。原始 epg-run-report 构件保留 7 天。', '');
  return lines.join('\n');
}
