import { KINDS, STAGES, fail, textField } from './common.mjs';
import { diffApiSpecs, lintApiSpec, tryParseApiSpecDocument } from './api-spec.mjs';
import { parseAddedDiffLines, runDeterministicCodeChecks } from './code-review-engine.mjs';

export const BUILTIN_EVALUATORS = [
  'idempotency-contract-guard',
  'sql-migration-safety',
  'sensitive-log-redaction',
  'canary-rollback-gate',
  'openapi-contract-lint',
  'prd-completeness-lint',
];

const RULE_TYPES = ['regex_forbidden', 'regex_required', 'openapi_lint', 'prd_sections'];
const SEVERITIES = ['CRITICAL', 'WARN', 'INFO'];

function compileSafeRegex(pattern) {
  if (typeof pattern !== 'string' || !pattern || pattern.length > 300) {
    fail(400, 'INVALID_PLUGIN', '规则正则表达式长度须在 1 至 300 字符之间');
  }
  try {
    return new RegExp(pattern, 'im');
  } catch {
    fail(400, 'INVALID_PLUGIN', '规则正则表达式语法不正确');
  }
}

export function normalizePluginManifest(body, existingStages) {
  const stages = [...new Set(existingStages)];
  const evaluator = body.evaluator === undefined ? null : textField(body.evaluator, 'evaluator', { max: 64 });
  if (evaluator && !BUILTIN_EVALUATORS.includes(evaluator)) {
    fail(400, 'INVALID_PLUGIN', '内置策略执行器不受支持');
  }

  let rules = null;
  if (body.rules !== undefined) {
    if (!Array.isArray(body.rules) || !body.rules.length || body.rules.length > 20) {
      fail(400, 'INVALID_PLUGIN', 'rules 须为 1 至 20 项规则数组');
    }
    rules = body.rules.map(rule => {
      if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
        fail(400, 'INVALID_PLUGIN', '策略规则条目格式不正确');
      }
      const type = textField(rule.type, 'rule.type', { max: 32 });
      if (!RULE_TYPES.includes(type)) fail(400, 'INVALID_PLUGIN', '策略规则类型不受支持');
      const severity = rule.severity === undefined ? 'WARN' : textField(rule.severity, 'rule.severity', { max: 16 });
      if (!SEVERITIES.includes(severity)) fail(400, 'INVALID_PLUGIN', '策略规则严重级别不受支持');
      const title = textField(rule.title, 'rule.title', { max: 200 });
      const detail = textField(rule.detail || title, 'rule.detail', { max: 1000 });
      const targetKinds = Array.isArray(rule.targetKinds) && rule.targetKinds.length
        ? rule.targetKinds.filter(k => KINDS.includes(k))
        : null;
      if (rule.targetKinds !== undefined && (!targetKinds || !targetKinds.length)) {
        fail(400, 'INVALID_PLUGIN', 'targetKinds 包含不受支持的资产类型');
      }
      if (type === 'regex_forbidden' || type === 'regex_required') {
        compileSafeRegex(rule.pattern);
        return { type, pattern: rule.pattern, severity, title, detail, ...(targetKinds ? { targetKinds } : {}) };
      }
      if (type === 'prd_sections') {
        const sections = Array.isArray(rule.sections)
          ? rule.sections.map(s => textField(s, 'section', { max: 80 })).slice(0, 12)
          : ['验收标准', '异常'];
        return { type, sections, severity, title, detail, ...(targetKinds ? { targetKinds } : {}) };
      }
      return { type, severity, title, detail, ...(targetKinds ? { targetKinds } : {}) };
    });
  }

  const executable = !!(evaluator || (rules && rules.length));
  return {
    stages,
    status: executable ? 'EXECUTABLE_DECLARATIVE' : 'REGISTERED_NOT_EXECUTABLE',
    ...(evaluator ? { evaluator } : {}),
    ...(rules ? { rules } : {}),
  };
}

function resolveBuiltinPackId(plugin) {
  if (plugin?.evaluator && BUILTIN_EVALUATORS.includes(plugin.evaluator)) return plugin.evaluator;
  const id = String(plugin?.id || '');
  return BUILTIN_EVALUATORS.find(pack => id === pack || id.startsWith(`${pack}-`)) || null;
}

