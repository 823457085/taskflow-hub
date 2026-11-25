import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, posix } from 'node:path';
import { inflateRawSync } from 'node:zlib';
import { fail } from './common.mjs';

export const SKILL_SCOPES = [
  { id: 'PRD_REVIEW', label: '需求评审', group: 'review', description: '评审 PRD 业务目标、边界条件、角色权限与可测 AC' },
  { id: 'JIRA_GEN', label: 'Jira 生成与拆解', group: 'generate', description: '从需求/方案拆解子任务、生成 Jira 标题、验收标准与排期' },
  { id: 'TECH_SPEC_GEN', label: '技术方案生成', group: 'generate', description: '基于需求与代码仓结构自动起草技术方案与接口设计' },
  { id: 'TECH_SPEC_REVIEW', label: '技术方案 / 接口评审', group: 'review', description: '评审架构合理性、接口契约兼容性、并发幂等与安全风险' },
  { id: 'CODE_GEN', label: '代码开发', group: 'generate', description: '指导 AI 编写功能代码、遵守分层规范与补齐单元测试' },
  { id: 'CODE_REVIEW', label: '代码评审', group: 'review', description: '审查 PR/MR 与本地 Diff 的代码质量、安全红线与门禁证据' },
  { id: 'TEST_CASE', label: '测试用例', group: 'quality', description: '生成或评审黑盒/边界/权限/回归测试用例集' },
  { id: 'RELEASE', label: '上线检查', group: 'quality', description: '核查上线依赖顺序、灰度策略、监控告警与回滚预案' },
];

export const SKILL_SCOPE_IDS = SKILL_SCOPES.map(s => s.id);
const SCOPE_SET = new Set(SKILL_SCOPE_IDS);

export const SKILL_CONTENT_MAX = 40_000;
export const SKILL_FILE_MAX_BYTES = 80_000;
export const SKILL_MAX_ATTACHMENTS = 24;
export const SKILL_TOTAL_ATTACHMENTS_MAX = 240_000;
const ZIP_MAX_BYTES = 10 * 1024 * 1024;
const ZIP_MAX_ENTRIES = 120;
const ZIP_MAX_UNCOMPRESSED = 8 * 1024 * 1024;

