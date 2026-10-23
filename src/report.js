import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { errorMessage } from './diagnostics.js';

const escapeHtml = text => String(text ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const statuses = { succeeded: '发布成功', failed: '发布失败', skipped: '未执行发布', unknown: '发布结果未确认' };

export function failureHint(failure) {
  if (failure.phase === 'skipped') return '因前面的连续网络失败而熔断跳过，并非再次请求失败；先查看本源首个错误。';
  if (/HTTP 403/.test(failure.message)) return '源站拒绝访问。需检查源站访问策略、请求头及运行器出口；仅凭 403 不能确定具体限制。';
  if (/timeout|timed out|ETIMEDOUT/i.test(failure.message)) return '连接或响应超时。检查源站可用性、运行器网络及出口位置；本机成功不代表运行器可达。';
  if (/ENOTFOUND|EAI_AGAIN/i.test(failure.message)) return '域名解析失败，检查 DNS 和域名状态。';
  if (/CERT|TLS|SSL/i.test(failure.message)) return 'TLS/证书问题，检查源站证书、域名和系统时间。';
  if (/Failed to fetch/i.test(failure.message)) return '浏览器网络或跨域请求失败，查看官方 HTTP 备用请求是否也失败。';
  if (/conflict|mismatch|Invalid/i.test(failure.message)) return '返回数据未通过频道、日期、时间或结构校验，该批次已隔离。';
  return '查看原始错误与发生阶段；不要用其他频道或旧日期的节目代替。';
}

export function reportSources(report) {
  return [...Map.groupBy(report.failures, f => f.source ?? 'unknown')].map(([id, records]) => ({
    id, name: records[0].sourceName ?? id, records,
    failed: records.filter(r => r.phase !== 'skipped').length,
    skipped: records.filter(r => r.phase === 'skipped').length,
    channels: [...new Set(records.map(r => r.channelName ?? r.channel).filter(Boolean))],
    dates: [...new Set(records.map(r => r.date).filter(Boolean))].sort(),
  }));
}

export async function writeDiagnosticReports(directory, input, level) {
  // Reapply redaction to every string, including reports from earlier runs.
  const report = JSON.parse(JSON.stringify(input, (_key, value) => typeof value === 'string' ? errorMessage(value) : value));
  const sources = reportSources(report);
  const status = statuses[report.publication.status] ?? '发布结果未确认';
  const lines = ['autoEPG 详细诊断报告', `检查级别：${level}`, `发布结果：${status}`,
    `生成结果：${report.generation.status}；频道：${report.generation.channelCount ?? '未知'}；节目：${report.generation.programmeCount ?? '未知'}`,
    `运行：${report.runUrl ?? ''}`, `版本：${report.releaseUrl ?? ''}`,
    '注意：熔断跳过的日期单独统计，不等同于再次请求失败。', ''];
  for (const source of sources) {
    lines.push(`=== ${source.name} (${source.id}) ===`, `实际错误记录 ${source.failed}；熔断跳过 ${source.skipped}`,
      `涉及频道：${source.channels.join('、') || '未知'}`, `涉及日期：${source.dates.join('、') || '未知'}`, '');
    for (const failure of source.records) lines.push(
      `[${failure.phase}] ${failure.channelName ?? failure.channel ?? '源级别'} / ${failure.date ?? '-'}`,
      `接口：${failure.url ?? '-'}`, `原因：${failure.message}`, `排查：${failureHint(failure)}`, '');
  }
  for (const warning of report.warnings) lines.push(`告警 [${warning.code ?? 'warning'}]：${warning.message}`,
    `涉及频道：${warning.channels?.map(c => c.name ?? c.id).join('、') || '-'}`, JSON.stringify(warning, null, 2), '');
  for (const cached of report.fallbackUsage ?? []) lines.push(`同日兜底：${cached.channelName ?? cached.channel} / ${cached.date}`,
    `原始抓取时间：${cached.generatedAt.join('、')}；节目数：${cached.programmeCount}`,
    `原因：${cached.reason}`, `已发布版本：${cached.releases.join('、')}`, '');
  const text = lines.join('\n') + '\n';
  const rows = source => source.records.map(f => `<tr><td>${escapeHtml(f.channelName ?? f.channel ?? '源级别')}</td><td>${escapeHtml(f.date ?? '-')}</td><td>${escapeHtml(f.phase)}</td><td><pre>${escapeHtml(f.message)}</pre><small>${escapeHtml(failureHint(f))}</small><pre>${escapeHtml(f.url ?? '')}</pre></td></tr>`).join('');
  const html = `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>autoEPG 详细诊断报告</title>
<style>body{max-width:1200px;margin:32px auto;padding:0 20px;font:16px/1.6 system-ui,sans-serif;color:#17202a;background:#f6f7f9}section,header{background:white;border:1px solid #dbe1e7;border-radius:10px;padding:20px;margin:16px 0}h1,h2{line-height:1.3}table{border-collapse:collapse;width:100%}td,th{padding:10px;text-align:left;border-bottom:1px solid #dbe1e7;vertical-align:top}pre{white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 8px;font-size:13px}small{color:#475569}.badge{font-weight:bold;color:${level === 'error' ? '#b91c1c' : level === 'warning' ? '#92400e' : '#166534'}}summary{cursor:pointer;font-weight:bold}a{overflow-wrap:anywhere}</style>
<header><h1>autoEPG 详细诊断报告</h1><p class="badge">${escapeHtml(status)} · ${escapeHtml(level)}</p><p>频道 ${escapeHtml(report.generation.channelCount ?? '未知')} · 节目 ${escapeHtml(report.generation.programmeCount ?? '未知')} · 告警 ${report.warnings.length}</p><p>本页包含完整记录，不受 Actions 摘要 100 项明细限制。普通源异常不等于发布失败；熔断跳过并非重复请求失败。</p><pre>运行：${escapeHtml(report.runUrl ?? '')}\n版本：${escapeHtml(report.releaseUrl ?? '')}</pre><table><thead><tr><th>来源（点击查看）</th><th>错误记录</th><th>熔断跳过</th><th>涉及频道</th></tr></thead><tbody>${sources.map((s, i) => `<tr><td><a href="#source-${i}">${escapeHtml(s.name)}</a></td><td>${s.failed}</td><td>${s.skipped}</td><td>${s.channels.length}</td></tr>`).join('')}</tbody></table></header>
${sources.map((s, i) => `<section id="source-${i}"><h2>${escapeHtml(s.name)}</h2><p>实际错误记录 ${s.failed} · 熔断跳过 ${s.skipped}</p><p>频道：${escapeHtml(s.channels.join('、'))}<br>日期：${escapeHtml(s.dates.join('、'))}</p><details><summary>查看全部 ${s.records.length} 项记录</summary><table><thead><tr><th>频道</th><th>日期</th><th>阶段</th><th>错误、接口及排查建议</th></tr></thead><tbody>${rows(s)}</tbody></table></details></section>`).join('')}
<section><h2>同频道同日期兜底</h2><details><summary>查看 ${(report.fallbackUsage ?? []).length} 个缓存批次及原始抓取时间</summary><pre>${escapeHtml(JSON.stringify(report.fallbackUsage ?? [], null, 2))}</pre></details></section>
<section><h2>质量告警</h2>${report.warnings.map(w => `<details open><summary>${escapeHtml(w.message)}</summary><pre>${escapeHtml(JSON.stringify(w, null, 2))}</pre></details>`).join('') || '<p>无</p>'}</section></html>`;
  await mkdir(directory, { recursive: true });
  await Promise.all([writeFile(join(directory, 'report.html'), html), writeFile(join(directory, 'report.txt'), text),
    writeFile(join(directory, 'report.json'), JSON.stringify({ ...report, checkLevel: level }, null, 2) + '\n')]);
  return { text, sources };
}
