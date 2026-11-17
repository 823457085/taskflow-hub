import { useEffect, useRef, useState } from 'react';
import { App, Button, Card, Descriptions, Modal, Skeleton, Space, Typography } from 'antd';
import { StatusBadge } from '../components/Primitives';
import { ApiError, api, timeText } from './workspaceApi';

interface MergeRequest {
  assetId: string;
  provider: 'gitlab' | 'yunxiao';
  repositoryId: string;
  number: string;
  title: string;
  url?: string;
  sourceBranch?: string;
  targetBranch?: string;
  state?: string;
  headSha?: string;
  merged?: boolean;
  mergeCommit?: string;
  mergedAt?: string;
  reviewed?: { headSha: string; sourceBranch: string; targetBranch: string };
  reviewId?: string;
  reason?: string;
  error?: string;
}

const providerName = (mr: MergeRequest) => mr.provider === 'yunxiao' ? 'Codeup' : 'GitLab';

export function TaskMergeRequests({ taskId, taskVersion, approvedJobId, active, readOnly, onImport, onUnauthorized }: {
  taskId: string; taskVersion: number; approvedJobId?: string; active: boolean; readOnly: boolean;
  onImport?: () => void; onUnauthorized: () => void;
}) {
  const { message } = App.useApp();
  const [items, setItems] = useState<MergeRequest[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [failed, setFailed] = useState(false);
  const [confirming, setConfirming] = useState<MergeRequest | null>(null);
  const [merging, setMerging] = useState(false);
  const unauthorized = useRef(onUnauthorized);
  unauthorized.current = onUnauthorized;
  const path = `tasks/${taskId}/merge-requests`;

  useEffect(() => {
    if (!active) return;
    let current = true;
    setLoading(true);
    void api<{ items: MergeRequest[] }>(path).then(({ items: next }) => {
      if (current) { setItems(next); setFailed(false); }
    }).catch((error: unknown) => {
      if (!current) return;
      setFailed(true);
      if (error instanceof ApiError && error.status === 401) unauthorized.current();
      else void message.error(error instanceof Error ? error.message : '同步合并请求失败');
    }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [path, active, taskVersion, approvedJobId, refresh, message]);

  async function merge() {
    if (!confirming?.reviewId || merging) return;
    setMerging(true);
    try {
      const result = await api<{ mergeCommit?: string; alreadyMerged?: boolean }>(`${path}/${confirming.assetId}/merge`, { expectedReviewId: confirming.reviewId });
      void message.success(result.alreadyMerged ? '平台记录显示此请求已合并' : '平台已确认合并');
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) unauthorized.current();
      else void message.error(error instanceof Error ? error.message : '合并请求失败');
    } finally {
      setMerging(false);
      setConfirming(null);
      setRefresh(value => value + 1);
    }
  }

  return <Card id="workspace-merge-requests" title="合并请求" extra={<Space wrap>
    {onImport && <Button size="small" onClick={onImport}>关联 MR</Button>}
    <Button size="small" loading={loading} disabled={merging} onClick={() => setRefresh(value => value + 1)}>同步平台状态</Button>
  </Space>}>
    {loading && !items && <Skeleton active title={false} paragraph={{ rows: 2 }} />}
    {!loading && !failed && items?.length === 0 && <Typography.Text type="secondary">从 Codeup 或 GitLab 导入实际 MR 后，可在这里同步状态并发起合并。</Typography.Text>}
    {failed && <Typography.Text type="secondary">状态待同步</Typography.Text>}
    {!!items?.length && <div className="tf-detail-stack tf-detail-stack-small">{items.map(mr => <div key={mr.assetId}>
      <Space wrap>
        <Typography.Text strong>{providerName(mr)} #{mr.number}</Typography.Text>
        {mr.url ? <Typography.Link href={mr.url} target="_blank" rel="noreferrer">{mr.title}</Typography.Link> : <Typography.Text>{mr.title}</Typography.Text>}
        {mr.merged && <StatusBadge variant="green">已合并</StatusBadge>}
        {mr.state && <Typography.Text code>{mr.state}</Typography.Text>}
        {mr.reviewId && !readOnly && <Button type="primary" size="small" disabled={loading || failed || merging} onClick={() => setConfirming(mr)}>合并到目标分支</Button>}
      </Space>
      <Descriptions size="small" column={1} items={[
        ...(mr.sourceBranch && mr.targetBranch ? [{ key: 'branches', label: '源分支 → 目标分支', children: `${mr.sourceBranch} → ${mr.targetBranch}` }] : []),
        ...(mr.reviewed?.headSha ? [{ key: 'reviewed', label: '评审材料提交', children: <Typography.Text code copyable>{mr.reviewed.headSha}</Typography.Text> }] : []),
        ...(mr.headSha && mr.headSha !== mr.reviewed?.headSha ? [{ key: 'head', label: '远端源分支提交', children: <Typography.Text code copyable>{mr.headSha}</Typography.Text> }] : []),
        ...(mr.mergeCommit ? [{ key: 'merged', label: '合并提交', children: <Typography.Text code copyable>{mr.mergeCommit}</Typography.Text> }] : []),
        ...(mr.mergedAt ? [{ key: 'time', label: '合并时间', children: timeText(mr.mergedAt) }] : []),
      ]} />
      {(mr.reason || mr.error) && <Typography.Text type="secondary">{mr.error || mr.reason}</Typography.Text>}
    </div>)}</div>}
    <Modal title="确认合并" open={active && !!confirming} okText="确认合并" cancelText="取消" confirmLoading={merging}
      cancelButtonProps={{ disabled: merging }} closable={!merging} maskClosable={false}
      onCancel={() => { if (!merging) setConfirming(null); }} onOk={() => void merge()}>
      {confirming && <Descriptions size="small" column={1} items={[
        { key: 'mr', label: '合并请求', children: `${providerName(confirming)} #${confirming.number} · ${confirming.title}` },
        { key: 'repo', label: '仓库', children: confirming.repositoryId },
        { key: 'branches', label: '源分支 → 目标分支', children: `${confirming.sourceBranch} → ${confirming.targetBranch}` },
        { key: 'sha', label: '已批准提交', children: <Typography.Text code>{confirming.reviewed?.headSha}</Typography.Text> },
      ]} />}
    </Modal>
  </Card>;
}