export const SKILL_PRESETS = [
  {
    name: 'prd-review-standard',
    description: '需求评审规范：检查业务目标、边界范围、权限角色、异常流与可测试验收标准（AC）',
    scopes: ['PRD_REVIEW'],
    content: `# 需求文档（PRD）AI 评审规范

## 评审重点
1. **目标与范围边界**：明确本次做什么、不做什么，以及涉及的前端/后端/终端职责归属。
2. **角色与权限矩阵**：所有入口、按钮、接口均须写清允许的角色及无权访问时的表现。
3. **状态机与异常分支**：检查超时、重试、弱网/离线、并发操作、空态与错误提示文案是否闭环。
4. **安全与合规红线**：严禁明文持久化或导出密码、Token、秘钥、敏感个人凭据。
5. **可测验收标准（AC）**：每条核心需求必须能转化为可验证的“给定-当-那么”测试条件。

## 判定标准
- 存在安全红线、文档前后直接矛盾或核心主流程无验收标准 -> 判为 \`CRITICAL\`。
- 跨端联调口径待确认、非阻塞细节缺失 -> 判为 \`WARN\` 并写入澄清清单。`,
  },
  {
    name: 'jira-subtask-generator',
    description: 'Jira 拆解与生成：将需求与技术方案拆成粒度 ≤3 人日、职责清晰的可交付研发子任务',
    scopes: ['JIRA_GEN'],
    content: `# Jira 任务与子任务拆解规范

## 拆解原则
1. **单任务粒度控制**：每条研发子任务预估工作量控制在 0.5–3 人日内，超过 3 人日须继续拆分。
2. **职责清晰不混杂**：尽量按「技术方案」「后端实现」「前端实现」「联调与自测/测试」分拆；跨仓库或跨端必须独立建单。
3. **验收点可追溯**：每条子任务明确覆盖哪些 PRD 章节或 AC 编号，确保所有核心验收点无漏接。
4. **前置依赖显式标出**：写明依赖的接口契约、基础组件或兄弟团队任务，避免开发期空等。

## 输出要求
- 标题采用动词开头（如「实现离线开门密码校验接口」「开发设备详情页离线密码弹窗」）。
- 每条子任务附带明确的完成定义（DoD）与自测要点。`,
  },
  {
    name: 'tech-spec-writer',
    description: '技术方案编写规范：结合 PRD 与现有代码仓结构自动生成含架构、接口契约、数据模型与回滚方案的技术方案',
    scopes: ['TECH_SPEC_GEN'],
    content: `# 技术方案自动编写规范

请严格基于任务 PRD、Jira 描述和代码仓真实目录结构编写可直接评审落地的技术方案，不编造不存在的模块或接口。

## 必备章节
1. **背景与目标**：简述本次改造范围、不涉及范围与核心指标。
2. **总体设计与数据流**：画出模块职责划分、核心时序/状态流转（使用 Mermaid 或清晰步骤说明）。
3. **接口契约设计**：列出新增/变更的 API 路径、Method、请求/响应字段、鉴权方式与错误码枚举。
4. **数据模型与兼容性**：说明库表/缓存/本地存储字段变更、默认值与历史数据兼容策略。
5. **异常、幂等与安全设计**：覆盖超时、降级、防重、权限校验、日志脱敏等关键保障。
6. **测试与灰度回滚计划**：明确核心单测/联调用例、开关控制与可执行的快速回滚步骤。`,
  },
  {
    name: 'tech-spec-review',
    description: '技术方案与接口契约评审：核查 PRD 对齐度、向后兼容性、性能瓶颈、并发安全与回滚兜底',
    scopes: ['TECH_SPEC_REVIEW'],
    content: `# 技术方案与接口文档评审规范

## 检查项
1. **PRD 需求全覆盖**：逐条对照 PRD 验收标准，确认技术方案没有遗漏关键场景或私自缩水范围。
2. **接口契约与兼容性**：检查请求/响应字段命名、类型、必填性、分页与错误码定义，禁止破坏性删除或改类型（Breaking Change）。
3. **并发、幂等与事务一致性**：写接口须说明幂等键、并发竞争处理与失败补偿机制。
4. **安全与隐私保护**：检查鉴权粒度、越权防护、入参校验及日志脱敏。
5. **可观测与回滚**：确认关键链路有监控/日志指标，且发布出现异常时可安全回滚。`,
  },
  {
    name: 'code-impl-guardrails',
    description: '代码开发实现规范：引导 AI 遵守仓库分层边界、最小改动面、错误处理规范并补齐关键测试',
    scopes: ['CODE_GEN'],
    content: `# 代码开发实现规范

## 编码守则
1. **先读后改，最小改动面**：修改前先阅读目标模块及调用方，遵循项目现有架构分层与命名约定，不顺手重构无关代码。
2. **健壮的边界与错误处理**：显式处理空值、异步竞态、请求取消、超时和异常分支，不静默吞掉错误。
3. **安全底线**：禁止硬编码密钥/Token/密码，禁止拼接未转义 SQL 或未消毒 HTML，禁止打印敏感明文日志。
4. **验证闭环**：完成改动后补充或更新对应的单元测试/回归测试，并运行局部测试或类型检查确认通过。
5. **只改代码不越权**：严禁执行 \`git push\` 或修改外部 Jira/GitLab 状态。`,
  },
  {
    name: 'code-review-checklist',
    description: '代码评审检查单：聚焦逻辑正确性、安全漏洞、契约一致性、边界竞态与测试缺口',
    scopes: ['CODE_REVIEW'],
    content: `# 代码评审（Code Review）规范

## 审查维度
1. **功能与契约对齐**：核对代码改动是否完整实现需求与技术方案约定，接口字段/状态码是否前后端一致。
2. **边界条件与并发竞态**：重点排查空值、切换页面/组件卸载后的迟到响应、重复提交、超时与状态回滚。
3. **安全红线**：排查鉴权绕过、越权访问、XSS/SQL 注入、路径穿越、密钥泄露与敏感信息明文落盘。
4. **可维护性与删除遗留**：检查重复实现、过度抽象、未清理的旧分支/死代码与无效注释。
5. **测试覆盖缺口**：核实核心逻辑与边界异常是否有真实断言覆盖，避免空测或仅测 happy path。

## 分级原则
- 真实安全红线、数据损坏、必现故障或违反硬门禁 -> \`CRITICAL\`。
- 潜在边界缺陷、测试缺口、结构维护风险 -> \`WARN\`，并给出最小可落地修改方向。`,
  },
  {
    name: 'test-case-standard',
    description: '测试用例生成与评审：覆盖主流程、异常流、边界值、权限越权与跨端联调回归场景',
    scopes: ['TEST_CASE'],
    content: `# 测试用例生成与评审规范

## 覆盖维度
1. **正向主流程**：每个 AC 至少对应 1 条端到端主流程用例，步骤与预期结果均可客观判定。
2. **异常与容错**：覆盖接口报错、超时、弱网/离线恢复、重复点击、非法输入与空态展示。
3. **边界值**：覆盖最大/最小长度、0/负数、分页边界、时间/时区边界与版本门槛。
4. **权限与安全**：验证不同角色（管理员/普通成员/无权用户）的入口可见性与接口越权拦截。
5. **回归影响面**：明确本次改动关联的既有功能回归清单。

## 用例格式
每条用例包含：编号、场景分类、前置条件、操作步骤、预期结果与关联 AC。`,
  },
  {
    name: 'release-readiness-checklist',
    description: '上线准出检查：核验发布依赖顺序、配置/DB 变更兼容性、灰度放量、监控告警与回滚预案',
    scopes: ['RELEASE'],
    content: `# 上线发布准出检查规范

## 核验要点
1. **发布依赖顺序**：明确后端、前端、数据库脚本、配置中心与客户端版本的先后上线顺序。
2. **向前/向后兼容**：确认数据库变更与接口协议在灰度期间兼容新旧版本并存。
3. **灰度与开关控制**：高风险功能必须具备特性开关或按比例/白名单灰度策略。
4. **监控与告警**：明确上线后重点观察的错误率、延迟、业务成功率指标及告警阈值。
5. **可执行回滚预案**：写明触发回滚的判定条件、回滚步骤与数据恢复方案。`,
  },
];

