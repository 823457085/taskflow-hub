import React from 'react';
import { Button, Tag } from 'antd';
import { navigateWorkspace, requirementIdFromRoute, requirementReviewStageForSection, SECTION_LABELS, type WorkspaceSection } from './workspaceNavigation';
import { REVIEW_STAGE_OPTIONS } from './workspaceApi';
import type { AssetKind, OverviewStageStat, Stage } from './workspaceApi';
import './DeliveryFlowGuide.css';

const STAGE_MATERIALS: Partial<Record<Stage, AssetKind>> = {
  PRD: 'PRD', TECH_SPEC: 'TECH_SPEC', CODE_REVIEW: 'CODE', TEST_CASE: 'TEST_CASE', RELEASE: 'RELEASE_PLAN',
};
const SECTIONS = Object.keys(SECTION_LABELS) as WorkspaceSection[];

export const DeliveryFlowGuide: React.FC<{ breakdown?: Partial<Record<Stage, OverviewStageStat>> }> = ({ breakdown }) => (
  <ul className="tf-overview-stages" aria-label="交付环节">
    {REVIEW_STAGE_OPTIONS.map(stage => {
      const counts = breakdown?.[stage.value];
      const kind = STAGE_MATERIALS[stage.value];
      const reviewSection = stage.value === 'PRD' ? 'tasks' : SECTIONS.find(section => requirementReviewStageForSection(section) === stage.value);
      return <li key={stage.value}>
        <Button type="text" size="small" className="tf-overview-stage-link" onClick={() => {
          if (reviewSection) navigateWorkspace(reviewSection, { requirementId: requirementIdFromRoute() });
          else navigateWorkspace('reviews', { stage: stage.value });
        }}>{stage.label}</Button>
        <span className="tf-overview-stage-counts">
          {!!counts?.pendingApproval && <Tag color="processing">待审 {counts.pendingApproval}</Tag>}
          {!!counts?.awaitingReport && <Tag color="warning">待报告 {counts.awaitingReport}</Tag>}
          {!!counts?.changesRequested && <Tag color="error">退回 {counts.changesRequested}</Tag>}
          {counts && <Tag color={counts.approved ? 'success' : 'default'}>已过 {counts.approved}</Tag>}
        </span>
        {kind
          ? <Button type="text" size="small" aria-label={`查看${stage.label}材料`} onClick={() => navigateWorkspace('assets', { kind })}>材料</Button>
          : <Button type="text" size="small" onClick={() => navigateWorkspace('tasks')}>任务</Button>}
      </li>;
    })}
  </ul>
);
