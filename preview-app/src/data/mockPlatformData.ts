export type RoleKey = 'TECH_LEAD' | 'BACKEND_DEV' | 'PRODUCT_MANAGER' | 'QA_ENGINEER' | 'SRE_RELEASE';

export interface UserProfile {
  roleKey: RoleKey;
  roleLabel: string;
  userName: string;
  department: string;
  permissions: {
    canTriggerReview: boolean;
    canOverrideGate: boolean;
    canApproveTestCase: boolean;
    canExecuteRelease: boolean;
    canManagePluginsAndPool: boolean;
  };
}

export const USER_ROLES: Record<RoleKey, UserProfile> = {
  TECH_LEAD: {
    roleKey: 'TECH_LEAD',
    roleLabel: '架构师 / Tech Lead',
    userName: '李四 (架构组)',
    department: '交易核心研发部',
    permissions: {
      canTriggerReview: true,
      canOverrideGate: true,
      canApproveTestCase: true,
      canExecuteRelease: false,
      canManagePluginsAndPool: true,
    },
  },
  BACKEND_DEV: {
    roleKey: 'BACKEND_DEV',
    roleLabel: '后端开发工程师',
    userName: '张三 (订单后端)',
    department: '交易核心研发部',
    permissions: {
      canTriggerReview: true,
      canOverrideGate: false,
      canApproveTestCase: false,
      canExecuteRelease: false,
      canManagePluginsAndPool: false,
    },
  },
  PRODUCT_MANAGER: {
    roleKey: 'PRODUCT_MANAGER',
    roleLabel: '产品经理 (PM)',
    userName: '林敏 (交易产品)',
    department: '商业产品中心',
    permissions: {
      canTriggerReview: true,
      canOverrideGate: false,
      canApproveTestCase: false,
      canExecuteRelease: false,
      canManagePluginsAndPool: false,
    },
  },
  QA_ENGINEER: {
    roleKey: 'QA_ENGINEER',
    roleLabel: '测试架构师 (QA)',
    userName: '王五 (质量保障)',
    department: '质量工程部',
    permissions: {
      canTriggerReview: true,
      canOverrideGate: false,
      canApproveTestCase: true,
      canExecuteRelease: false,
      canManagePluginsAndPool: false,
    },
  },
  SRE_RELEASE: {
    roleKey: 'SRE_RELEASE',
    roleLabel: '发布官 / SRE',
    userName: '赵六 (平台稳定性)',
    department: 'SRE 与交付保障部',
    permissions: {
      canTriggerReview: true,
      canOverrideGate: false,
      canApproveTestCase: false,
      canExecuteRelease: true,
      canManagePluginsAndPool: true,
    },
  },
};

export type StageKey = 'PRD' | 'TECH_SPEC' | 'CODE_REVIEW' | 'TEST_CASE' | 'RELEASE';

export interface SubTaskItem {
  jiraKey: string;
  title: string;
  type: '产品' | '架构' | '前端' | '后端' | '测试' | '上线';
  assignee: string;
  jiraStatus: '已完成' | '进行中' | '待审核' | '待开始';
  localIdeTool?: 'Cursor' | 'Claude Code' | 'Codex CLI';
  localConnected?: boolean;
  progressPct: number;
  branch?: string;
  lastSyncText?: string;
  checklist: { label: string; done: boolean }[];
}

export interface CodeFinding {
  id: string;
  severity: 'CRITICAL' | 'WARN';
  category: string;
  platform: 'GitLab' | '云效 Codeup';
  repo: string;
  mrIid: string;
  filePath: string;
  line: number;
  title: string;
  detail: string;
  diffSnippet: string;
  suggestedFix: string;
  overridden?: boolean;
  overrideReason?: string;
  overrideBy?: string;
  fixedInLocal?: boolean;
}

export interface RequirementStory {
  jiraKey: string;
  epicKey: string;
  epicName: string;
  title: string;
  sprint: string;
  priority: 'P0' | 'P1';
  owner: string;
  currentStage: StageKey;
  jiraStatus: string;
  prdUrl: string;
  techSpecUrl: string;
  prdScore: number;
  techSpecScore: number;
  codeScore: number;
  testCoveragePct: number;
  subTasks: SubTaskItem[];
  findings: CodeFinding[];
}