export function sanitizeSkillName(raw, fallback = 'imported-skill') {
  const cleaned = String(raw || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 63);
  return cleaned || fallback;
}

export function normalizeScopes(raw) {
  if (raw === undefined || raw === null) return [];
  let list = [];
  if (Array.isArray(raw)) list = raw;
  else if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) return [];
    if (trimmed.startsWith('[')) {
      try {
        const parsed = JSON.parse(trimmed);
        list = Array.isArray(parsed) ? parsed : [];
      } catch {
        list = trimmed.replace(/^\[|\]$/g, '').split(/[,，\s]+/);
      }
    } else {
      list = trimmed.split(/[,，\s]+/);
    }
  } else {
    fail(400, 'INVALID_INPUT', 'scopes 需为场景标识数组');
  }
  const out = [];
  for (const item of list) {
    const code = String(item || '').trim().toUpperCase();
    if (!code) continue;
    if (!SCOPE_SET.has(code)) fail(400, 'INVALID_SKILL_SCOPE', `不支持的 Skill 适用场景：${code}`);
    if (!out.includes(code)) out.push(code);
  }
  return out;
}

export function inferSkillScopes({ name = '', description = '', content = '' }) {
  // Strip negative exclusion clauses like "普通功能开发和纯需求/技术方案评审不自动触发" before matching keywords.
  const positiveDesc = String(description || '')
    .split(/[。；;!\n]+/)
    .filter(seg => !/(不自动触发|不适用于|不用于|勿用于|不要用于)/.test(seg))
    .join(' ');
  const primaryHay = `${name}\n${positiveDesc}`.toLowerCase();
  const matchFrom = hay => {
    const matched = new Set();
    if (/(code[\s_-]*review|代码评审|代码审查|pr[\s_-]*review|mr[\s_-]*review|frontend-code-review|diff审查)/i.test(hay)) matched.add('CODE_REVIEW');
    if (/(prd|需求评审|需求审查|requirement[\s_-]*review)/i.test(hay)) matched.add('PRD_REVIEW');
    if (/(jira|子任务|拆解|breakdown|subtask)/i.test(hay)) matched.add('JIRA_GEN');
    if (/(技术方案生成|编写技术方案|技术方案编写|tech[\s_-]*spec[\s_-]*gen|tech[\s_-]*spec[\s_-]*writer|架构设计编写|设计文档生成)/i.test(hay)) matched.add('TECH_SPEC_GEN');
    if (/(技术方案评审|技术方案与接口|方案评审|接口评审|openapi|swagger|api[\s_-]*review|tech[\s_-]*spec[\s_-]*review)/i.test(hay)) matched.add('TECH_SPEC_REVIEW');
    if (/(代码开发|代码实现|编码规范|code[\s_-]*gen|code[\s_-]*impl|开发协作)/i.test(hay)) matched.add('CODE_GEN');
    if (/(测试用例|test[\s_-]*case|黑盒|白盒|验收用例)/i.test(hay)) matched.add('TEST_CASE');
    if (/(上线检查|上线发布|上线准出|release[\s_-]*check|release[\s_-]*readiness|回滚预案)/i.test(hay)) matched.add('RELEASE');
    return matched;
  };

  let matched = matchFrom(primaryHay);
  if (!matched.size) {
    matched = matchFrom(String(content || '').slice(0, 800).toLowerCase());
  }
  if (!matched.size && /(技术方案|tech[\s_-]*spec|架构设计)/i.test(primaryHay)) {
    matched.add('TECH_SPEC_GEN');
    matched.add('TECH_SPEC_REVIEW');
  }
  return [...matched];
}

