// Per-link review rubrics for the delivery chain. Shared by the AI prompt (what the reviewer must check)
// and the chain view (what the user should pay attention to), so both always say the same thing.
export const CHAIN_LINKS = [
  {
    id: 'REQUIREMENT', stage: 'PRD', title: '需求', short: '需求',
    purpose: '确认需求来源清楚、范围明确、验收标准可测，才能往下拆任务。',
    rubric: [
      '需求目标与业务背景是否清楚，范围内 / 范围外是否写明',
      '验收标准是否逐条可测（输入、操作、预期结果）',
      '角色与权限、开关与灰度口径是否明确',
      '异常、边界、兼容（版本 / 设备 / 多语言）场景是否覆盖',
      '外部依赖方（后端 / 设备 / 第三方）与联调口径是否明确',
      '存在歧义或待确认事项是否列出并有负责人',
    ],
  },
  {
    id: 'BREAKDOWN', stage: 'TASK_BREAKDOWN', title: 'Jira 任务与子任务', short: '任务拆分',
    purpose: '确认 Jira 研发任务承接了需求，并且子任务拆分覆盖全部需求点、粒度合理、可独立交付。',
    rubric: [
      '研发任务描述是否引用需求单，并写明实现范围、交付物与影响范围',
      '逐条需求点 → 子任务映射：是否有需求点没有任何子任务承接（在 checklist 中逐条给出）',
      '是否包含技术方案、开发实现、联调 / 自测三类子任务',
      '子任务粒度是否合理（单个一般不超过 3 个工作日），是否有计划与受理人',
      '子任务之间的依赖与先后顺序是否清楚，Fix Version 是否与需求一致',
      '仓库是否在任务中声明，跨仓 / 跨端改动是否单独拆分',
    ],
  },
  {
    id: 'TECH_SPEC', stage: 'TECH_SPEC', title: '技术方案', short: '方案',
    purpose: '确认方案能追溯到每条需求、接口与数据清楚、风险可控，可作为代码审核依据。',
    rubric: [
      '需求追溯：每条验收标准都能在方案中找到对应设计（在 checklist 中逐条给出）',
      '接口契约：路径、字段、类型、错误码、空值与兼容处理',
      '数据与状态：状态机、缓存、时效、并发',
      '权限键、开关、灰度与版本门槛',
      '风险、回滚方案与监控埋点',
      '测试策略：单测、联调、实机验证范围',
    ],
  },
  {
    id: 'CODE', stage: 'CODE_REVIEW', title: '代码 · 分支 · 仓库', short: '代码',
    purpose: '确认代码落在正确的仓库与分支，MR 关联任务，实现与技术方案一致且无阻断问题。',
    rubric: [
      '仓库与任务声明一致，分支命名包含 Jira 号，MR 目标分支符合发布约定',
      '实现与技术方案一致：接口字段、权限、状态处理（逐条对照方案）',
      '需求点实现覆盖，是否有遗漏或超出范围的改动',
      '回归风险：公共组件、多语言、旧版本兼容',
      '安全与稳定：权限校验、敏感信息、异常处理',
      '测试：是否随代码提交单测 / 用例，测试是否通过',
    ],
  },
  {
    id: 'TEST', stage: 'TEST_CASE', title: '测试用例', short: '测试',
    purpose: '确认用例覆盖全部验收标准与风险点，能支撑提测与上线判断。',
    rubric: [
      '每条验收标准至少有一条用例对应',
      '正常、异常、边界、权限、兼容场景是否覆盖',
      '联调与实机（设备 / POS）验证是否单列',
      '回归范围是否明确',
    ],
  },
  {
    id: 'RELEASE', stage: 'RELEASE', title: '上线', short: '上线',
    purpose: '确认前序环节全部通过，发布步骤、灰度、监控与回滚可执行。',
    rubric: [
      '前序门禁（需求 / 方案 / 代码 / 用例）是否全部通过',
      '发布步骤、顺序与依赖服务是否明确',
      '灰度范围、监控指标与告警',
      '回滚方案与触发条件',
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
