export type DoctorCheckStatus = 'PASS' | 'WARN' | 'FAIL';

export interface LocalDoctorCheck {
  id: string;
  label: string;
  status: DoctorCheckStatus;
  summary: string;
  detail?: string;
  latencyMs?: number;
  remediation?: string;
}

export interface LocalDoctorResult {
  checkedAt: string;
  durationMs: number;
  score: number;
  overall: 'HEALTHY' | 'WARN' | 'ACTION_NEEDED';
  checks: LocalDoctorCheck[];
}

export function formatLocalDoctorMarkdown(result: LocalDoctorResult): string {
  const statusIcon = (s: DoctorCheckStatus) => (s === 'PASS' ? 'PASS' : s === 'WARN' ? 'WARN' : 'FAIL');
  const overallLabel =
    result.overall === 'HEALTHY'
      ? '健康就绪 (HEALTHY)'
      : result.overall === 'WARN'
        ? '部分待优化 (WARN)'
        : '需立即处理 (ACTION_NEEDED)';

  const lines: string[] = [
    '# TaskFlow 本机 AI 与 MCP 全链路脱敏诊断报告',
    '',
    `- 诊断时间：${result.checkedAt}`,
    `- 总体评分：**${result.score} / 100**（${overallLabel}）`,
    `- 探测总耗时：${result.durationMs} ms`,
    '- 安全声明：本报告已脱敏，不包含任何会话令牌、Cookie、密钥或外部账号凭据。',
    '',
    '## 诊断分项明细',
    '',
    '| 检查项 | 状态 | 耗时 | 结论说明 | 修复建议 |',
    '| --- | --- | --- | --- | --- |',
  ];

  for (const check of result.checks) {
    const latency = typeof check.latencyMs === 'number' ? `${check.latencyMs}ms` : '—';
    const summaryText = [check.summary, check.detail].filter(Boolean).join('；').replace(/\|/g, '\\|');
    const rem = (check.remediation || '—').replace(/\|/g, '\\|');
    lines.push(`| ${check.label} | ${statusIcon(check.status)} | ${latency} | ${summaryText} | ${rem} |`);
  }

  return lines.join('\n');
}