export function parseSkillMarkdown(rawContent, fallbackName = '') {
  const text = String(rawContent || '').replace(/^\uFEFF/, '');
  const frontMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const front = frontMatch ? frontMatch[1] : '';
  const body = frontMatch ? text.slice(frontMatch[0].length) : text;

  const meta = key => {
    const match = front.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
    if (!match) return '';
    return match[1].trim().replace(/^["']|["']$/g, '').trim();
  };

  const rawName = meta('name') || fallbackName;
  const name = sanitizeSkillName(rawName, 'imported-skill');

  let description = meta('description').replace(/[\r\n]+/g, ' ').trim();
  if (!description) {
    const lines = body.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    const heading = lines.find(l => /^#\s+/.test(l))?.replace(/^#+\s+/, '') || '';
    const para = lines.find(l => !/^#|^[-*>`|]/.test(l)) || '';
    description = (para || heading || name).replace(/[\r\n]+/g, ' ').trim();
  }
  description = description.slice(0, 500) || name;

  const rawScopes = meta('scopes');
  let scopes = [];
  if (rawScopes) {
    try { scopes = normalizeScopes(rawScopes); } catch { scopes = []; }
  }
  if (!scopes.length) {
    scopes = inferSkillScopes({ name, description, content: text });
  }

  return {
    name,
    description,
    scopes,
    content: text.slice(0, SKILL_CONTENT_MAX),
  };
}

export function sanitizeAttachmentFiles(rawFiles) {
  if (!Array.isArray(rawFiles)) return [];
  const seen = new Set();
  const out = [];
  let totalBytes = 0;
  for (const item of rawFiles) {
    if (out.length >= SKILL_MAX_ATTACHMENTS) break;
    if (!item || typeof item !== 'object') continue;
    const rawPath = String(item.path || '').replace(/\\/g, '/').replace(/^\/+/, '');
    const normalized = posix.normalize(rawPath);
    if (
      !normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../')
      || /[\x00-\x1f\x7f]/.test(normalized) || normalized.length > 240
    ) continue;
    if (seen.has(normalized)) continue;
    if (typeof item.content !== 'string' || /[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(item.content)) continue;
    const content = item.content.slice(0, SKILL_FILE_MAX_BYTES);
    const bytes = Buffer.byteLength(content, 'utf8');
    if (totalBytes + bytes > SKILL_TOTAL_ATTACHMENTS_MAX) continue;
    seen.add(normalized);
    totalBytes += bytes;
    out.push({ path: normalized, content });
  }
  return out;
}

function isReadableTextFile(relPath) {
  return /\.(md|markdown|txt|ya?ml|json|py|mjs|js|ts|sh|toml|ini|conf|sql|graphql)$/i.test(relPath);
}

function isIgnoredArchivePath(entryName) {
  const parts = entryName.split('/');
  if (parts.some(p => p === '__MACOSX' || p === '.git' || p === 'node_modules' || p === '.DS_Store' || p.startsWith('._'))) return true;
  return false;
}

export function parseZipEntries(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 22) fail(400, 'INVALID_ZIP', '无效的 ZIP 文件');
  if (buffer.length > ZIP_MAX_BYTES) fail(400, 'ZIP_TOO_LARGE', 'ZIP 文件不能超过 10MB');

  // Find End of Central Directory record (0x06054b50) scanning backwards (max comment 65535)
  const minOffset = Math.max(0, buffer.length - 22 - 65535);
  let eocdOffset = -1;
  for (let i = buffer.length - 22; i >= minOffset; i--) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      eocdOffset = i;
      break;
    }
  }
  if (eocdOffset < 0) fail(400, 'INVALID_ZIP', '无法识别 ZIP 目录结构，请确认上传的是标准 .zip 压缩包');

  const totalEntries = buffer.readUInt16LE(eocdOffset + 10);
  const cdSize = buffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = buffer.readUInt32LE(eocdOffset + 16);
  if (totalEntries > ZIP_MAX_ENTRIES) fail(400, 'ZIP_TOO_MANY_FILES', `ZIP 内文件数量超过上限（最多 ${ZIP_MAX_ENTRIES} 个）`);
  if (cdOffset + cdSize > buffer.length) fail(400, 'INVALID_ZIP', 'ZIP 目录损坏');

  const entries = [];
  let cursor = cdOffset;
  let totalUncompressed = 0;

  for (let idx = 0; idx < totalEntries; idx++) {
    if (cursor + 46 > buffer.length || buffer.readUInt32LE(cursor) !== 0x02014b50) {
      fail(400, 'INVALID_ZIP', 'ZIP 中央目录记录损坏');
    }
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLen = buffer.readUInt16LE(cursor + 28);
    const extraLen = buffer.readUInt16LE(cursor + 30);
    const commentLen = buffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42);

    const rawName = buffer.subarray(cursor + 46, cursor + 46 + nameLen).toString('utf8').replace(/\\/g, '/');
    cursor += 46 + nameLen + extraLen + commentLen;

    if (!rawName || rawName.endsWith('/')) continue;
    const normalized = posix.normalize(rawName.replace(/^\/+/, ''));
    if (!normalized || normalized === '.' || normalized.startsWith('..') || normalized.includes('/../') || /^[A-Za-z]:/.test(normalized)) {
      fail(400, 'UNSAFE_ZIP_PATH', 'ZIP 包含非法路径，已拒绝导入');
    }
    if (isIgnoredArchivePath(normalized)) continue;
    if (uncompressedSize > 512_000) continue; // skip huge non-skill binaries/logs
    totalUncompressed += uncompressedSize;
    if (totalUncompressed > ZIP_MAX_UNCOMPRESSED) fail(400, 'ZIP_TOO_LARGE', 'ZIP 解压后体积超过上限（8MB）');

    if (localHeaderOffset + 30 > buffer.length || buffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      fail(400, 'INVALID_ZIP', 'ZIP 文件头损坏');
    }
    const lhNameLen = buffer.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = buffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > buffer.length) fail(400, 'INVALID_ZIP', 'ZIP 文件数据截断');

    const slice = buffer.subarray(dataStart, dataEnd);
    let data;
    if (method === 0) data = slice;
    else if (method === 8) {
      try { data = inflateRawSync(slice); } catch { fail(400, 'INVALID_ZIP', `解压文件 ${normalized} 失败`); }
    } else {
      continue; // unsupported compression method
    }
    entries.push({ path: normalized, data });
  }
  return entries;
}

