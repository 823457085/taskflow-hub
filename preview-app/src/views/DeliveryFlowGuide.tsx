import React, { useState } from 'react';
import { Button, Card, Flex, Space, Typography } from 'antd';
import { ArrowRight, ChevronDown, ChevronUp, Laptop, Route } from 'lucide-react';
import type { AssetKind, Stage } from './workspaceApi';
import { navigateWorkspace, type WorkspaceSection } from './workspaceNavigation';
import { readStoredBool, writeStoredBool } from './uiPreferences';
import './DeliveryFlowGuide.css';

interface GuideAction { label: string; section: WorkspaceSection; stage?: Stage; kind?: AssetKind }
interface GuideStep {
  id: string; title: string; owner: string; input: string; action: string; outcome: string;
  links: GuideAction[];
}
const GUIDE_COLLAPSED_KEY = 'taskflow.flowGuide.collapsed';

const STEPS: GuideStep[] = [
  { id: 'tasks', title: '项目与任务', owner: '项目成员参与；系统管理员、项目负责人或产品经理可分配任务',
    input: '项目已接入且有可用的 Jira 连接。准备事项链接或任务号，也可读取项目事项列表选择。',
    action: '到任务中心粘贴 Jira 链接或选择事项，读取后确认接入。系统自动匹配有权限的项目，无需重复填写标题与类型；已有本地任务直接打开。',
    outcome: '每项工作都有任务跟踪。后续材料、评审和开发进度自动关联到对应任务。',
    links: [{ label: '选择项目', section: 'projects' }, { label: '查看任务', section: 'tasks' }] },
  { id: 'PRD', title: '需求评审', owner: '产品经理或项目负责人准备，由独立审批人确认',
    input: '自动识别任务描述中的 Confluence 链接、父事项，或直接粘贴链接一键导入需求文档。',
    action: '在任务详情点击“一键拉取 Confluence 为需求文档”自动导入，再点击“一键 AI 评审需求”生成结构化评审草稿提交，由审批人确认结论。',
    outcome: '需求门禁以审批结果为准。仅提交报告不会自动放行。',
    links: [{ label: '查看需求评审', section: 'reviews', stage: 'PRD' }, { label: '准备需求文档', section: 'assets', kind: 'PRD' }] },
  { id: 'TECH_SPEC', title: '技术方案', owner: '研发工程师或项目负责人准备，由项目负责人审批',
    input: '已有需求文档，通过 Confluence 链接一键导入或“一键模板生成技术方案”登记方案。',
    action: '点击“一键 AI 评审技术方案”对接口、数据模型与风险点生成审查报告，交由项目负责人审批；材料更新后可基于新版本重新评审。',
    outcome: '保留材料版本、评审输入和审批记录。输入变化后旧评审自动标记需重审。',
    links: [{ label: '查看方案审核', section: 'reviews', stage: 'TECH_SPEC' }, { label: '准备技术方案', section: 'assets', kind: 'TECH_SPEC' }] },
  { id: 'CODE_REVIEW', title: '开发与代码审核', owner: '研发工程师或项目负责人开发与评审，由项目负责人审批',
    input: '自动匹配并一键绑定本机 Git 仓库，提取本地 Git 改动或导入云效 Codeup / GitLab 合并请求作为代码材料。',
    action: '在任务详情点“本地 AI 一键处理”直接启动本机 Codex / Gemini / Cursor / Claude 协作或一键在 Finder / Cursor 打开仓库，完成后提取改动并发起代码审核。',
    outcome: '代码快照与评审全留痕；不会自动推送或合并远端代码。',
    links: [{ label: '查看代码审核', section: 'reviews', stage: 'CODE_REVIEW' }, { label: '准备代码材料', section: 'assets', kind: 'CODE' }] },
  { id: 'TEST_CASE', title: '测试用例评审', owner: '测试工程师或项目负责人准备，由测试或项目负责人审批',
    input: '已有需求、方案、代码材料，使用“一键模板生成测试用例”或文档导入登记测试用例。',
    action: '一键启动本机 AI 核对验收项、边界和异常场景覆盖并提交报告，由审批人确认。',
    outcome: '形成用例评审结论。用例评审通过不等于测试已执行或缺陷已清零。',
    links: [{ label: '查看用例评审', section: 'reviews', stage: 'TEST_CASE' }, { label: '准备测试用例', section: 'assets', kind: 'TEST_CASE' }] },
  { id: 'RELEASE', title: '上线审核', owner: '运维发布人员发起与评审，由独立发布人员审批',
    input: '五类材料齐备（含 Jenkins 构建导入或模板生成的上线计划），前四项门禁均已通过。',
    action: '一键核对上线计划、验证与回滚预案并提交评审报告，由审批人确认放行。',
    outcome: '记录上线审核结论；实际发布与回滚在外部平台执行，本平台不自动触发发布。',
    links: [{ label: '查看上线审核', section: 'reviews', stage: 'RELEASE' }, { label: '准备上线计划', section: 'assets', kind: 'RELEASE_PLAN' }] },
  { id: 'complete', title: '核验并完成', owner: '任务受理人或有任务分配权限的成员',
    input: '本任务五项门禁均已通过，所有直接子任务已完成且各自门禁通过。',
    action: '任务详情全流程导航栏自动点亮“一键完成核验”，点击即可完成归档。',
    outcome: '工作可追踪、证据可查。完成父任务会冻结子任务写入；不会自动更改外部 Jira 状态。',
    links: [{ label: '核验任务与门禁', section: 'tasks' }] },
];

