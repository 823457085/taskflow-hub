import { memberName, type Asset, type AssetKind, type Gates, type ProgressEvent, type ReviewJob, type User, type WorkTask } from './workspaceApi.ts';
import {
  assetKindLabel,
  decisionLabel,
  gateStatusLabel,
  reviewStatusLabel,
  severityLabel,
  stageLabel,
  taskStatusLabel,
  taskTypeLabel,
} from './displayLabels.ts';

export type ContextPackFormat = 'markdown' | 'xml';

export interface ContextPackOptions {
  task: WorkTask;
  assets: readonly Asset[];
  jobs?: readonly ReviewJob[];
  gates?: Gates | null;
  progressEvents?: readonly ProgressEvent[];
  repoPath?: string | null;
  constitutionFiles?: readonly string[];
  format?: ContextPackFormat;
  latestAssetsOnly?: boolean;
  includeReviews?: boolean;
  includeProgress?: boolean;
}

export interface BuiltContextPack {
  content: string;
  estimatedTokens: number;
  byteLength: number;
  includedAssetCount: number;
}

const ASSET_STAGE_ORDER: Record<AssetKind, number> = {
  PRD: 0,
  TECH_SPEC: 1,
  CODE: 2,
  TEST_CASE: 3,
  RELEASE_PLAN: 4,
};

const CJK_CHAR_RE = /[\u3400-\u9fff\uf900-\ufaff\u3000-\u303f\uff00-\uffef]/g;

export function estimateContextTokens(text: string): number {
  if (!text) return 0;
  const cjkMatches = text.match(CJK_CHAR_RE);
  const cjkCount = cjkMatches ? cjkMatches.length : 0;
  const otherCount = Math.max(0, text.length - cjkCount);
  return Math.max(1, Math.round(cjkCount * 0.68 + otherCount * 0.27));
}

export function selectLatestAssets(assets: readonly Asset[]): Asset[] {
  const latestByKey = new Map<string, Asset>();
  for (const asset of assets) {
    const key = `${asset.kind}::${asset.logicalKey}`;
    const current = latestByKey.get(key);
    if (!current || asset.revision > current.revision) {
      latestByKey.set(key, asset);
    }
  }
  return [...latestByKey.values()].sort((a, b) => {
    const orderDiff = (ASSET_STAGE_ORDER[a.kind] ?? 99) - (ASSET_STAGE_ORDER[b.kind] ?? 99);
    if (orderDiff !== 0) return orderDiff;
    if (a.logicalKey !== b.logicalKey) return a.logicalKey.localeCompare(b.logicalKey);
    return b.revision - a.revision;
  });
}