export function extractSkillsFromZip(buffer, fallbackFilename = 'skill-bundle.zip') {
  const entries = parseZipEntries(buffer);
  const textEntries = entries
    .filter(e => isReadableTextFile(e.path))
    .map(e => ({ path: e.path, content: e.data.toString('utf8') }))
    .filter(e => !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(e.content));

  if (!textEntries.length) fail(400, 'EMPTY_SKILL_ZIP', '压缩包中未找到可识别的 SKILL.md、Markdown 或 JSON 配置');

  // Case 1: One or more SKILL.md folders (standard Agent Skill bundle like frontend-review-share.zip)
  const skillMdEntries = textEntries.filter(e => /(?:^|\/)SKILL\.md$/i.test(e.path));
  if (skillMdEntries.length > 0) {
    const skills = [];
    for (const entry of skillMdEntries) {
      const dir = entry.path.includes('/') ? entry.path.slice(0, entry.path.lastIndexOf('/')) : '';
      const folderName = dir ? dir.split('/').pop() : fallbackFilename.replace(/\.zip$/i, '');
      const parsed = parseSkillMarkdown(entry.content, folderName);
      const prefix = dir ? `${dir}/` : '';
      const attachments = [];
      for (const other of textEntries) {
        if (other.path === entry.path) continue;
        if (prefix && !other.path.startsWith(prefix)) continue;
        const rel = prefix ? other.path.slice(prefix.length) : other.path;
        // Skip sibling skills or test suites > 40KB that don't belong to prompt context
        if (/(?:^|\/)SKILL\.md$/i.test(rel)) continue;
        attachments.push({ path: rel, content: other.content });
      }
      // Prefer references/ and prompt docs first when trimming to attachment budget
      attachments.sort((a, b) => {
        const rank = p => (/^references\//i.test(p) ? 0 : /\.md$/i.test(p) ? 1 : /^agents\//i.test(p) ? 2 : /^scripts\//i.test(p) ? 3 : 4);
        return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
      });
      skills.push({
        ...parsed,
        files: sanitizeAttachmentFiles(attachments),
        source: 'zip',
      });
    }
    return skills;
  }

  // Case 2: JSON export bundle inside zip
  const jsonEntries = textEntries.filter(e => /\.json$/i.test(e.path));
  for (const j of jsonEntries) {
    try {
      const parsed = JSON.parse(j.content);
      const list = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.skills) ? parsed.skills : null;
      if (list && list.length && list.every(item => item && typeof item.content === 'string')) {
        return list.slice(0, 50).map(item => ({
          name: sanitizeSkillName(item.name || item.title || 'imported-skill'),
          description: String(item.description || item.name || '导入的 Skill').replace(/[\r\n]+/g, ' ').trim().slice(0, 500),
          content: String(item.content).slice(0, SKILL_CONTENT_MAX),
          scopes: normalizeScopes(item.scopes),
          files: sanitizeAttachmentFiles(item.files),
          enabled: item.enabled !== false,
          source: 'zip',
        }));
      }
    } catch { /* ignore non-bundle json */ }
  }

  // Case 3: Plain Markdown files inside zip
  const mdEntries = textEntries.filter(e => /\.(md|markdown)$/i.test(e.path));
  const candidates = mdEntries.length > 1
    ? mdEntries.filter(e => !/(?:^|\/)README\.md$/i.test(e.path))
    : mdEntries;
  if (!candidates.length) fail(400, 'EMPTY_SKILL_ZIP', '压缩包中未找到 SKILL.md 或 Markdown 规则文件');

  return candidates.slice(0, 50).map(entry => {
    const stem = basename(entry.path).replace(/\.(md|markdown)$/i, '');
    const parsed = parseSkillMarkdown(entry.content, stem);
    return { ...parsed, files: [], source: 'zip' };
  });
}