export const DeliveryFlowGuide: React.FC = () => {
  const [active, setActive] = useState(0);
  const [collapsed, setCollapsed] = useState(() => readStoredBool(GUIDE_COLLAPSED_KEY, false));
  const [expanded, setExpanded] = useState(false);
  const [rulesOpen, setRulesOpen] = useState(false);
  const step = STEPS[active];

  const toggleCollapsed = () => {
    setCollapsed(prev => {
      const next = !prev;
      writeStoredBool(GUIDE_COLLAPSED_KEY, next);
      return next;
    });
  };

  return <Card
    className="tf-flow-guide"
    title={<Space size={8}><Route size={18} /><Typography.Text strong>研发交付流程</Typography.Text>{collapsed && <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>7 步全流程门禁导览（已收起）</Typography.Text>}</Space>}
    extra={<Space size={4}>
      {!collapsed && <Button type="text" size="small" icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />} aria-expanded={expanded} aria-controls="delivery-guide-detail" onClick={() => setExpanded(value => !value)}>{expanded ? '收起步骤说明' : '查看步骤说明'}</Button>}
      <Button type="text" size="small" icon={collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />} aria-expanded={!collapsed} onClick={toggleCollapsed}>{collapsed ? '展开导图' : '收起导图'}</Button>
    </Space>}
  >
    {!collapsed && <>
      <Typography.Paragraph type="secondary" className="tf-flow-intro">这是建议工作顺序，点击步骤查看“谁来做、做什么、完成后去哪”。导图折叠状态会自动记住。</Typography.Paragraph>
      <ol className="tf-flow-map" aria-label="建议交付顺序">{STEPS.map((item, index) => <li key={item.id}>
        <Button id={`delivery-guide-step-${item.id}`} className={`tf-flow-node ${expanded && active === index ? 'is-selected' : ''}`} aria-pressed={expanded && active === index} aria-controls="delivery-guide-detail" onClick={() => { setActive(index); setExpanded(true); }}><span className="tf-flow-number">{String(index + 1).padStart(2, '0')}</span><span className="tf-flow-node-title">{item.title}</span></Button>
      </li>)}</ol>
      {expanded && <section id="delivery-guide-detail" className="tf-flow-detail" aria-labelledby={`delivery-guide-step-${step.id}`} aria-live="polite">
        <div className="tf-flow-detail-heading"><Typography.Title level={3}>{step.title}</Typography.Title><Typography.Text type="secondary">{step.owner}；系统管理员可参与所有阶段（多人项目须独立审批，单账号模式可本人闭环）。</Typography.Text></div>
        <dl className="tf-flow-instructions"><div><dt>准备什么</dt><dd>{step.input}</dd></div><div><dt>要做什么</dt><dd>{step.action}</dd></div><div><dt>完成标志</dt><dd>{step.outcome}</dd></div></dl>
        <Flex gap={8} wrap className="tf-flow-actions">{step.links.map((link, index) => <Button key={link.label} type={index === 0 ? 'primary' : 'default'} icon={index === 0 ? <ArrowRight size={15} /> : undefined} iconPlacement="end" onClick={() => navigateWorkspace(link.section, { stage: link.stage, kind: link.kind })}>{link.label}</Button>)}<Typography.Text type="secondary">进入页面后，先核对项目，再选择任务。</Typography.Text></Flex>
      </section>}
      <div className="tf-flow-footnotes">
        <Flex align="center" justify="space-between" gap={12} wrap><Typography.Text type="secondary">提交报告后需完成门禁审批；实际发布在外部平台执行。</Typography.Text><Space size={16} wrap><Button type="link" size="small" aria-expanded={rulesOpen} aria-controls="delivery-guide-rules" onClick={() => setRulesOpen(value => !value)}>{rulesOpen ? '收起规则' : '门禁规则与能力范围'}</Button><Button type="link" size="small" icon={<Laptop size={15} />} onClick={() => navigateWorkspace('local')}>接入本地 AI</Button></Space></Flex>
        {rulesOpen && <div id="delivery-guide-rules" className="tf-flow-rules"><Typography.Paragraph type="secondary">前四类评审按所需材料开展，不强制逐步审批解锁；上线审批要求前四项门禁均已通过。多人协作时报告作者和任务受理人不能审批自己的工作，材料变化后旧评审自动提醒重审。</Typography.Paragraph><Typography.Paragraph type="secondary">本地 AI 可按明确授权读取上下文、回传进度与报告。云端 AI 自动执行和流水线自动发布尚未接入。</Typography.Paragraph></div>}
      </div>
    </>}
  </Card>;
};
