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
  { id: 'PRD', title: '需求', owner: '产品经理或项目负责人准备，由独立审批人确认',
    input: '从 Jira 接入研发任务，自动识别需求来源单或粘贴 Confluence 短链一键导入 PRD。',
    action: '在任务详情「交付链路 → ① 需求」查看规则检查并触发 AI 审核，检查目标、范围、验收标准与歧义点并提交确认。',
    outcome: '需求结论、评分与逐项检查清单留痕，作为后续任务拆分与方案设计的唯一基线。',
    links: [{ label: '前往任务中心', section: 'tasks' }, { label: '查看需求评审', section: 'reviews', stage: 'PRD' }, { label: '查看需求文档', section: 'assets', kind: 'PRD' }] },
  { id: 'TASK_BREAKDOWN', title: 'Jira 任务与子任务', owner: '研发或项目负责人拆分，由项目负责人确认（建议项）',
    input: '已导入主研发任务并关联其子任务（或一键导入任务描述中声明的 deliverables 事项）。',
    action: '在「② Jira 任务与子任务」触发 AI 拆分审核，核对需求点 → 子任务覆盖映射、三类子任务齐全度与粒度（≤ 3 天）。',
    outcome: '生成需求点到子任务的追溯矩阵，标出遗漏需求点与未导入的 Jira 事项。',
    links: [{ label: '前往任务中心', section: 'tasks' }, { label: '查看拆分审核', section: 'reviews', stage: 'TASK_BREAKDOWN' }] },
  { id: 'TECH_SPEC', title: '技术方案', owner: '研发工程师准备，由项目负责人审批',
    input: '需求已明确，从 Confluence 导入或模板登记技术方案（TECH_SPEC）。',
    action: '在「③ 技术方案」触发 AI 审核，核查需求追溯、接口契约、数据状态、权限键与回滚策略，由项目负责人确认。',
    outcome: '保留方案版本与审核清单；材料变更后旧评审自动标记需重审。',
    links: [{ label: '查看方案审核', section: 'reviews', stage: 'TECH_SPEC' }, { label: '准备技术方案', section: 'assets', kind: 'TECH_SPEC' }] },
  { id: 'CODE_REVIEW', title: '代码 · 分支 · 仓库', owner: '研发工程师开发与提交，由项目负责人审批',
    input: '绑定业务 Git 仓库，确保分支名含 Jira 号，并导入云效 Codeup / GitLab MR 或本地 Git 改动。',
    action: '在「④ 代码 · 分支 · 仓库」核对仓库与分支规范，触发 AI 审核对照技术方案与代码实现，解决阻断项后审批放行。',
    outcome: '代码 diff 快照、MR 关联与审核发现项全留痕；不自动推送或合并远端代码。',
    links: [{ label: '查看代码审核', section: 'reviews', stage: 'CODE_REVIEW' }, { label: '准备代码材料', section: 'assets', kind: 'CODE' }] },
  { id: 'TEST_CASE', title: '测试用例', owner: '测试工程师或研发准备，由测试或项目负责人审批',
    input: '需求、方案与代码就绪，从规格自动推导测试清单或导入测试用例文档。',
    action: '在「⑤ 测试用例」触发 AI 审核，核查验收标准覆盖度、异常边界与联调 / 实机验证安排并提交确认。',
    outcome: '形成用例审核结论与评分；实际测试与实机执行记录同步在任务与联调子任务中留痕。',
    links: [{ label: '查看用例评审', section: 'reviews', stage: 'TEST_CASE' }, { label: '准备测试用例', section: 'assets', kind: 'TEST_CASE' }] },
  { id: 'RELEASE', title: '上线与链路报告', owner: '运维发布人员发起与审批，任务受理人最终核验',
    input: '五项门禁材料齐备，前序环节均已通过，上线计划含发布步骤、灰度与回滚方案。',
    action: '在「⑥ 上线」完成上线审核后，点击「链路审核报告」导出全链路 Markdown 报告，并「一键完成核验」归档任务。',
    outcome: '输出包含结论、评分、阻断项、追溯矩阵与子任务状态的完整报告；实际发布在外部平台执行。',
    links: [{ label: '查看上线审核', section: 'reviews', stage: 'RELEASE' }, { label: '准备上线计划', section: 'assets', kind: 'RELEASE_PLAN' }] },
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
    title={<Space size={8}><Route size={18} /><Typography.Text strong>研发交付链路</Typography.Text>{collapsed && <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>6 环全流程交付链路导览（已收起）</Typography.Text>}</Space>}
    extra={<Space size={4}>
      {!collapsed && <Button type="text" size="small" icon={expanded ? <ChevronUp size={15} /> : <ChevronDown size={15} />} aria-expanded={expanded} aria-controls="delivery-guide-detail" onClick={() => setExpanded(value => !value)}>{expanded ? '收起环节说明' : '查看环节说明'}</Button>}
      <Button type="text" size="small" icon={collapsed ? <ChevronDown size={15} /> : <ChevronUp size={15} />} aria-expanded={!collapsed} onClick={toggleCollapsed}>{collapsed ? '展开导图' : '收起导图'}</Button>
    </Space>}
  >
    {!collapsed && <>
      <Typography.Paragraph type="secondary" className="tf-flow-intro">一条需求对应一条 6 环交付链路：每个环节包含关联对象、规则检查、AI 审核与人工确认，最终汇总生成《交付链路审核报告》。</Typography.Paragraph>
      <ol className="tf-flow-map" aria-label="交付链路环节">{STEPS.map((item, index) => <li key={item.id}>
        <Button id={`delivery-guide-step-${item.id}`} className={`tf-flow-node ${expanded && active === index ? 'is-selected' : ''}`} aria-pressed={expanded && active === index} aria-controls="delivery-guide-detail" onClick={() => { setActive(index); setExpanded(true); }}><span className="tf-flow-number">{String(index + 1).padStart(2, '0')}</span><span className="tf-flow-node-title">{item.title}</span></Button>
      </li>)}</ol>
      {expanded && <section id="delivery-guide-detail" className="tf-flow-detail" aria-labelledby={`delivery-guide-step-${step.id}`} aria-live="polite">
        <div className="tf-flow-detail-heading"><Typography.Title level={3}>{step.title}</Typography.Title><Typography.Text type="secondary">{step.owner}；多人项目须独立审批，单账号模式可本人闭环。</Typography.Text></div>
        <dl className="tf-flow-instructions"><div><dt>准备什么</dt><dd>{step.input}</dd></div><div><dt>要做什么</dt><dd>{step.action}</dd></div><div><dt>完成标志</dt><dd>{step.outcome}</dd></div></dl>
        <Flex gap={8} wrap className="tf-flow-actions">{step.links.map((link, index) => <Button key={link.label} type={index === 0 ? 'primary' : 'default'} icon={index === 0 ? <ArrowRight size={15} /> : undefined} iconPlacement="end" onClick={() => navigateWorkspace(link.section, { stage: link.stage, kind: link.kind })}>{link.label}</Button>)}</Flex>
      </section>}
      <div className="tf-flow-footnotes">
        <Flex align="center" justify="space-between" gap={12} wrap><Typography.Text type="secondary">每个环节均需 AI 审核并确认；实际代码合并与发布受控触发，不自动改动 Jira 状态。</Typography.Text><Space size={16} wrap><Button type="link" size="small" aria-expanded={rulesOpen} aria-controls="delivery-guide-rules" onClick={() => setRulesOpen(value => !value)}>{rulesOpen ? '收起规则' : '门禁规则与能力范围'}</Button><Button type="link" size="small" icon={<Laptop size={15} />} onClick={() => navigateWorkspace('local')}>接入本地 AI</Button></Space></Flex>
        {rulesOpen && <div id="delivery-guide-rules" className="tf-flow-rules"><Typography.Paragraph type="secondary">需求、技术方案、代码、测试、上线 5 项为完成门禁；「② Jira 任务与子任务拆分审核」为建议项（输出需求点覆盖映射、粒度核查与评分，暂不阻断任务完成）。上线审批要求前 4 项门禁均已通过。</Typography.Paragraph><Typography.Paragraph type="secondary">本地 AI（Codex / Gemini / Cursor / Claude）按本环节清单执行审查并返回结论、评分与检查清单；材料变更后旧评审自动标记需重审。</Typography.Paragraph></div>}
      </div>
    </>}
  </Card>;
};
