import type { Asset, AssetKind, Gates, WorkTask } from './workspaceApi.ts';
import { analyzeAssetRiskSignals, isUnifiedDiffContent, parseUnifiedDiffStats } from './assetDiff.ts';
import { assetKindLabel, gateStatusLabel, stageLabel } from './displayLabels.ts';
import { isSafeHttpUrl } from './markdownLite.ts';

export type GitBranchPrefix = 'feature' | 'bugfix' | 'hotfix' | 'release';

export function shellSingleQuote(value: string): string {
  const safe = String(value ?? '').replace(/[\r\n\x00]/g, '');
  return `'${safe.replace(/'/g, "'\\''")}'`;
}

export function inferBranchPrefix(task: Pick<WorkTask, 'type' | 'title'>): GitBranchPrefix {
  if (/hotfix|紧急修复|线上故障|应急修复/i.test(task.title)) return 'hotfix';
  if (task.type === 'BUG') return 'bugfix';
  if (task.type === 'RELEASE') return 'release';
  return 'feature';
}

export function slugifyAsciiBranchSegment(rawTitle: string, maxLength = 36): string {
  const tokens = String(rawTitle || '')
    .toLowerCase()
    .match(/[a-z0-9]+/g);
  if (!tokens || tokens.length === 0) return '';
  let slug = '';
  for (const token of tokens) {
    const next = slug ? `${slug}-${token}` : token;
    if (next.length > maxLength) {
      if (!slug) slug = token.slice(0, maxLength);
      break;
    }
    slug = next;
  }
  return slug.replace(/^-+|-+$/g, '');
}

export function buildConventionalBranchName(task: Pick<WorkTask, 'jiraKey' | 'type' | 'title'>): string {
  const prefix = inferBranchPrefix(task);
  const key = task.jiraKey.trim().toUpperCase();
  const strippedTitle = task.title.replace(new RegExp(key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'ig'), ' ');
  const slug = slugifyAsciiBranchSegment(strippedTitle);
  return slug ? `${prefix}/${key}-${slug}` : `${prefix}/${key}`;
}

export function buildConventionalCommitMessage(task: Pick<WorkTask, 'jiraKey' | 'type' | 'title'>): string {
  const key = task.jiraKey.trim().toUpperCase();
  const projectPrefix = (key.split('-')[0] || 'app').toLowerCase();
  const cleanTitle = task.title.replace(/\s+/g, ' ').trim().slice(0, 72);
  if (task.type === 'RELEASE') {
    return `chore(release): ${cleanTitle} [${key}]`;
  }
  const commitType = task.type === 'BUG' ? 'fix' : 'feat';
  return `${commitType}(${projectPrefix}): ${cleanTitle} [${key}]`;
}

export interface GitWorktreeHandoff {
  branchName: string;
  worktreeDir: string;
  checkoutCommand: string;
  worktreeCommand: string;
  cleanupWorktreeCommand: string;
  commitCommand: string;
}

export function buildGitWorktreeCommands(params: {
  task: Pick<WorkTask, 'jiraKey' | 'type' | 'title'>;
  branchName?: string;
  repoPath?: string | null;
  baseBranch?: string | null;
}): GitWorktreeHandoff {
  const { task, repoPath, baseBranch } = params;
  const branchName = (params.branchName || buildConventionalBranchName(task)).trim();
  const keySlug = task.jiraKey.trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
  const safeBase = baseBranch && /^[A-Za-z0-9._/-]{1,120}$/.test(baseBranch.trim()) && !baseBranch.includes('..')
    ? baseBranch.trim()
    : 'main';

  const normalizedRepo = repoPath ? repoPath.replace(/\/+$/, '') : '';
  const worktreeDir = normalizedRepo
    ? `${normalizedRepo}-wt-${keySlug}`
    : `../worktrees/${task.jiraKey.trim().toUpperCase()}`;

  const cdPrefix = normalizedRepo ? `cd ${shellSingleQuote(normalizedRepo)} && ` : '';
  const checkoutCommand = `${cdPrefix}git checkout -b ${shellSingleQuote(branchName)}`;
  const worktreeCommand = `${cdPrefix}git worktree add -b ${shellSingleQuote(branchName)} ${shellSingleQuote(worktreeDir)} ${shellSingleQuote(safeBase)}`;
  const cleanupWorktreeCommand = `${cdPrefix}git worktree remove ${shellSingleQuote(worktreeDir)}`;
  const commitMsg = buildConventionalCommitMessage(task);
  const commitCommand = `git commit -m ${shellSingleQuote(commitMsg)}`;

  return {
    branchName,
    worktreeDir,
    checkoutCommand,
    worktreeCommand,
    cleanupWorktreeCommand,
    commitCommand,
  };
}