export const INITIAL_STORIES: RequirementStory[] = [
  {
    jiraKey: 'ORD-200',
    epicKey: 'EPIC-18',
    epicName: '跨仓履约与智能拆单专项',
    title: '支持多仓库存实时锁定与母子订单自动拆单结算',
    sprint: '2026 Sprint 46',
    priority: 'P0',
    owner: '林敏 / 李四',
    currentStage: 'CODE_REVIEW',
    jiraStatus: '代码联审中 (In Review)',
    prdUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=982104',
    techSpecUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=982499',
    prdScore: 94,
    techSpecScore: 91,
    codeScore: 76,
    testCoveragePct: 96,
    subTasks: [
      {
        jiraKey: 'ORD-201',
        title: '母子拆单业务规则 PRD 编写与边界条件确认',
        type: '产品',
        assignee: '林敏',
        jiraStatus: '已完成',
        progressPct: 100,
        lastSyncText: 'Confluence v4 已锁定',
        checklist: [
          { label: '部分退款逆向状态机补全', done: true },
          { label: '拆单优惠券分摊精度规则定义', done: true },
        ],
      },
      {
        jiraKey: 'ORD-202',
        title: '跨服务拆单技术方案与 OpenAPI 黄金契约审定',
        type: '架构',
        assignee: '李四',
        jiraStatus: '已完成',
        localIdeTool: 'Codex CLI',
        localConnected: true,
        progressPct: 100,
        lastSyncText: '已锁定 Golden Contract v1.2',
        checklist: [
          { label: '订单分片键与 Flyway DDL 审计', done: true },
          { label: 'POST /api/v2/orders/split 契约导出', done: true },
        ],
      },
      {
        jiraKey: 'ORD-203',
        title: '结算页多包裹拆分预览与子单追踪前端改造',
        type: '前端',
        assignee: '陈晨',
        jiraStatus: '待审核',
        localIdeTool: 'Cursor',
        localConnected: true,
        progressPct: 100,
        branch: 'feat/ORD-203-fe-split-view',
        lastSyncText: 'Cursor MCP · 2 分钟前推送 MR !215',
        checklist: [
          { label: '拆单预览组件 SplitOrderPreview.tsx', done: true },
          { label: '对接 Golden API Contract 类型定义', done: true },
          { label: '前端组件单测 (Vitest 14/14 通过)', done: true },
        ],
      },
      {
        jiraKey: 'ORD-204',
        title: '订单拆单核心引擎、分布式锁与分摊逻辑开发',
        type: '后端',
        assignee: '张三',
        jiraStatus: '进行中',
        localIdeTool: 'Claude Code',
        localConnected: true,
        progressPct: 85,
        branch: 'feat/ORD-204-be-split-engine',
        lastSyncText: 'Claude Code MCP 在线 · 12 秒前同步进度',
        checklist: [
          { label: 'OrderSplitService 核心分摊算法', done: true },
          { label: 'Redis 幂等防重锁与异常回滚事务', done: true },
          { label: '修复跨仓 DTO subOrderId 精度序列化问题', done: false },
        ],
      },
      {
        jiraKey: 'ORD-205',
        title: '拆单正向/并发/部分退货测试用例评审与自动化脚本',
        type: '测试',
        assignee: '王五',
        jiraStatus: '进行中',
        localIdeTool: 'Codex CLI',
        localConnected: true,
        progressPct: 90,
        branch: 'test/ORD-205-split-e2e',
        lastSyncText: '云效 Testhub 已同步 28 条用例',
        checklist: [
          { label: 'PRD 12 项验收标准黑盒覆盖', done: true },
          { label: 'AI 识别白盒限流降级分支补充用例确认', done: false },
        ],
      },
      {
        jiraKey: 'ORD-206',
        title: '交易核心域单需求集中编排生产发布 (DB+配置+双端)',
        type: '上线',
        assignee: '赵六',
        jiraStatus: '待开始',
        progressPct: 0,
        lastSyncText: '等待 ORD-204 代码门禁放行',
        checklist: [
          { label: 'RBOM 物料清单完整性 AI 终审', done: false },
          { label: '按 DAG 顺序触发 Jenkins 与云效流水线', done: false },
        ],
      },
    ],
    findings: [
      {
        id: 'F-101',
        severity: 'CRITICAL',
        category: '前后端跨仓契约不一致 (FE vs BE Contract Drift)',
        platform: 'GitLab',
        repo: 'be-order-service / fe-mall-web',
        mrIid: 'BE !88 <-> FE !215',
        filePath: 'src/main/java/com/corp/order/dto/SplitOrderRespDTO.java',
        line: 42,
        title: '后端返回 64 位 Long 型 subOrderId 未转 String，导致前端 JS Number 精度丢失风险',
        detail:
          '【云端 AI 全栈审查官 · 跨仓 Worktree 联审发现】技术方案 Golden Contract 约定 subOrderId 为 string (雪花算法 19 位 ID)，前端 fe-mall-web (MR !215 SplitOrderPreview.tsx:28) 按 string 接收跳转；但后端 be-order-service (MR !88) 直接暴露了 Java Long 字段且缺少 @JsonFormat(shape = Shape.STRING)。',
        diffSnippet: `- private String parentOrderNo;\n+ private Long subOrderId; // 19位雪花ID直接JSON序列化为Number\n+ private BigDecimal allocatedPayAmount;`,
        suggestedFix: `@JsonFormat(shape = JsonFormat.Shape.STRING)\nprivate Long subOrderId;`,
      },
      {
        id: 'F-102',
        severity: 'WARN',
        category: '配置变更上线遗漏预警 (RBOM Config Guard)',
        platform: '云效 Codeup',
        repo: 'be-order-service',
        mrIid: 'BE !88',
        filePath: 'src/main/java/com/corp/order/service/OrderSplitEngine.java',
        line: 118,
        title: '新增 @Value("${order.split.max-warehouse-count:5}") 建议同步登记至集中上线 Nacos 清单',
        detail:
          '检测到新增动态阈值配置项，当前已声明默认值 5，不会引起启动崩溃，但已在 ORD-206 上线 RBOM 清单中自动为您预填待确认条目。',
        diffSnippet: `+ @Value("\${order.split.max-warehouse-count:5}")\n+ private Integer maxWarehouseCount;`,
        suggestedFix: `已在【5. 集中上线中心 -> Nacos 配置变更】自动生成预登记项。`,
      },
    ],
  },
  {
    jiraKey: 'PAY-108',
    epicKey: 'EPIC-22',
    epicName: '企业收银台清结算升级',
    title: '多币种实时汇率锁价与异步对账差错自动平账',
    sprint: '2026 Sprint 46',
    priority: 'P0',
    owner: '周杰 / 李四',
    currentStage: 'RELEASE',
    jiraStatus: '待生产发布 (Ready for Release)',
    prdUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=981020',
    techSpecUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=981305',
    prdScore: 96,
    techSpecScore: 95,
    codeScore: 94,
    testCoveragePct: 100,
    subTasks: [
      {
        jiraKey: 'PAY-109',
        title: '汇率锁价与差错平账技术方案及核心后端改造',
        type: '后端',
        assignee: '周杰',
        jiraStatus: '已完成',
        localIdeTool: 'Codex CLI',
        localConnected: true,
        progressPct: 100,
        branch: 'feat/PAY-109-fx-lock',
        lastSyncText: '全部门禁 PASS · 待 SRE 发布',
        checklist: [{ label: '跨仓代码联审与云效自动化回归 100% 通过', done: true }],
      },
    ],
    findings: [],
  },
  {
    jiraKey: 'USR-312',
    epicKey: 'EPIC-30',
    epicName: '企业客户 SSO 与细粒度数据权限',
    title: '支持自定义部门树数据隔离与敏感操作双人复核工作流',
    sprint: '2026 Sprint 46',
    priority: 'P1',
    owner: '林敏 / 陈晨',
    currentStage: 'TECH_SPEC',
    jiraStatus: '技术方案审核中',
    prdUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=983011',
    techSpecUrl: 'https://confluence.example.invalid/pages/viewpage.action?pageId=983290',
    prdScore: 92,
    techSpecScore: 84,
    codeScore: 0,
    testCoveragePct: 0,
    subTasks: [
      {
        jiraKey: 'USR-313',
        title: 'RBAC+ABAC 权限拦截器技术方案设计',
        type: '架构',
        assignee: '李四',
        jiraStatus: '进行中',
        localIdeTool: 'Cursor',
        localConnected: true,
        progressPct: 60,
        lastSyncText: 'AI 首席架构师正在核查缓存一致性方案',
        checklist: [{ label: '补充权限变更后 Redis 本地二级缓存广播失效策略', done: false }],
      },
    ],
    findings: [],
  },
];