function readSkillDirectory(skillDir, sourceLabel) {
  const skillMdPath = join(skillDir, 'SKILL.md');
  if (!existsSync(skillMdPath)) return null;
  const st = lstatSync(skillMdPath);
  if (!st.isFile() || st.isSymbolicLink() || st.size <= 0 || st.size > 100_000) return null;
  const raw = readFileSync(skillMdPath, 'utf8');
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(raw)) return null;
  const parsed = parseSkillMarkdown(raw, basename(skillDir));

  // Also collect references/*.md and agents/*.yaml attachments (max depth 2)
  const attachments = [];
  const walk = (dir, relBase, depth) => {
    if (depth > 2 || attachments.length >= SKILL_MAX_ATTACHMENTS) return;
    let items;
    try { items = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      if (item.name.startsWith('.') || item.name === 'node_modules' || item.name === '__pycache__') continue;
      const full = join(dir, item.name);
      const rel = relBase ? `${relBase}/${item.name}` : item.name;
      if (rel.toLowerCase() === 'skill.md') continue;
      try {
        const lst = lstatSync(full);
        if (lst.isSymbolicLink()) continue;
        if (lst.isDirectory()) {
          walk(full, rel, depth + 1);
        } else if (lst.isFile() && lst.size > 0 && lst.size <= SKILL_FILE_MAX_BYTES && isReadableTextFile(rel)) {
          const text = readFileSync(full, 'utf8');
          if (!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(text)) {
            attachments.push({ path: rel, content: text });
          }
        }
      } catch { /* skip unreadable */ }
    }
  };
  walk(skillDir, '', 0);
  attachments.sort((a, b) => {
    const rank = p => (/^references\//i.test(p) ? 0 : /\.md$/i.test(p) ? 1 : /^agents\//i.test(p) ? 2 : 3);
    return rank(a.path) - rank(b.path) || a.path.localeCompare(b.path);
  });

  return {
    ...parsed,
    files: sanitizeAttachmentFiles(attachments),
    sourceLabel,
    sourcePath: skillDir,
  };
}

