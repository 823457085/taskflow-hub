import type { Finding, ReviewJob, WorkTask } from './workspaceApi.ts';
import { stageLabel, toolLabel } from './displayLabels.ts';

export interface ParsedFindingLocation {
  uri: string;
  startLine?: number;
  endLine?: number;
  startColumn?: number;
}

export function parseFindingLocation(rawLocation?: string | null): ParsedFindingLocation | null {
  if (!rawLocation || typeof rawLocation !== 'string') return null;
  let cleaned = rawLocation.trim().replace(/^file:\/\//i, '');
  if (!cleaned || /[\r\n\x00]/.test(cleaned)) return null;

  let startLine: number | undefined;
  let endLine: number | undefined;
  let startColumn: number | undefined;

  // Match #L12-L20 or #L12
  const hashMatch = cleaned.match(/^(.*?)#L(\d+)(?:-L?(\d+))?$/i);
  if (hashMatch) {
    cleaned = hashMatch[1];
    startLine = Number(hashMatch[2]);
    if (hashMatch[3]) endLine = Number(hashMatch[3]);
  } else {
    // Match path:line:col or path:line-endLine
    const colonMatch = cleaned.match(/^(.*?):(\d+)(?::(\d+)|-(\d+))?$/);
    if (colonMatch) {
      cleaned = colonMatch[1];
      startLine = Number(colonMatch[2]);
      if (colonMatch[3]) startColumn = Number(colonMatch[3]);
      if (colonMatch[4]) endLine = Number(colonMatch[4]);
    }
  }

  const normalized = cleaned.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (segments.length === 0 || segments.includes('..')) return null;

  return {
    uri: segments.join('/'),
    ...(startLine && startLine > 0 ? { startLine } : {}),
    ...(endLine && startLine && endLine >= startLine ? { endLine } : {}),
    ...(startColumn && startColumn > 0 ? { startColumn } : {}),
  };
}

export function buildSarifLogFromReview(params: {
  task: Pick<WorkTask, 'id' | 'jiraKey' | 'title'>;
  job: Pick<ReviewJob, 'id' | 'stage' | 'inputHash' | 'report' | 'findings'>;
}) {
  const { task, job } = params;
  const toSarifLevel = (sev: Finding['severity']): 'error' | 'warning' | 'note' =>
    sev === 'CRITICAL' ? 'error' : sev === 'WARN' ? 'warning' : 'note';

  const rules = job.findings.map((finding, idx) => ({
    id: `TF-${job.stage}-${String(idx + 1).padStart(3, '0')}`,
    name: finding.severity,
    shortDescription: { text: finding.title },
    properties: {
      stage: job.stage,
      severity: finding.severity,
    },
  }));

  const results = job.findings.map((finding, idx) => {
    const ruleId = rules[idx].id;
    const loc = parseFindingLocation(finding.location);
    return {
      ruleId,
      level: toSarifLevel(finding.severity),
      message: {
        text: `${finding.title}\n\n${finding.detail}`,
      },
      ...(loc
        ? {
            locations: [
              {
                physicalLocation: {
                  artifactLocation: { uri: loc.uri },
                  ...(loc.startLine
                    ? {
                        region: {
                          startLine: loc.startLine,
                          ...(loc.endLine ? { endLine: loc.endLine } : {}),
                          ...(loc.startColumn ? { startColumn: loc.startColumn } : {}),
                        },
                      }
                    : {}),
                },
              },
            ],
          }
        : {}),
      ...(finding.waiver
        ? {
            suppressions: [
              {
                kind: 'external',
                status: 'accepted',
                justification: finding.waiver.reason,
              },
            ],
          }
        : {}),
    };
  });

  const driverToolLabel = job.report?.tool ? toolLabel(job.report.tool) : 'TaskFlow Quality Gate';

  return {
    $schema: 'https://json.schemastore.org/sarif-2.1.0.json',
    version: '2.1.0' as const,
    runs: [
      {
        tool: {
          driver: {
            name: `TaskFlow AI Hub (${stageLabel(job.stage)})`,
            version: '1.0.0',
            informationUri: 'http://127.0.0.1:5186/',
            rules,
          },
        },
        automationDetails: {
          id: `${task.jiraKey}/${job.stage}/${job.id}`,
        },
        properties: {
          jiraKey: task.jiraKey,
          taskTitle: task.title,
          stage: job.stage,
          inputHash: job.inputHash,
          reportTool: driverToolLabel,
          reportSummary: job.report?.summary || '',
        },
        results,
      },
    ],
  };
}

export interface ImportedSarifDraft {
  toolName: string;
  summary: string;
  evidence: string;
  findings: {
    severity: Finding['severity'];
    title: string;
    detail: string;
    location?: string;
  }[];
}

export function parseSarifFindingsToDraft(rawJson: string, maxFindings = 40): ImportedSarifDraft {
  if (typeof rawJson !== 'string' || !rawJson.trim()) {
    throw new Error('SARIF 内容不能为空');
  }
  if (rawJson.length > 2_097_152) {
    throw new Error('SARIF 文件体积超出 2MB 安全解析上限');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error('SARIF JSON 格式解析失败，请核对文件内容');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('无效的 SARIF 顶层对象');
  }
  const doc = parsed as { version?: unknown; runs?: unknown };
  if (typeof doc.version !== 'string' || !doc.version.startsWith('2.') || !Array.isArray(doc.runs) || doc.runs.length === 0) {
    throw new Error('仅支持标准 OASIS SARIF 2.x 扫描报告（需包含 version 与 runs 数组）');
  }

  const findings: ImportedSarifDraft['findings'] = [];
  const toolNames: string[] = [];
  let totalRawResults = 0;
  let suppressedSkipped = 0;

  for (const runItem of doc.runs) {
    if (!runItem || typeof runItem !== 'object') continue;
    const run = runItem as {
      tool?: { driver?: { name?: unknown; rules?: unknown[] } };
      results?: unknown[];
    };
    const driverName = typeof run.tool?.driver?.name === 'string' && run.tool.driver.name.trim()
      ? run.tool.driver.name.trim().slice(0, 80)
      : 'SARIF Scanner';
    if (!toolNames.includes(driverName)) toolNames.push(driverName);

    const ruleTitleMap = new Map<string, string>();
    if (Array.isArray(run.tool?.driver?.rules)) {
      for (const r of run.tool!.driver!.rules) {
        if (!r || typeof r !== 'object') continue;
        const ruleObj = r as { id?: unknown; shortDescription?: { text?: unknown }; name?: unknown };
        if (typeof ruleObj.id === 'string') {
          const desc = typeof ruleObj.shortDescription?.text === 'string'
            ? ruleObj.shortDescription.text.trim()
            : typeof ruleObj.name === 'string'
              ? ruleObj.name.trim()
              : '';
          if (desc) ruleTitleMap.set(ruleObj.id, desc);
        }
      }
    }

    if (!Array.isArray(run.results)) continue;
    for (const resItem of run.results) {
      if (!resItem || typeof resItem !== 'object') continue;
      totalRawResults += 1;
      const res = resItem as {
        ruleId?: unknown;
        level?: unknown;
        message?: { text?: unknown };
        suppressions?: unknown[];
        locations?: {
          physicalLocation?: {
            artifactLocation?: { uri?: unknown };
            region?: { startLine?: unknown; startColumn?: unknown };
          };
        }[];
      };

      if (Array.isArray(res.suppressions) && res.suppressions.length > 0) {
        suppressedSkipped += 1;
        continue;
      }

      if (findings.length >= maxFindings) continue;

      const level = typeof res.level === 'string' ? res.level.toLowerCase() : 'warning';
      const severity: Finding['severity'] =
        level === 'error' ? 'CRITICAL' : level === 'warning' ? 'WARN' : 'INFO';

      const ruleId = typeof res.ruleId === 'string' ? res.ruleId.trim() : '';
      const msgText = typeof res.message?.text === 'string' ? res.message.text.trim() : '';
      const firstLine = msgText.split(/\r?\n/)[0]?.trim() || '';
      const ruleShort = ruleId ? ruleTitleMap.get(ruleId) || '' : '';

      const rawTitle = ruleShort
        ? `${ruleId ? `[${ruleId}] ` : ''}${ruleShort}`
        : firstLine
          ? `${ruleId ? `[${ruleId}] ` : ''}${firstLine}`
          : ruleId || '静态分析发现项';
      const title = rawTitle.slice(0, 200);
      const detail = (msgText || ruleShort || '请结合代码位置核查静态分析告警。').slice(0, 4000);

      let location: string | undefined;
      const phys = Array.isArray(res.locations) ? res.locations[0]?.physicalLocation : undefined;
      const rawUri = typeof phys?.artifactLocation?.uri === 'string' ? phys.artifactLocation.uri : '';
      const startLine = typeof phys?.region?.startLine === 'number' && phys.region.startLine > 0 ? phys.region.startLine : undefined;
      const parsedLoc = parseFindingLocation(startLine ? `${rawUri}:${startLine}` : rawUri);
      if (parsedLoc) {
        location = parsedLoc.startLine ? `${parsedLoc.uri}:${parsedLoc.startLine}` : parsedLoc.uri;
      }

      findings.push({
        severity,
        title,
        detail,
        ...(location ? { location: location.slice(0, 500) } : {}),
      });
    }
  }

  const critCount = findings.filter(f => f.severity === 'CRITICAL').length;
  const warnCount = findings.filter(f => f.severity === 'WARN').length;
  const infoCount = findings.filter(f => f.severity === 'INFO').length;
  const joinedTools = toolNames.join(' / ') || 'SARIF 静态扫描';

  const summary = findings.length === 0
    ? `已导入 ${joinedTools} SARIF 扫描结果：0 个未豁免告警（全部检查通过）。`
    : `已导入 ${joinedTools} SARIF 扫描结果：共提取 ${findings.length} 项发现（CRITICAL ${critCount} · WARN ${warnCount} · INFO ${infoCount}）。`;

  const evidence = [
    `扫描引擎：${joinedTools}`,
    `原始结果数：${totalRawResults}${suppressedSkipped > 0 ? `（已跳过 ${suppressedSkipped} 项自带抑制/豁免项）` : ''}`,
    ...(totalRawResults - suppressedSkipped > maxFindings ? [`提示：超出单份报告上限的部分已截断至前 ${maxFindings} 项`] : []),
  ].join('\n');

  return {
    toolName: joinedTools,
    summary,
    evidence,
    findings,
  };
}