export interface AiRoleAgent {
  id: string;
  name: string;
  handle: string;
  stageLabel: string;
  accountStrategy: string;
  sandboxMode: string;
  description: string;
  skills: { id: string; name: string; syncedToLocal: boolean; desc: string }[];
  allowedMcpTools: string[];
}

export const CLOUD_AI_ROLES: AiRoleAgent[] = [
  {
    id: 'ai-pm',
    name: 'AI 产品评审官',
    handle: '@ai-pm',
    stageLabel: '1. 需求评审 & 任务拆解',
    accountStrategy: '优先触发人账号 -> 产品组共享池',
    sandboxMode: 'API 结构化模式 (只读文档)',
    description: '审查 Confluence PRD 异常流程、权限边界、状态机闭环与可测试验收标准，自动向 Jira 推送子任务拆解草案。',
    skills: [
      { id: 'prd-completeness-audit', name: 'PRD 异常与边界完备度审查', syncedToLocal: true, desc: '检查空状态、幂等性、埋点与权限说明' },
      { id: 'state-machine-validator', name: '业务状态机死锁检测', syncedToLocal: false, desc: '校验订单/支付正向与逆向流转闭环' },
      { id: 'jira-subtask-decomposer', name: 'Jira 研发测试子任务拆解', syncedToLocal: false, desc: '按团队职责模板生成前/后端/测试子单' },
    ],
    allowedMcpTools: ['confluence.read_page', 'confluence.inline_comment', 'jira.propose_subtasks'],
  },
  {
    id: 'ai-architect',
    name: 'AI 首席架构师',
    handle: '@ai-architect',
    stageLabel: '2. 技术方案审核 & 契约锁定',
    accountStrategy: '架构组高配 Pro 专号池 (High Reasoning)',
    sandboxMode: '线上 Codex CLI 容器沙箱 (read-only)',
    description: '对照已审 PRD 与现有代码库目录树审核技术方案，自动提取锁定《前后端黄金 API 契约》与《上线依赖预申报单》。',
    skills: [
      { id: 'prd-techspec-align', name: 'PRD 需求点承接覆盖核查', syncedToLocal: true, desc: '逐条核验 PRD 验收项是否有接口与表结构支撑' },
      { id: 'golden-contract-extractor', name: '前后端 OpenAPI 黄金契约提取', syncedToLocal: true, desc: '锁定字段名、类型、64位精度与错误码枚举' },
      { id: 'dba-schema-concurrency', name: 'MySQL 索引与高并发事务军规', syncedToLocal: true, desc: '大事务、慢 SQL、缓存击穿与回滚兼容性审查' },
    ],
    allowedMcpTools: ['confluence.read_diff', 'git_worktree.inspect_tree', 'apifox_mcp.sync_schema', 'mysql_mcp.explain_readonly'],
  },
  {
    id: 'ai-reviewer',
    name: 'AI 全栈代码审查官',
    handle: '@ai-reviewer',
    stageLabel: '3. 跨仓代码联审 (FE + BE + QA)',
    accountStrategy: 'MR 作者个人 Codex/Claude 账号 -> 团队兜底池',
    sandboxMode: '线上 Codex CLI 多仓 Worktree 沙箱 (read-only)',
    description: '在同一沙箱同时挂载 PRD、技术方案契约、前端 MR 与后端 MR，执行跨仓库字段对齐检查、需求偏离检测与安全漏洞审计。',
    skills: [
      { id: 'cross-repo-contract-diff', name: '前后端跨仓库 DTO/TS 契约比对', syncedToLocal: true, desc: '自动比对前端请求/解构与后端 Controller/VO' },
      { id: 'java-go-concurrency-guard', name: '后端并发、锁与事务边界审查', syncedToLocal: true, desc: '云-端同源规则：同步下发至本地 CLAUDE.md / AGENTS.md' },
      { id: 'fe-security-and-perf', name: '前端 XSS 防护与渲染性能基线', syncedToLocal: true, desc: '云-端同源规则：同步编译为 .cursor/rules/*.mdc' },
    ],
    allowedMcpTools: ['git_worktree.ripgrep', 'gitlab.post_diff_note', 'yunxiao_codeup.set_merge_status'],
  },
  {
    id: 'ai-qa',
    name: 'AI 测试架构师',
    handle: '@ai-qa',
    stageLabel: '4. 测试用例评审 & 边界生成',
    accountStrategy: 'QA 个人账号 -> 质量工程共享池',
    sandboxMode: 'Codex CLI + API 混合模式',
    description: '结合 PRD 黑盒验收标准与前后端真实代码 Diff 白盒分支，评估云效 Testhub 用例覆盖度并一键补全遗漏逆向用例。',
    skills: [
      { id: 'ac-blackbox-coverage', name: 'PRD 验收标准黑盒映射矩阵', syncedToLocal: true, desc: '确保每条业务规则至少对应正向与逆向用例' },
      { id: 'whitebox-branch-scanner', name: '代码 Diff 隐藏分支白盒补漏', syncedToLocal: true, desc: '识别研发新增的限流、兜底、重试分支并补充测试点' },
    ],
    allowedMcpTools: ['yunxiao_testhub.list_cases', 'yunxiao_testhub.batch_import_cases', 'jira.link_bug'],
  },
  {
    id: 'ai-sre',
    name: 'AI 发布与风险审计官',
    handle: '@ai-sre',
    stageLabel: '5. 需求上线 RBOM 终审 & DAG 编排',
    accountStrategy: '架构与 SRE 高可靠专号池',
    sandboxMode: '线上 Codex CLI 容器沙箱 (禁止直接触发生产部署)',
    description: '盘点单需求 RBOM 物料（MR、SQL、配置项），推导多服务无损发布先后拓扑顺序（Release DAG），诊断 Jenkins/云效构建日志。',
    skills: [
      { id: 'rbom-config-sql-auditor', name: '上线新增配置项与 DDL 遗漏核查', syncedToLocal: true, desc: '扫描 @Value / process.env 与上线清单交叉比对' },
      { id: 'microservice-dag-planner', name: '跨服务向后兼容与发布顺序编排', syncedToLocal: false, desc: '自动排列 DB -> 配置 -> 下游RPC -> 上游BFF -> 前端顺序' },
    ],
    allowedMcpTools: ['release_hub.verify_rbom', 'jenkins.read_console_log', 'yunxiao_flow.check_artifact'],
  },
];