export function discoverLocalSkills(repoPath = null) {
  const home = homedir();
  const roots = [
    ...(repoPath ? [
      { dir: join(repoPath, '.agents', 'skills'), label: '项目仓库 (.agents/skills)' },
      { dir: join(repoPath, '.claude', 'skills'), label: '项目仓库 (.claude/skills)' },
      { dir: join(repoPath, '.cursor', 'skills'), label: '项目仓库 (.cursor/skills)' },
    ] : []),
    { dir: join(home, '.agents', 'skills'), label: '本机 ~/.agents/skills' },
    { dir: join(home, '.codex', 'skills'), label: '本机 Codex Skills' },
    { dir: join(home, '.claude', 'skills'), label: '本机 Claude Skills' },
    { dir: join(home, '.cursor', 'skills'), label: '本机 Cursor Skills' },
    { dir: join(home, '.gemini', 'config', 'skills'), label: '本机 Antigravity Skills' },
    { dir: join(home, '.gemini', 'antigravity', 'skills'), label: '本机 Antigravity Skills' },
  ];

  const results = [];
  const seenKey = new Set();

  for (const root of roots) {
    if (!existsSync(root.dir)) continue;
    let entries;
    try { entries = readdirSync(root.dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (results.length >= 80) break;
      if (entry.name.startsWith('.') || entry.name.startsWith('taskflow-')) continue;
      const full = join(root.dir, entry.name);
      try {
        const st = lstatSync(full);
        if (st.isSymbolicLink() || !st.isDirectory()) continue;
        const skill = readSkillDirectory(full, root.label);
        if (!skill) continue;
        const key = `${skill.name}@${root.dir}`;
        if (seenKey.has(key)) continue;
        seenKey.add(key);
        results.push(skill);
      } catch { /* skip inaccessible dir */ }
    }
  }
  return results;
}

export function mapRunToSkillScopes({ mode = 'read', actionType = 'DEFAULT', stage = null } = {}) {
  if (mode === 'review') {
    if (stage === 'PRD') return ['PRD_REVIEW'];
    if (stage === 'TASK_BREAKDOWN') return ['JIRA_GEN'];
    if (stage === 'TECH_SPEC') return ['TECH_SPEC_REVIEW'];
    if (stage === 'CODE_REVIEW') return ['CODE_REVIEW'];
    if (stage === 'TEST_CASE') return ['TEST_CASE'];
    if (stage === 'RELEASE') return ['RELEASE'];
    return [];
  }
  if (mode === 'develop') return ['CODE_GEN'];
  if (actionType === 'TECH_SPEC_GEN') return ['TECH_SPEC_GEN'];
  if (actionType === 'SUBTASK_DRAFT') return ['JIRA_GEN'];
  if (actionType === 'TEST_CASE_GEN') return ['TEST_CASE'];
  if (actionType === 'REVIEW_ASK') return stage ? mapRunToSkillScopes({ mode: 'review', stage }) : ['CODE_REVIEW'];
  if (actionType === 'CHAIN_ANALYZE') return ['PRD_REVIEW', 'TECH_SPEC_REVIEW', 'CODE_REVIEW'];
  return ['PRD_REVIEW', 'TECH_SPEC_REVIEW', 'CODE_REVIEW'];
}
