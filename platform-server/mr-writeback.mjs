import { randomUUID } from 'node:crypto';
import { ApiError, APPROVAL_ROLES, REVIEW_ROLES, fail, taskRow, textField } from './common.mjs';
import { mergeRequestPath } from './merge-requests.mjs';
import { requireReviewableTask } from './workflow.mjs';

export function parseFindingLineLocation(rawLocation) {
  if (!rawLocation || typeof rawLocation !== 'string') return null;
  let cleaned = rawLocation.trim().replace(/^file:\/\//i, '');
  if (!cleaned || /[\r\n\x00]/.test(cleaned) || cleaned.includes(' ')) return null;

  let lineNumber = null;
  const hashMatch = cleaned.match(/^(.*?)#L(\d+)(?:-L?\d+)?$/i);
  if (hashMatch) {
    cleaned = hashMatch[1];
    lineNumber = Number(hashMatch[2]);
  } else {
    const colonMatch = cleaned.match(/^(.*?):(\d+)(?::\d+|-\d+)?$/);
    if (colonMatch) {
      cleaned = colonMatch[1];
      lineNumber = Number(colonMatch[2]);
    }
  }
  const normalized = cleaned.replace(/\\/g, '/').replace(/^\/+/, '').trim();
  if (!normalized || !lineNumber || !Number.isInteger(lineNumber) || lineNumber < 1) return null;
  const segments = normalized.split('/').filter(Boolean);
  if (!segments.length || segments.includes('..') || !segments.at(-1).includes('.')) return null;
  return { filePath: segments.join('/'), lineNumber };
}

function severityTag(severity) {
  return { CRITICAL: '🔴 阻断问题 (CRITICAL)', WARN: '🟡 风险提醒 (WARN)', INFO: '🔵 改进建议 (INFO)' }[severity] || severity;
}

function formatInlineFindingBody(finding, task, job) {
  return [
    `**[TaskFlow AI 评审 · ${severityTag(finding.severity)}]** ${finding.title}`,
    '',
    finding.detail,
    '',
    `<sub>任务 ${task.jiraKey} · Job \`${job.id.slice(0, 8)}\`</sub>`,
  ].join('\n');
}

function formatSummaryNoteBody({ task, job, summaryFindings, inlinePostedCount, inlineFindingsCount }) {
  const criticalCount = job.findings.filter(f => f.severity === 'CRITICAL' && !f.waiver).length;
  const warnCount = job.findings.filter(f => f.severity === 'WARN').length;
  const infoCount = job.findings.filter(f => f.severity === 'INFO').length;
  const lines = [
    `## TaskFlow 代码评审意见（${task.jiraKey}）`,
    `- **阶段状态**：${job.status} · **来源**：${job.report?.source || 'UNKNOWN'}${job.report?.tool ? ` (${job.report.tool})` : ''}`,
    `- **问题统计**：阻断 ${criticalCount} / 风险 ${warnCount} / 建议 ${infoCount}（已发送行内评论 ${inlinePostedCount}/${inlineFindingsCount} 条）`,
    '',
    '### 评审结论',
    job.report?.summary || '（无摘要）',
  ];
  if (job.report?.evidence) {
    lines.push('', '### 核对依据', job.report.evidence.slice(0, 1500));
  }
  if (summaryFindings.length) {
    lines.push('', `### 发现项明细 (${summaryFindings.length})`);
    for (const f of summaryFindings.slice(0, 30)) {
      lines.push(`- **${severityTag(f.severity)}** ${f.title}${f.location ? ` (\`${f.location}\`)` : ''}\n  - ${f.detail.replace(/\n+/g, ' ')}`);
    }
  }
  lines.push('', `<sub>TaskFlow Job ID: \`${job.id}\`</sub>`);
  return lines.join('\n').slice(0, 60_000);
}

export function createMrWriteback({ db, workflow, getTask, projectRole, audit, connectorsInternal, imNotifications }) {
  const listLinkedMrs = taskId => {
    const rows = db.prepare(`
      SELECT a.id, a.title, a.source_url, i.resource, i.external_id, i.remote_version
      FROM assets a JOIN (
        SELECT local_id, resource, external_id, remote_version FROM external_imports
          WHERE task_id=? AND resource IN ('gitlab_mr', 'yunxiao_mr')
        UNION ALL
        SELECT local_id, resource, external_id, remote_version FROM account_external_imports
          WHERE task_id=? AND resource IN ('gitlab_mr', 'yunxiao_mr')
      ) i ON i.local_id=a.id WHERE a.task_id=? AND a.kind='CODE' ORDER BY a.rowid DESC
    `).all(taskId, taskId, taskId);
    const out = [];
    const seen = new Set();
    for (const row of rows) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      const provider = row.resource === 'gitlab_mr' ? 'gitlab' : 'yunxiao';
      const match = provider === 'gitlab'
        ? /^(.+)!([1-9]\d{0,15})$/.exec(row.external_id)
        : /^([\w-]+):([1-9]\d{0,15})!([1-9]\d{0,15})$/.exec(row.external_id);
      if (!match) continue;
      const { baseUrl, mergeSnapshot: snapshot } = JSON.parse(row.remote_version);
      const [repositoryId, number] = match.slice(-2);
      out.push({
        assetId: row.id,
        provider,
        baseUrl,
        repositoryId,
        number,
        organizationId: provider === 'yunxiao' ? match[1] : null,
        title: row.title,
        url: row.source_url,
        snapshot,
      });
    }
    return out;
  };

  async function writeback({ taskId, assetId = null, jobId, user = null, actorId = null, mode = 'MANUAL', includeSummary = true, reauthorize }) {
    const task = mode === 'MANUAL'
      ? getTask(taskId, user)
      : taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(taskId));
    if (!task) return { skipped: true, reason: '任务不存在' };
    if (mode === 'MANUAL' && task.status === 'DONE') fail(409, 'TASK_DONE', '任务已完成，请先重开任务');

    const jobRowRaw = db.prepare('SELECT * FROM jobs WHERE id=? AND task_id=?').get(jobId, taskId);
    if (!jobRowRaw) fail(404, 'JOB_NOT_FOUND', '评审任务不存在');
    if (jobRowRaw.stage !== 'CODE_REVIEW') fail(400, 'INVALID_STAGE', '仅代码审核阶段的评审意见支持回写到合并请求');
    requireReviewableTask(task, jobRowRaw.stage);
    const job = workflow.jobRow(jobRowRaw, task);
    if (!job.report) fail(409, 'REPORT_REQUIRED', '请先提交代码评审报告，再回写到合并请求');

    const linked = listLinkedMrs(taskId);
    const ref = assetId ? linked.find(item => item.assetId === assetId) : linked[0];
    if (!ref) {
      if (mode === 'AUTO') return { skipped: true, reason: '任务尚未关联 GitLab 或 Codeup 合并请求资产' };
      fail(404, 'MR_NOT_LINKED', '任务未关联此合并请求，请先从 GitLab 或 Codeup 导入 MR');
    }

    let row;
    if (mode === 'MANUAL') {
      const role = projectRole(user, task.projectId);
      if (!REVIEW_ROLES[role]?.includes('CODE_REVIEW') && !APPROVAL_ROLES.CODE_REVIEW.includes(role)) {
        fail(403, 'FORBIDDEN', '当前项目角色无权回写评审意见');
      }
      row = connectorsInternal.selectedRow(user, task.projectId, ref.provider);
      if (row.base_url !== ref.baseUrl || (ref.provider === 'yunxiao' && row.organization_id !== ref.organizationId)) {
        fail(409, 'MR_SOURCE_CHANGED', '当前账号与已关联的合并请求来源不一致');
      }
    } else {
      row = connectorsInternal.projectRowForSystem(task.projectId, ref.provider);
      if (!row || row.base_url !== ref.baseUrl || (ref.provider === 'yunxiao' && row.organization_id !== ref.organizationId)) {
        return { skipped: true, reason: '未配置匹配来源的项目级代码平台账号，请在任务页手动回写' };
      }
    }

    const { remote, mergeRequests } = connectorsInternal;
    const prefix = mergeRequestPath(ref.provider, ref);
    let diffRefs = null;
    let codeupPatchsets = null;

    if (ref.provider === 'gitlab') {
      try {
        const { data: mrData } = await mergeRequests.read(row, ref);
        if (mrData?.diff_refs?.base_sha && mrData?.diff_refs?.start_sha && mrData?.diff_refs?.head_sha) {
          diffRefs = mrData.diff_refs;
        }
      } catch { /* fall back to summary note */ }
    } else {
      try {
        const psRes = await remote(ref.provider, row, `${prefix}/patchSets`);
        const list = Array.isArray(psRes?.data) ? psRes.data : [];
        if (list.length >= 2) {
          codeupPatchsets = { from: list[0]?.patchSetBizId || list[0]?.commitId, to: list.at(-1)?.patchSetBizId || list.at(-1)?.commitId };
        }
      } catch { /* patchSets optional; fall back to global comment */ }
    }

    const inlineCandidates = [];
    const nonInlineFindings = [];
    for (const finding of job.findings) {
      if (finding.waiver) continue;
      const anchor = parseFindingLineLocation(finding.location);
      if (anchor) inlineCandidates.push({ finding, anchor });
      else nonInlineFindings.push(finding);
    }

    let inlinePostedCount = 0;
    const fallbackFindings = [...nonInlineFindings];
    const commentErrors = [];

    for (const { finding, anchor } of inlineCandidates.slice(0, 15)) {
      const bodyText = formatInlineFindingBody(finding, task, job);
      try {
        if (ref.provider === 'gitlab' && diffRefs) {
          await remote('gitlab', row, `${prefix}/discussions`, {
            method: 'POST',
            body: {
              body: bodyText,
              position: {
                position_type: 'text',
                base_sha: diffRefs.base_sha,
                start_sha: diffRefs.start_sha,
                head_sha: diffRefs.head_sha,
                new_path: anchor.filePath,
                new_line: anchor.lineNumber,
              },
            },
          });
          inlinePostedCount += 1;
        } else if (ref.provider === 'yunxiao' && codeupPatchsets?.from && codeupPatchsets?.to) {
          await remote('yunxiao', row, `${prefix}/comments`, {
            method: 'POST',
            body: {
              comment_type: 'INLINE_COMMENT',
              content: bodyText,
              draft: false,
              file_path: `/${anchor.filePath.replace(/^\/+/, '')}`,
              line_number: anchor.lineNumber,
              from_patchset_biz_id: codeupPatchsets.from,
              patchset_biz_id: codeupPatchsets.to,
            },
          });
          inlinePostedCount += 1;
        } else {
          fallbackFindings.push(finding);
        }
      } catch (err) {
        fallbackFindings.push(finding);
        commentErrors.push(err?.message || '行内定位失败');
      }
    }

    let summaryPosted = 0;
    if (includeSummary || fallbackFindings.length || inlinePostedCount === 0) {
      const summaryBody = formatSummaryNoteBody({
        task,
        job,
        summaryFindings: fallbackFindings,
        inlinePostedCount,
        inlineFindingsCount: inlineCandidates.length,
      });
      if (ref.provider === 'gitlab') {
        await remote('gitlab', row, `${prefix}/notes`, {
          method: 'POST',
          body: { body: summaryBody },
        });
      } else {
        await remote('yunxiao', row, `${prefix}/comments`, {
          method: 'POST',
          body: {
            comment_type: 'GLOBAL_COMMENT',
            content: summaryBody,
            draft: false,
          },
        });
      }
      summaryPosted = 1;
    }

    if (mode === 'MANUAL' && reauthorize) reauthorize();

    const postedCount = inlinePostedCount + summaryPosted;
    const effectiveActorId = user?.id || actorId || 'system';
    const recordId = randomUUID();
    const now = new Date().toISOString();
    db.prepare('INSERT INTO mr_writebacks VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run(
      recordId, taskId, task.projectId, ref.assetId, job.id, ref.provider, postedCount, inlinePostedCount, summaryPosted, effectiveActorId, mode, now
    );
    audit(effectiveActorId, 'MR_REVIEW_WRITEBACK', ref.assetId, task.projectId);

    if (imNotifications) {
      void imNotifications.emitProjectEvent({
        projectId: task.projectId,
        eventType: 'MR_WRITEBACK',
        taskId: task.id,
        jobId: job.id,
        title: `MR 评审意见已回写 · ${task.jiraKey}`,
        markdownBody: `**合并请求**：${ref.provider.toUpperCase()} #${ref.number} · ${ref.title}\n**回写结果**：行内评论 ${inlinePostedCount} 条 + 总结评论 ${summaryPosted} 条（方式：${mode === 'AUTO' ? '自动回写' : '手动回写'}）`,
        rawEvent: { eventType: 'MR_WRITEBACK', taskId: task.id, jobId: job.id, inlinePostedCount, summaryPosted },
      });
    }

    return {
      skipped: false,
      writeback: {
        id: recordId,
        taskId,
        assetId: ref.assetId,
        jobId: job.id,
        provider: ref.provider,
        number: ref.number,
        postedCount,
        inlineCount: inlinePostedCount,
        summaryPosted: summaryPosted === 1,
        mode,
        fallbackReason: commentErrors[0] || null,
        createdAt: now,
      },
    };
  }

  async function routes({ method, path, user, body, send, reauthorize }) {
    const historyMatch = path.match(/^\/api\/tasks\/([^/]+)\/merge-requests\/writebacks$/);
    if (historyMatch) {
      if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
      const task = getTask(historyMatch[1], user);
      const writebacks = db.prepare('SELECT id,task_id AS taskId,asset_id AS assetId,job_id AS jobId,provider,posted_count AS postedCount,inline_count AS inlineCount,summary_posted AS summaryPosted,actor_id AS actorId,mode,created_at AS createdAt FROM mr_writebacks WHERE task_id=? ORDER BY rowid DESC LIMIT 30').all(task.id).map(r => ({
        ...r,
        summaryPosted: r.summaryPosted === 1,
      }));
      send(200, { writebacks });
      return true;
    }

    const match = path.match(/^\/api\/tasks\/([^/]+)\/merge-requests\/([^/]+)\/writeback$/);
    if (!match) return false;
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '请使用网页登录后回写评审意见');
    const [, taskId, assetId] = match;
    const jobId = textField(body.jobId, 'jobId', { max: 64 });
    const includeSummary = body.includeSummary === undefined ? true : !!body.includeSummary;
    try {
      const result = await writeback({ taskId, assetId, jobId, user, mode: 'MANUAL', includeSummary, reauthorize });
      send(201, result);
      return true;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw error;
    }
  }

  return { writeback, routes };
}