function runBuiltinPack(packId, { stage, assets, previousAssetsByKey }) {
  const findings = [];
  const techAssets = assets.filter(a => a.kind === 'TECH_SPEC');
  const codeAssets = assets.filter(a => a.kind === 'CODE');
  const prdAssets = assets.filter(a => a.kind === 'PRD');
  const testAssets = assets.filter(a => a.kind === 'TEST_CASE');
  const releaseAssets = assets.filter(a => a.kind === 'RELEASE_PLAN');

  if (packId === 'idempotency-contract-guard' || packId === 'openapi-contract-lint') {
    for (const asset of techAssets) {
      const spec = tryParseApiSpecDocument(asset.content);
      if (spec) {
        findings.push(...lintApiSpec(spec));
        const prev = previousAssetsByKey?.get(`${asset.kind}:${asset.logicalKey}`);
        if (prev?.content) findings.push(...diffApiSpecs(prev.content, spec));
      } else if (packId === 'idempotency-contract-guard' && /POST|PUT|PATCH|写入|下单|支付|退款|扣款/i.test(asset.content)
        && !/幂等|idempoten|requestId|唯一约束|防重/i.test(asset.content)) {
        findings.push({
          severity: 'WARN',
          title: '[策略门禁] 技术方案缺少写接口幂等与重试防重说明',
          detail: '方案涉及写操作或交易状态变更，但未提及幂等键、防重锁或向下兼容策略。',
          location: `${asset.title} (r${asset.revision})`,
        });
      }
    }
    if (stage === 'CODE_REVIEW' && packId === 'idempotency-contract-guard') {
      for (const asset of codeAssets) {
        if (/(?:createOrder|submitOrder|refund|payout|withdraw|transfer)\s*\(/i.test(asset.content)
          && !/idempoten|requestId|clientOrderNo|lock|unique/i.test(asset.content)) {
          findings.push({
            severity: 'WARN',
            title: '[策略门禁] 交易/写操作改动未见显式幂等校验标识',
            detail: '代码变更涉及关键交易写路径，请复核是否已在上游网关或数据库唯一键层保障幂等。',
            location: `${asset.title} (r${asset.revision})`,
          });
        }
      }
    }
  }

  if (packId === 'sql-migration-safety') {
    for (const asset of [...techAssets, ...codeAssets, ...releaseAssets]) {
      const text = asset.content || '';
      const ddlMatch = text.match(/\b(ALTER\s+TABLE|DROP\s+(?:TABLE|COLUMN|INDEX)|TRUNCATE\s+TABLE)\b[^\n]*/i);
      if (ddlMatch) {
        const hasRollback = /回滚|rollback|down\.sql|ALGORITHM=INPLACE|CONCURRENTLY|锁表/i.test(text);
        if (!hasRollback) {
          findings.push({
            severity: 'CRITICAL',
            title: '[策略门禁] 检测到高危 DDL 变更但缺少锁表评估或回滚脚本',
            detail: `发现数据库结构变更「${ddlMatch[0].slice(0, 80)}」，请补充锁表影响评估、在线变更参数（如 INPLACE/CONCURRENTLY）及回滚 SQL。`,
            location: `${asset.title} (r${asset.revision})`,
          });
        }
      }
    }
  }

  if (packId === 'sensitive-log-redaction') {
    const codeFindings = runDeterministicCodeChecks([...codeAssets, ...testAssets]).filter(f =>
      /密钥|凭据|私钥|日志/.test(f.title)
    );
    findings.push(...codeFindings);
  }

  if (packId === 'canary-rollback-gate') {
    for (const asset of [...releaseAssets, ...testAssets]) {
      if (asset.kind === 'RELEASE_PLAN' && !/回滚|rollback|revert|降级|熔断|灰度|canary/i.test(asset.content || '')) {
        findings.push({
          severity: 'CRITICAL',
          title: '[策略门禁] 上线计划缺少灰度放量与回滚预案',
          detail: '未检测到灰度比例控制、告警指标或 5 分钟内回滚操作步骤，无法满足安全发布门禁。',
          location: `${asset.title} (r${asset.revision})`,
        });
      }
    }
  }

  if (packId === 'prd-completeness-lint' && stage === 'PRD') {
    for (const asset of prdAssets) {
      const content = asset.content || '';
      const checks = [
        { label: '验收标准 / Acceptance Criteria', re: /验收|acceptance|ac\b|预期结果/i },
        { label: '异常流程 / 边界条件', re: /异常|边界|兜底|报错|失败|降级/i },
        { label: '权限或影响范围', re: /权限|角色|影响范围|灰度|兼容/i },
      ];
      const missing = checks.filter(c => !c.re.test(content)).map(c => c.label);
      if (missing.length) {
        findings.push({
          severity: 'WARN',
          title: '[策略门禁] 需求文档缺少关键评审维度',
          detail: `当前需求文档未明确涵盖：${missing.join('、')}，建议补充后再进入研发设计。`,
          location: `${asset.title} (r${asset.revision})`,
        });
      }
    }
  }

  return findings;
}

function runDeclarativeRules(plugin, assets) {
  const findings = [];
  for (const rule of plugin.rules || []) {
    const scopedAssets = rule.targetKinds?.length
      ? assets.filter(a => rule.targetKinds.includes(a.kind))
      : assets;
    if (!scopedAssets.length) continue;

    if (rule.type === 'openapi_lint') {
      for (const asset of scopedAssets) {
        const spec = tryParseApiSpecDocument(asset.content);
        if (spec) findings.push(...lintApiSpec(spec));
      }
      continue;
    }

    if (rule.type === 'prd_sections') {
      for (const asset of scopedAssets) {
        const missing = (rule.sections || []).filter(sec => !String(asset.content || '').toLowerCase().includes(sec.toLowerCase()));
        if (missing.length) {
          findings.push({
            severity: rule.severity,
            title: `[${plugin.name}] ${rule.title}`,
            detail: `${rule.detail}（缺失内容：${missing.join('、')}）`,
            location: `${asset.title} (r${asset.revision})`,
          });
        }
      }
      continue;
    }

    const re = compileSafeRegex(rule.pattern);
    for (const asset of scopedAssets) {
      const content = asset.content || '';
      if (rule.type === 'regex_forbidden') {
        const added = asset.kind === 'CODE' ? parseAddedDiffLines(content) : [];
        if (added.length) {
          const hit = added.find(line => re.test(line.text));
          if (hit) {
            findings.push({
              severity: rule.severity,
              title: `[${plugin.name}] ${rule.title}`,
              detail: rule.detail,
              location: `${hit.filePath}:${hit.lineNumber}`,
            });
          }
        } else if (re.test(content)) {
          findings.push({
            severity: rule.severity,
            title: `[${plugin.name}] ${rule.title}`,
            detail: rule.detail,
            location: `${asset.title} (r${asset.revision})`,
          });
        }
      } else if (rule.type === 'regex_required' && !re.test(content)) {
        findings.push({
          severity: rule.severity,
          title: `[${plugin.name}] ${rule.title}`,
          detail: rule.detail,
          location: `${asset.title} (r${asset.revision})`,
        });
      }
    }
  }
  return findings;
}

export function evaluateDeterministicPrechecks({ stage, snapshot, previousAssetsByKey = null }) {
  const assets = Array.isArray(snapshot?.assets) ? snapshot.assets : [];
  const plugins = Array.isArray(snapshot?.plugins) ? snapshot.plugins : [];
  const findings = [];
  const executedPlugins = [];
  const checks = [];

  if (stage === 'PRD') {
    checks.push('prd-completeness-lint');
    findings.push(...runBuiltinPack('prd-completeness-lint', { stage, assets, previousAssetsByKey }));
  }

  if (stage === 'TECH_SPEC' || stage === 'CODE_REVIEW') {
    for (const asset of assets.filter(a => a.kind === 'TECH_SPEC')) {
      const spec = tryParseApiSpecDocument(asset.content);
      if (spec) {
        checks.push('openapi-contract-lint');
        findings.push(...lintApiSpec(spec));
        const prev = previousAssetsByKey?.get(`${asset.kind}:${asset.logicalKey}`);
        if (prev?.content) {
          checks.push('openapi-breaking-diff');
          findings.push(...diffApiSpecs(prev.content, spec));
        }
      }
    }
  }

  if (stage === 'CODE_REVIEW') {
    checks.push('deterministic-code-scan');
    findings.push(...runDeterministicCodeChecks(assets.filter(a => a.kind === 'CODE')));
  }

  for (const plugin of plugins) {
    if (Array.isArray(plugin.stages) && !plugin.stages.includes(stage)) continue;
    let ran = false;
    const packId = resolveBuiltinPackId(plugin);
    if (packId) {
      findings.push(...runBuiltinPack(packId, { stage, assets, previousAssetsByKey }));
      ran = true;
    }
    if (Array.isArray(plugin.rules) && plugin.rules.length) {
      findings.push(...runDeclarativeRules(plugin, assets));
      ran = true;
    }
    if (ran) executedPlugins.push(plugin.id);
  }

  const deduped = [];
  const seen = new Set();
  for (const item of findings) {
    if (!item || !SEVERITIES.includes(item.severity) || !item.title || !item.detail) continue;
    const key = `${item.severity}|${item.title}|${item.location || ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push({
      severity: item.severity,
      title: String(item.title).slice(0, 200),
      detail: String(item.detail).slice(0, 4000),
      ...(item.location ? { location: String(item.location).slice(0, 500) } : {}),
    });
    if (deduped.length >= 50) break;
  }

  return {
    findings: deduped,
    executedPlugins: [...new Set(executedPlugins)],
    checks: [...new Set(checks)],
  };
}

export function normalizePluginStageFilter(stages) {
  return Array.isArray(stages) ? stages.filter(s => STAGES.includes(s)) : [];
}