export interface CustomPluginItem {
  id: string;
  name: string;
  runtime: 'CODEX_SKILL_MCP' | 'CONTAINER_RUNNER' | 'WEBHOOK' | 'UI_WIDGET';
  boundStage: string;
  hook: string;
  author: string;
  enabled: boolean;
  isBeta?: boolean;
  blockSeverity: string;
  description: string;
}

export const INITIAL_PLUGINS: CustomPluginItem[] = [
  {
    id: 'fe-be-contract-guardian',
    name: '前后端接口契约与 64 位精度守卫',
    runtime: 'CODEX_SKILL_MCP',
    boundStage: '代码审核 / 需求上线',
    hook: 'ON_STAGE_REVIEW',
    author: '架构组',
    enabled: true,
    blockSeverity: 'CRITICAL 阻断合并',
    description: '向云端 Codex CLI 沙箱动态挂载内部 Apifox MCP 与跨仓 DTO 比对 Skill，拦截字段拼写与 Long 精度丢失。',
  },
  {
    id: 'yearning-sql-static-gate',
    name: 'DBA Yearning 生产 SQL 静态审计器',
    runtime: 'CONTAINER_RUNNER',
    boundStage: '技术方案 / 需求上线',
    hook: 'ON_PRE_RELEASE',
    author: 'DBA 团队',
    enabled: true,
    blockSeverity: 'CRITICAL 阻断上线',
    description: '挂载 /workspace 运行容器化 SQL 解析脚本，强制检查索引区分度、禁止无主键表与高危 DROP COLUMN。',
  },
  {
    id: 'feishu-interactive-card',
    name: '飞书/钉钉门禁豁免与上线战报卡片',
    runtime: 'WEBHOOK',
    boundStage: '全流程五阶段',
    hook: 'ON_POST_STAGE',
    author: '研发效能组',
    enabled: true,
    blockSeverity: '仅通知不阻断',
    description: '当出现门禁阻断申请豁免或生产编排发布完成时，自动推送交互式通知卡片至对应项目群。',
  },
  {
    id: 'perf-flamegraph-widget',
    name: '预发压测基线对比 UI 插件面板',
    runtime: 'UI_WIDGET',
    boundStage: '测试用例评审 / 需求上线',
    hook: 'UI_COCKPIT_SLOT',
    author: '性能测试组',
    enabled: true,
    isBeta: true,
    blockSeverity: 'P99 退化 >20% 告警',
    description: '实验性新插件：在需求作战室嵌入核心接口基准压测 P99 延迟对比微卡片。',
  },
];

