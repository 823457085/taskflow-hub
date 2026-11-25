// Per-link review rubrics for the delivery chain. Shared by the AI prompt (what the reviewer must check)
// and the chain view (what the user should pay attention to), so both always say the same thing.
export const CHAIN_LINKS = [
  {
    id: 'REQUIREMENT', stage: 'PRD', title: '需求', short: '需求',
    purpose: '确认需求来源清楚、范围明确、验收标准可测、无高风险歧义，才能往下拆任务。',
    rubric: [
      '需求目标与业务背景是否清楚，范围内（In Scope）/ 范围外（Out Scope）是否写明',
      '验收标准（AC）是否逐条可测（前置条件、输入操作、预期结果）',
      '角色与权限、功能开关、灰度与版本兼容口径是否明确',
      '异常、边界、并发与降级/离线场景是否覆盖',
      '外部依赖方（后端 / 设备 / 第三方）与接口联调口径是否明确',
      '【Clarify 歧义扫描】将存在二义性、缺失决策或待业务确认的事项拆为 Q-001/Q-002 列表并标明影响与责任人（放入 clarifyQuestions）',
    ],
  },
  {
    id: 'BREAKDOWN', stage: 'TASK_BREAKDOWN', title: 'Jira 任务与子任务', short: '任务拆分',
    purpose: '确认 Jira 研发任务承接了需求，且子任务覆盖全部 AC、粒度合理（≤ 3 人日）、依赖清晰。',
    rubric: [
      '研发任务描述是否引用需求单，并写明实现范围、交付物与影响范围',
      '【Coverage_PRD】逐条需求点 / AC → 子任务映射：是否有需求点没有任何子任务承接（在 checklist 逐条列出，ref 填子任务 Jira 号）',
      '是否包含技术方案、开发实现、联调 / 自测三类子任务',
      '子任务粒度与复杂度是否合理（单个一般不超过 3 个工作日，过大需建议二次拆分），是否有受理人',
      '子任务之间的前置依赖（after）与 Fix Version 是否与需求一致',
      '仓库是否在任务中声明，跨仓 / 跨端改动是否单独拆分',
    ],
  },
  {
    id: 'TECH_SPEC', stage: 'TECH_SPEC', title: '技术方案', short: '方案',
    purpose: '确认方案能 100% 追溯每条需求与验收标准、契约完整、风险可控，可作为代码审核依据。',
    rubric: [
      '【Coverage_PRD】需求追溯：每条 AC 都能在方案中找到对应设计与约束（在 checklist 逐条给出，不得与 PRD 数值/状态口径矛盾）',
      '接口契约：路径、字段、类型、错误码、空值、幂等键与向下兼容处理',
      '数据与状态：状态机流转、缓存/存储、时效与并发竞争处理',
      '权限校验键、功能开关、灰度放量与最低客户端版本门槛',
      '风险预案、5 分钟内可执行回滚方案与监控告警指标',
      '测试策略：单元测试必测点、联调契约、实机（设备/POS）验证范围',
    ],
  },
  {
    id: 'CODE', stage: 'CODE_REVIEW', title: '代码 · 分支 · 仓库', short: '代码',
    purpose: '基于 Diff-First 与多视角追踪，确认分支/仓库合规、实现与方案一致且无边界/测试/安全性阻断。',
    rubric: [
      '仓库与任务声明一致，分支命名包含 Jira 号，MR 目标分支符合发布约定',
      '【Edge-Case Hunter 边界追踪】针对 Diff 改动行及直接调用链，核查空值、隐式枚举分支、异常捕获与并发状态边界',
      '【Claims Check 描述证伪】逐条对照需求/方案/MR 自述检查改动是否真实落地（列出 fullyCompliant / missing / needsHumanCheck）',
      '【Verification Gap 测试缺口】核查本次改动的行为变更是否有对应单测或有效断言覆盖，Bug Fix 是否有复现回归测试',
      '【Deletion Check 删改遗留】检查删除或重构的代码是否导致旧契约失效或孤立引用',
      '安全与稳定：权限校验、防注入/敏感日志脱敏、公共组件与旧版本回归风险',
    ],
  },
  {
    id: 'TEST', stage: 'TEST_CASE', title: '测试用例', short: '测试',
    purpose: '确认用例 100% 追溯验收标准与方案改动点，覆盖异常与回归范围，能支撑提测准入。',
    rubric: [
      '【Trace_AC】每条验收标准至少有一条可执行测试用例对应（在 checklist 逐条映射）',
      '正常、异常、边界、权限、多语言及弱网/离线/兼容场景是否覆盖',
      '技术方案专项验证点（接口契约、状态机、DB/缓存、前端关键状态）是否设计用例',
      '联调、实机（设备 / POS）及全量回归影响范围是否明确',
    ],
  },
  {
    id: 'RELEASE', stage: 'RELEASE', title: '上线', short: '上线',
    purpose: '确认前序环节全部通过，发布顺序、灰度、监控与回滚方案真实可执行。',
    rubric: [
      '前序门禁（需求 / 方案 / 代码 / 用例）是否全部通过且无未闭环阻断',
      '发布步骤、服务依赖顺序、配置开关与端到端冒烟步骤是否明确',
      '灰度范围、实时监控看板、告警阈值与应急值班是否就绪',
      '回滚触发条件、回滚步骤（含配置/数据订正）与恢复时长是否明确',
    ],
  },
];

export const linkForStage = stage => CHAIN_LINKS.find(link => link.stage === stage) || null;

export function rubricPrompt(stage) {
  const link = linkForStage(stage);
  if (!link) return '';
  return [
    `本环节：【${link.title}】。目标：${link.purpose}`,
    '请逐项核查以下审核清单，每一项都要在 checklist 中给出结果（PASS / WARN / FAIL / NA）与依据：',
    ...link.rubric.map((item, index) => `${index + 1}. ${item}`),
  ].join('\n');
}