function escapeXmlAttr(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeXmlText(value: string): string {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function stringifyJiraDescription(desc: unknown): string {
  if (!desc) return '';
  if (typeof desc === 'string') return desc.trim();
  try {
    return JSON.stringify(desc, null, 2);
  } catch {
    return '';
  }
}

export function buildTaskContextPack(options: ContextPackOptions): BuiltContextPack {
  const {
    task,
    assets,
    jobs = [],
    gates = null,
    progressEvents = [],
    repoPath = null,
    constitutionFiles = [],
    format = 'markdown',
    latestAssetsOnly = true,
    includeReviews = true,
    includeProgress = true,
  } = options;

  const chosenAssets = latestAssetsOnly
    ? selectLatestAssets(assets)
    : [...assets].sort((a, b) => {
        const orderDiff = (ASSET_STAGE_ORDER[a.kind] ?? 99) - (ASSET_STAGE_ORDER[b.kind] ?? 99);
        if (orderDiff !== 0) return orderDiff;
        if (a.logicalKey !== b.logicalKey) return a.logicalKey.localeCompare(b.logicalKey);
        return b.revision - a.revision;
      });

  const jiraDesc = stringifyJiraDescription(task.externalRef?.description);
  const activeJobs = jobs.filter(j => !j.stale);

  let content = '';
  if (format === 'xml') {
    const lines: string[] = [
      `<task_context jira_key="${escapeXmlAttr(task.jiraKey)}" status="${escapeXmlAttr(task.status)}" progress="${task.progress}%">`,
      `  <metadata>`,
      `    <title>${escapeXmlText(task.title)}</title>`,
      `    <type>${escapeXmlText(task.externalRef?.type || taskTypeLabel(task.type))}</type>`,
      `    <local_status>${escapeXmlText(taskStatusLabel(task.status))}</local_status>`,
      ...(task.externalRef?.url ? [`    <jira_url>${escapeXmlText(task.externalRef.url)}</jira_url>`] : []),
      ...(repoPath ? [`    <repository_path>${escapeXmlText(repoPath)}</repository_path>`] : []),
      `  </metadata>`,
    ];
    if (constitutionFiles.length > 0) {
      lines.push(`  <engineering_constitution files="${escapeXmlAttr(constitutionFiles.join(', '))}">`);
      lines.push(`    请严格遵循绑定代码仓库根目录下的工程规范文件：${escapeXmlText(constitutionFiles.join('、'))}`);
      lines.push(`  </engineering_constitution>`);
    }
    if (jiraDesc) {
      lines.push(`  <jira_description>`);
      lines.push(escapeXmlText(jiraDesc));
      lines.push(`  </jira_description>`);
    }
    if (gates) {
      lines.push(`  <quality_gates overall="${escapeXmlAttr(gates.overall)}">`);
      for (const g of gates.gates) {
        lines.push(`    <gate stage="${escapeXmlAttr(g.stage)}" label="${escapeXmlAttr(stageLabel(g.stage))}" status="${escapeXmlAttr(g.status)}">${escapeXmlText(g.reason || '')}</gate>`);
      }
      lines.push(`  </quality_gates>`);
    }
    lines.push(`  <assets count="${chosenAssets.length}" mode="${latestAssetsOnly ? 'latest_only' : 'all_revisions'}">`);
    for (const asset of chosenAssets) {
      lines.push(`    <asset kind="${escapeXmlAttr(asset.kind)}" key="${escapeXmlAttr(asset.logicalKey)}" revision="r${asset.revision}" sha256="${escapeXmlAttr(asset.sha256.slice(0, 12))}" title="${escapeXmlAttr(asset.title)}">`);
      lines.push(escapeXmlText(asset.content));
      lines.push(`    </asset>`);
    }
    lines.push(`  </assets>`);

    if (includeReviews && activeJobs.length > 0) {
      lines.push(`  <reviews count="${activeJobs.length}">`);
      for (const job of activeJobs) {
        lines.push(`    <review stage="${escapeXmlAttr(job.stage)}" status="${escapeXmlAttr(job.status)}">`);
        if (job.report) {
          lines.push(`      <summary>${escapeXmlText(job.report.summary)}</summary>`);
        }
        for (const f of job.findings) {
          lines.push(`      <finding severity="${escapeXmlAttr(f.severity)}" waived="${f.waiver ? 'true' : 'false'}"${f.location ? ` location="${escapeXmlAttr(f.location)}"` : ''}>`);
          lines.push(`        ${escapeXmlText(f.title)} — ${escapeXmlText(f.detail)}${f.waiver ? ` (已豁免: ${escapeXmlText(f.waiver.reason)})` : ''}`);
          lines.push(`      </finding>`);
        }
        lines.push(`    </review>`);
      }
      lines.push(`  </reviews>`);
    }
    if (includeProgress && progressEvents.length > 0) {
      lines.push(`  <progress_timeline>`);
      for (const ev of progressEvents.slice(0, 10)) {
        lines.push(`    <event progress="${ev.progress}%"${ev.branch ? ` branch="${escapeXmlAttr(ev.branch)}"` : ''}>${escapeXmlText(ev.summary)}</event>`);
      }
      lines.push(`  </progress_timeline>`);
    }
    lines.push(`</task_context>`);
    content = lines.join('\n');
  } else {
    const sections: string[] = [
      `# ${task.jiraKey} · ${task.title}`,
      '',
      '## 1. 任务元信息',
      `- **任务号**：\`${task.jiraKey}\``,
      `- **任务类型**：${task.externalRef?.type || taskTypeLabel(task.type)}`,
      `- **本地状态**：${taskStatusLabel(task.status)}（自报进度 ${task.progress}%）`,
      ...(task.externalRef?.status ? [`- **Jira 状态**：${task.externalRef.status}`] : []),
      ...(task.externalRef?.url ? [`- **Jira 链接**：${task.externalRef.url}`] : []),
      ...(repoPath ? [`- **绑定本地仓库**：\`${repoPath}\``] : []),
      ...(constitutionFiles.length > 0 ? [`- **仓库工程规范**：${constitutionFiles.map(f => `\`${f}\``).join(' · ')}`] : []),
    ];

    if (jiraDesc) {
      sections.push('', '## 2. Jira 原始需求描述', '', jiraDesc);
    }

    if (gates) {
      sections.push(
        '',
        `## 3. 五阶段门禁矩阵（当前总状态：${gateStatusLabel(gates.overall)}）`,
        '',
        '| 评审阶段 | 门禁状态 | 说明 |',
        '| --- | --- | --- |',
        ...gates.gates.map(g => {
          return `| ${stageLabel(g.stage)} | ${gateStatusLabel(g.status)} | ${(g.reason || '—').replace(/\|/g, '\\|')} |`;
        }),
      );
    }

    sections.push('', `## 4. 任务材料快照（共 ${chosenAssets.length} 份${latestAssetsOnly ? '，已去重仅保留最新版' : ''}）`);
    if (!chosenAssets.length) {
      sections.push('', '_当前尚无已登记材料。_');
    } else {
      for (const asset of chosenAssets) {
        sections.push(
          '',
          `### [${assetKindLabel(asset.kind)} · r${asset.revision}] ${asset.title}`,
          `- 标识：\`${asset.logicalKey}\` · 指纹：\`${asset.sha256.slice(0, 12)}\`${asset.sourceUrl ? ` · 来源：${asset.sourceUrl}` : ''}`,
          '',
          '```',
          asset.content,
          '```',
        );
      }
    }

    if (includeReviews && activeJobs.length > 0) {
      sections.push('', `## 5. 有效评审与发现项（共 ${activeJobs.length} 项）`);
      for (const job of activeJobs) {
        sections.push(
          '',
          `### ${stageLabel(job.stage)} — ${reviewStatusLabel(job.status)}${job.decision ? `（${decisionLabel(job.decision.decision)}）` : ''}`,
        );
        if (job.report) {
          sections.push(job.report.summary);
        }
        if (job.findings.length > 0) {
          sections.push('');
          for (const f of job.findings) {
            const loc = f.location ? ` \`${f.location}\`` : '';
            const waiver = f.waiver ? `（已豁免：${f.waiver.reason}）` : '';
            sections.push(`- **[${severityLabel(f.severity)}]** ${f.title}${loc}：${f.detail}${waiver}`);
          }
        }
      }
    }

    if (includeProgress && progressEvents.length > 0) {
      sections.push('', '## 6. 最近开发进度流水');
      for (const ev of progressEvents.slice(0, 10)) {
        sections.push(`- **${ev.progress}%**${ev.branch ? ` (\`${ev.branch}\`)` : ''}：${ev.summary}`);
      }
    }

    content = sections.join('\n');
  }

  const byteLength = new TextEncoder().encode(content).length;
  return {
    content,
    estimatedTokens: estimateContextTokens(content),
    byteLength,
    includedAssetCount: chosenAssets.length,
  };
}

export function formatBatchTasksMarkdown(tasks: readonly WorkTask[], members: readonly User[]): string {
  return tasks
    .map(task => {
      const done = task.status === 'DONE';
      const who = memberName(members as User[], task.assigneeId);
      return `- [${done ? 'x' : ' '}] **${task.jiraKey}** ${task.title}（${taskStatusLabel(task.status)} · ${who} · ${task.progress}%）`;
    })
    .join('\n');
}