export interface ComputeAccountItem {
  id: string;
  name: string;
  owner: string;
  scope: '个人托管 (BYOA)' | '专岗高配池' | '团队公共兜底池';
  authMode: 'Codex CLI OAuth (auth.json)' | 'OpenAI / 网关 API Key' | 'Claude Code Enterprise Key';
  model: string;
  status: 'ACTIVE' | 'RATE_LIMITED' | 'STANDBY';
  quotaUsedPct: number;
  todayTasks: number;
}

export const INITIAL_ACCOUNTS: ComputeAccountItem[] = [
  {
    id: 'acc-zhangsan',
    name: '张三个人 Codex CLI 账号',
    owner: '张三 (后端开发)',
    scope: '个人托管 (BYOA)',
    authMode: 'Codex CLI OAuth (auth.json)',
    model: 'gpt-5-codex (medium)',
    status: 'ACTIVE',
    quotaUsedPct: 62,
    todayTasks: 19,
  },
  {
    id: 'acc-arch-pro',
    name: '架构组 Pro 深度推理专号 #01',
    owner: '架构委员会',
    scope: '专岗高配池',
    authMode: 'Codex CLI OAuth (auth.json)',
    model: 'gpt-5-codex (high)',
    status: 'ACTIVE',
    quotaUsedPct: 44,
    todayTasks: 11,
  },
  {
    id: 'acc-team-pool-01',
    name: '交易研发部公共共享池 #01',
    owner: '团队共享算力池',
    scope: '团队公共兜底池',
    authMode: 'OpenAI / 网关 API Key',
    model: 'gpt-5-codex',
    status: 'ACTIVE',
    quotaUsedPct: 31,
    todayTasks: 48,
  },
  {
    id: 'acc-team-pool-02',
    name: '交易研发部公共共享池 #02 (Claude 混合)',
    owner: '团队共享算力池',
    scope: '团队公共兜底池',
    authMode: 'Claude Code Enterprise Key',
    model: 'claude-sonnet-4-5',
    status: 'STANDBY',
    quotaUsedPct: 18,
    todayTasks: 22,
  },
];