function pickLatestByKind(assets: readonly Asset[]): Map<AssetKind, Asset> {
  const map = new Map<AssetKind, Asset>();
  for (const a of assets) {
    const cur = map.get(a.kind);
    if (!cur || a.revision > cur.revision) map.set(a.kind, a);
  }
  return map;
}

export function buildPullRequestDescription(params: {
  task: WorkTask;
  assets: readonly Asset[];
  gates?: Gates | null;
  branchName?: string;
}): string {
  const { task, assets, gates, branchName = buildConventionalBranchName(task) } = params;
  const latest = pickLatestByKind(assets);
  const jiraUrl = task.externalRef?.url;
  const issueRef = typeof jiraUrl === 'string' && isSafeHttpUrl(jiraUrl)
    ? `[${task.jiraKey}](${jiraUrl})`
    : `\`${task.jiraKey}\``;

  const codeAsset = latest.get('CODE');
  const specAsset = latest.get('TECH_SPEC');
  const releaseAsset = latest.get('RELEASE_PLAN');

  const diffStats = codeAsset && isUnifiedDiffContent(codeAsset.content)
    ? parseUnifiedDiffStats(codeAsset.content)
    : null;

  const riskSignals = [
    ...(codeAsset ? analyzeAssetRiskSignals(codeAsset.content).signals : []),
    ...(specAsset ? analyzeAssetRiskSignals(specAsset.content).signals : []),
  ];
  const uniqueRiskLabels = [...new Set(riskSignals.map(s => s.label))];

  const lines: string[] = [
    `## 关联事项与分支`,
    '',
    `- **Jira 事项**：${issueRef} — ${task.title}`,
    `- **工作分支**：\`${branchName}\``,
    ...(task.lastSummary?.trim() ? [`- **最新开发进展**：${task.lastSummary.trim().replace(/\s+/g, ' ')}`] : []),
    '',
    '## 变更依据与版本化材料',
    '',
  ];

  const orderedKinds: AssetKind[] = ['PRD', 'TECH_SPEC', 'CODE', 'TEST_CASE', 'RELEASE_PLAN'];
  const presentAssets = orderedKinds.map(k => latest.get(k)).filter((a): a is Asset => !!a);
  if (presentAssets.length === 0) {
    lines.push('- 待补充版本化设计、代码与测试材料');
  } else {
    for (const a of presentAssets) {
      lines.push(`- **${assetKindLabel(a.kind)}**：${a.title}（\`r${a.revision}\` · SHA \`${a.sha256.slice(0, 8)}\`）`);
    }
  }

  lines.push('', '## 代码改动规模与风险提示', '');
  if (diffStats && (diffStats.files.length > 0 || diffStats.additions > 0 || diffStats.deletions > 0)) {
    lines.push(`- **Diff 统计**：涉及 **${diffStats.files.length}** 个文件，新增 **+${diffStats.additions}** 行 / 删除 **-${diffStats.deletions}** 行`);
  } else if (codeAsset) {
    lines.push(`- **代码材料**：已登记《${codeAsset.title}》（\`r${codeAsset.revision}\`）`);
  } else {
    lines.push('- **代码材料**：尚未登记本地 Git Diff 或 MR 代码快照');
  }

  if (uniqueRiskLabels.length > 0) {
    lines.push(`- **识别到的敏感变更点**：${uniqueRiskLabels.join('、')}（请重点核对幂等、权限与回滚预案）`);
  } else {
    lines.push('- **敏感变更扫描**：未触发高危数据库迁移、并发锁或密钥硬编码特征');
  }

  lines.push('', '## 五阶段质量门禁核验单', '');
  if (gates?.gates?.length) {
    for (const g of gates.gates) {
      const checked = g.status === 'PASS' ? 'x' : ' ';
      lines.push(`- [${checked}] **${stageLabel(g.stage)}**：${gateStatusLabel(g.status)}${g.reason ? `（${g.reason}）` : ''}`);
    }
  } else {
    lines.push('- [ ] 需求评审 (PRD)', '- [ ] 技术方案审核 (TECH_SPEC)', '- [ ] 代码审核 (CODE_REVIEW)', '- [ ] 测试用例评审 (TEST_CASE)', '- [ ] 上线审核 (RELEASE)');
  }

  lines.push('', '## 验证与回滚说明', '');
  if (releaseAsset) {
    lines.push(`- 已登记上线与回滚预案：《${releaseAsset.title}》（\`r${releaseAsset.revision}\`）`);
  } else {
    lines.push('- [ ] 已在本地/测试环境完成正向、异常与回归验证', '- [ ] 已确认功能开关或 5 分钟内可执行的快速回滚路径');
  }

  return lines.join('\n');
}
