import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { ApiError, ASSET_ROLES, KINDS, REVIEW_ROLES, assetRow, fail, sha, taskRow, textField } from './common.mjs';
import { createKeyLoader, sealSecret, unsealSecret } from './crypto-http.mjs';
import { reviewRequired } from './workflow.mjs';

export const WEBHOOK_PROVIDERS = ['gitlab', 'confluence', 'generic'];
const JIRA_KEY_RE = /\b([A-Z][A-Z0-9]*-[1-9]\d*)\b/g;

function safeTokenEqual(left, right) {
  if (typeof left !== 'string' || typeof right !== 'string' || !left || !right) return false;
  const a = Buffer.from(sha(left), 'hex');
  const b = Buffer.from(sha(right), 'hex');
  return timingSafeEqual(a, b);
}

function safeHmacEqual(rawBody, secret, signatureHeader) {
  if (typeof signatureHeader !== 'string' || !signatureHeader) return false;
  const clean = signatureHeader.replace(/^sha256=/i, '').trim();
  if (!/^[0-9a-f]{64}$/i.test(clean)) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const provided = Buffer.from(clean, 'hex');
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}

function extractJiraKeys(...texts) {
  const keys = [];
  const seen = new Set();
  for (const text of texts) {
    if (typeof text !== 'string' || !text) continue;
    for (const match of text.matchAll(JIRA_KEY_RE)) {
      const k = match[1].toUpperCase();
      if (!seen.has(k)) {
        seen.add(k);
        keys.push(k);
      }
    }
  }
  return keys;
}

export function createWebhooks({ db, dbPath, transaction, audit, projectRole, workflow, connectorsInternal, cloudAi, imNotifications, key }) {
  const loadKey = createKeyLoader(dbPath, key);

  const requireAdminOrLead = (user, projectId) => {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权管理 Webhook 配置');
    const role = projectRole(user, projectId);
    if (!['ADMIN', 'LEAD'].includes(role) && user.role !== 'ADMIN') {
      fail(403, 'FORBIDDEN', '仅项目负责人或系统管理员可管理 Webhook');
    }
    return role;
  };

  const serializeHook = row => ({
    id: row.id,
    projectId: row.project_id,
    provider: row.provider,
    name: row.name,
    secretPreview: row.secret_preview,
    enabled: row.enabled === 1,
    autoReview: row.auto_review === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastTriggeredAt: row.last_triggered_at || null,
    lastStatus: row.last_status || null,
    lastMessage: row.last_message || null,
    webhookPath: `/api/webhooks/${row.project_id}/${row.id}`,
  });

  function findMatchingTask(projectId, candidateKeys = [], externalRefMatch = null) {
    for (const keyItem of candidateKeys) {
      const row = db.prepare("SELECT * FROM tasks WHERE project_id=? AND UPPER(jira_key)=? AND status!='DONE'").get(projectId, keyItem.toUpperCase());
      if (row) return taskRow(row);
    }
    if (externalRefMatch?.resource && externalRefMatch?.externalId) {
      const row = db.prepare(`
        SELECT t.* FROM tasks t
        JOIN assets a ON a.task_id=t.id
        JOIN (
          SELECT local_id, resource, external_id FROM external_imports
          UNION ALL
          SELECT local_id, resource, external_id FROM account_external_imports
        ) i ON i.local_id=a.id
        WHERE t.project_id=? AND t.status!='DONE' AND i.resource=? AND i.external_id=?
        ORDER BY a.rowid DESC LIMIT 1
      `).get(projectId, externalRefMatch.resource, externalRefMatch.externalId);
      if (row) return taskRow(row);
    }
    return null;
  }

  function saveIdempotentAsset({ task, kind, logicalKey, title, content, sourceUrl, actorId }) {
    const latest = db.prepare('SELECT * FROM assets WHERE task_id=? AND kind=? AND logical_key=? ORDER BY revision DESC LIMIT 1')
      .get(task.id, kind, logicalKey);
    const contentHash = sha(content);
    if (latest && latest.sha256 === contentHash) {
      return { asset: assetRow(latest), created: false };
    }
    const revision = (latest?.revision || 0) + 1;
    const id = randomUUID();
    const now = new Date().toISOString();
    transaction(() => {
      db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, task.id, task.projectId, kind, logicalKey, title.slice(0, 200), content.slice(0, 65_536), sourceUrl || null, revision, contentHash, actorId, now);
      db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(now, task.id);
      audit(actorId, 'WEBHOOK_ASSET_SYNC', id, task.projectId);
    });
    return { asset: assetRow(db.prepare('SELECT * FROM assets WHERE id=?').get(id)), created: true };
  }

  async function maybeAutoReview({ task, stage, actorId, webhookAutoReview }) {
    if (!webhookAutoReview || !reviewRequired(task, stage)) return null;
    const executor = cloudAi?.getCloudExecutor(task.projectId);
    if (!executor) return null;
    if (Array.isArray(executor.autoStages) && executor.autoStages.length && !executor.autoStages.includes(stage)) {
      return { skipped: true, reason: `项目云端 AI 未启用 ${stage} 阶段自动触发` };
    }
    const actorRow = db.prepare('SELECT * FROM users WHERE id=?').get(actorId);
    if (!actorRow) return null;
    let role;
    try { role = projectRole(actorRow, task.projectId); } catch { return null; }
    if (!REVIEW_ROLES[role]?.includes(stage)) return null;
    const currentInputs = workflow.inputs(task, stage);
    if (currentInputs.missing.length) {
      return { skipped: true, reason: `缺少前置材料: ${currentInputs.missing.join('、')}` };
    }
    const created = workflow.createReview(task, actorRow, role, { stage, executionMode: 'CLOUD_AI' });
    if (created.job.report) return { job: created.job, reused: true };
    const execResult = await cloudAi.executeJob({ jobId: created.job.id, actorId: actorRow.id });
    return { job: execResult.job, writeback: execResult.writeback || null };
  }

  function recordEvent({ webhookId, projectId, provider, eventType, taskId = null, status, summary }) {
    const now = new Date().toISOString();
    db.prepare('UPDATE project_webhooks SET last_triggered_at=?,last_status=?,last_message=? WHERE id=?')
      .run(now, status, summary.slice(0, 500), webhookId);
    db.prepare('INSERT INTO webhook_events VALUES (?,?,?,?,?,?,?,?,?)')
      .run(randomUUID(), webhookId, projectId, provider, eventType, taskId, status, summary.slice(0, 500), now);
  }

  async function handleInbound({ req, path, send }) {
    const match = path.match(/^\/api\/webhooks\/([^/]+)\/([^/]+)$/);
    if (!match) return false;
    if (req.method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', 'Webhook 仅支持 POST');
    const [, projectId, hookId] = match;
    const hook = db.prepare('SELECT * FROM project_webhooks WHERE id=? AND project_id=?').get(hookId, projectId);
    if (!hook || hook.enabled !== 1) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook 不存在或已停用');

    let size = 0;
    const chunks = [];
    for await (const chunk of req) {
      size += chunk.length;
      if (size > 1_048_576) fail(413, 'BODY_TOO_LARGE', 'Webhook 请求体过大');
      chunks.push(chunk);
    }
    const rawBuffer = Buffer.concat(chunks);
    const rawText = rawBuffer.toString('utf8');

    const { token: expectedSecret } = unsealSecret(loadKey, [hook.id, hook.project_id, hook.provider, 'webhook'], hook.secret);
    const gitlabToken = req.headers['x-gitlab-token'];
    const customToken = req.headers['x-taskflow-webhook-token'] || req.headers['x-webhook-token'];
    const bearer = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
    const sigHeader = req.headers['x-taskflow-signature-256'] || req.headers['x-hub-signature-256'];

    const authed = [gitlabToken, customToken, bearer].some(t => safeTokenEqual(t, expectedSecret))
      || safeHmacEqual(rawBuffer, expectedSecret, sigHeader);
    if (!authed) fail(401, 'WEBHOOK_UNAUTHORIZED', 'Webhook 验签失败');

    let payload;
    try { payload = JSON.parse(rawText); } catch { fail(400, 'INVALID_JSON', 'Webhook 请求体必须为有效 JSON'); }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) fail(400, 'INVALID_INPUT', 'Webhook 请求体必须为对象');

    const actorId = hook.created_by;

    try {
      if (hook.provider === 'gitlab' && (payload.object_kind === 'merge_request' || payload.event_type === 'merge_request' || payload.object_attributes?.iid)) {
        const mr = payload.object_attributes || {};
        const repoId = String(payload.project?.id || mr.target_project_id || payload.project?.path_with_namespace || '');
        const mrIid = String(mr.iid || '');
        const mrTitle = String(mr.title || `MR !${mrIid}`);
        const sourceBranch = String(mr.source_branch || '');
        const targetBranch = String(mr.target_branch || '');
        const state = String(mr.state || 'opened');
        const keys = extractJiraKeys(mrTitle, sourceBranch, String(mr.description || ''));
        const task = findMatchingTask(projectId, keys, repoId && mrIid ? { resource: 'gitlab_mr', externalId: `${repoId}!${mrIid}` } : null);
        if (!task) {
          const msg = `GitLab MR !${mrIid}（${mrTitle}）未匹配到项目进行中任务`;
          recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: 'gitlab_mr', status: 'IGNORED', summary: msg });
          send(200, { processed: false, status: 'IGNORED', message: msg });
          return true;
        }
        if (['closed'].includes(state.toLowerCase())) {
          const msg = `GitLab MR !${mrIid} 状态为 ${state}，跳过代码触发`;
          recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: 'gitlab_mr', taskId: task.id, status: 'IGNORED', summary: msg });
          send(200, { processed: false, status: 'IGNORED', taskId: task.id, message: msg });
          return true;
        }

        let importedAsset = null;
        let assetCreated = false;
        const sysRow = connectorsInternal?.projectRowForSystem?.(projectId, 'gitlab');
        const actorRow = db.prepare('SELECT * FROM users WHERE id=?').get(actorId);
        if (sysRow && actorRow && repoId && mrIid) {
          try {
            const readRes = await connectorsInternal.readResource('gitlab', sysRow, { resource: 'gitlab_mr', repositoryId: repoId, mrIid }, actorRow, () => sysRow);
            if (!readRes.truncated) {
              const impRes = connectorsInternal.importResource('gitlab', sysRow, actorRow, { taskId: task.id, kind: 'CODE' }, readRes);
              importedAsset = impRes.asset;
              assetCreated = impRes.imported;
            }
          } catch { /* fall back to webhook payload snapshot */ }
        }
        if (!importedAsset) {
          const contentPayload = Array.isArray(payload.diffs)
            ? JSON.stringify({ iid: Number(mrIid) || 0, title: mrTitle, description: mr.description || '', state, sha: mr.last_commit?.id || '', diffs: payload.diffs }, null, 2)
            : [
                `# GitLab MR !${mrIid} · ${mrTitle}`,
                `- 分支：\`${sourceBranch}\` → \`${targetBranch}\``,
                `- 状态：${state}`,
                mr.last_commit?.id ? `- Commit：\`${mr.last_commit.id}\`` : '',
                mr.last_commit?.message ? `- 提交说明：${mr.last_commit.message}` : '',
                mr.url ? `- 链接：${mr.url}` : '',
                mr.description ? `\n## 变更说明\n${String(mr.description)}` : '',
              ].filter(Boolean).join('\n');
          const saved = saveIdempotentAsset({
            task,
            kind: 'CODE',
            logicalKey: `gitlab:mr:${repoId || 'repo'}!${mrIid || '0'}`,
            title: `!${mrIid} · ${mrTitle}`,
            content: contentPayload,
            sourceUrl: typeof mr.url === 'string' && /^https?:\/\//i.test(mr.url) ? mr.url : null,
            actorId,
          });
          importedAsset = saved.asset;
          assetCreated = saved.created;
        }

        const refreshedTask = taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
        const reviewResult = await maybeAutoReview({ task: refreshedTask, stage: 'CODE_REVIEW', actorId, webhookAutoReview: hook.auto_review === 1 });
        const summary = `GitLab MR !${mrIid} 已同步至 ${task.jiraKey}（CODE r${importedAsset.revision}${assetCreated ? ' 新增' : ' 复用'}）${reviewResult?.job ? '，已触发云端 AI 代码审核' : ''}`;
        recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: 'gitlab_mr', taskId: task.id, status: 'PROCESSED', summary });

        if (imNotifications) {
          void imNotifications.emitProjectEvent({
            projectId,
            eventType: 'WEBHOOK_TRIGGERED',
            taskId: task.id,
            jobId: reviewResult?.job?.id || '',
            title: `GitLab MR Webhook 触发 · ${task.jiraKey}`,
            markdownBody: `**MR**：!${mrIid} · ${mrTitle}\n**分支**：\`${sourceBranch}\` → \`${targetBranch}\`\n**处理**：${summary}`,
            rawEvent: { eventType: 'WEBHOOK_TRIGGERED', provider: 'gitlab', taskId: task.id },
          });
        }
        send(200, { processed: true, status: 'PROCESSED', taskId: task.id, asset: importedAsset, review: reviewResult });
        return true;
      }

      if (hook.provider === 'gitlab' && payload.object_kind === 'push') {
        const commits = Array.isArray(payload.commits) ? payload.commits : [];
        const branch = String(payload.ref || '').replace(/^refs\/heads\//, '');
        const keys = extractJiraKeys(branch, ...commits.map(c => c.message || ''));
        const task = findMatchingTask(projectId, keys);
        if (!task) {
          const msg = `GitLab Push (${branch}) 未匹配到项目进行中任务`;
          recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: 'gitlab_push', status: 'IGNORED', summary: msg });
          send(200, { processed: false, status: 'IGNORED', message: msg });
          return true;
        }
        const content = [
          `# GitLab Push · ${branch}`,
          `- After SHA：\`${payload.after || ''}\``,
          '',
          '## 提交记录',
          ...commits.slice(0, 20).map(c => `- \`${String(c.id || '').slice(0, 8)}\` ${String(c.message || '').split(/\r?\n/)[0]}`),
        ].join('\n');
        const saved = saveIdempotentAsset({
          task,
          kind: 'CODE',
          logicalKey: `gitlab:push:${branch || 'main'}`,
          title: `Push · ${branch || 'main'}`,
          content,
          sourceUrl: null,
          actorId,
        });
        const refreshedTask = taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
        const reviewResult = await maybeAutoReview({ task: refreshedTask, stage: 'CODE_REVIEW', actorId, webhookAutoReview: hook.auto_review === 1 });
        const summary = `GitLab Push (${branch}) 已同步至 ${task.jiraKey}（CODE r${saved.asset.revision}）`;
        recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: 'gitlab_push', taskId: task.id, status: 'PROCESSED', summary });
        send(200, { processed: true, status: 'PROCESSED', taskId: task.id, asset: saved.asset, review: reviewResult });
        return true;
      }

      // Confluence or Generic Document / Spec Webhook
      const pageId = payload.page?.id ? String(payload.page.id) : payload.pageId ? String(payload.pageId) : '';
      const rawTitle = String(payload.page?.title || payload.title || '');
      const taskKey = typeof payload.taskKey === 'string' ? payload.taskKey.toUpperCase() : '';
      const keys = taskKey ? [taskKey] : extractJiraKeys(rawTitle, String(payload.content || ''));
      const requestedKind = KINDS.includes(payload.kind) ? payload.kind : 'PRD';
      const task = findMatchingTask(projectId, keys, pageId ? { resource: 'confluence_page', externalId: pageId } : null);
      if (!task) {
        const msg = `文档事件（${rawTitle || pageId || 'untitled'}）未匹配到项目进行中任务`;
        recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: hook.provider, status: 'IGNORED', summary: msg });
        send(200, { processed: false, status: 'IGNORED', message: msg });
        return true;
      }

      let importedAsset = null;
      let assetCreated = false;
      if (pageId && hook.provider === 'confluence') {
        const sysRow = connectorsInternal?.projectRowForSystem?.(projectId, 'confluence');
        const actorRow = db.prepare('SELECT * FROM users WHERE id=?').get(actorId);
        if (sysRow && actorRow) {
          try {
            const readRes = await connectorsInternal.readResource('confluence', sysRow, { resource: 'confluence_page', pageId }, actorRow, () => sysRow);
            const impRes = connectorsInternal.importResource('confluence', sysRow, actorRow, { taskId: task.id, kind: requestedKind }, readRes);
            importedAsset = impRes.asset;
            assetCreated = impRes.imported;
          } catch { /* fall back to inline content if provided */ }
        }
      }
      if (!importedAsset) {
        const contentText = typeof payload.content === 'string' && payload.content.trim()
          ? payload.content
          : `# ${rawTitle || `Confluence Page ${pageId}`}\n\n- 事件：${payload.event || 'page_updated'}\n- 页面 ID：${pageId || 'N/A'}`;
        const saved = saveIdempotentAsset({
          task,
          kind: requestedKind,
          logicalKey: pageId ? `confluence:page:${pageId}` : `${hook.provider}:doc:${requestedKind}`,
          title: rawTitle || `${task.jiraKey} · ${requestedKind}`,
          content: contentText,
          sourceUrl: typeof payload.sourceUrl === 'string' && /^https?:\/\//i.test(payload.sourceUrl) ? payload.sourceUrl : null,
          actorId,
        });
        importedAsset = saved.asset;
        assetCreated = saved.created;
      }

      const stageMap = { PRD: 'PRD', TECH_SPEC: 'TECH_SPEC', CODE: 'CODE_REVIEW', TEST_CASE: 'TEST_CASE', RELEASE_PLAN: 'RELEASE' };
      const targetStage = stageMap[requestedKind];
      const refreshedTask = taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
      const reviewResult = targetStage
        ? await maybeAutoReview({ task: refreshedTask, stage: targetStage, actorId, webhookAutoReview: hook.auto_review === 1 })
        : null;
      const summary = `${hook.provider.toUpperCase()} 文档更新已同步至 ${task.jiraKey}（${requestedKind} r${importedAsset.revision}${assetCreated ? ' 新增' : ' 复用'}）${reviewResult?.job ? '，已触发云端 AI 评审' : ''}`;
      recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: hook.provider, taskId: task.id, status: 'PROCESSED', summary });

      if (imNotifications) {
        void imNotifications.emitProjectEvent({
          projectId,
          eventType: 'WEBHOOK_TRIGGERED',
          taskId: task.id,
          jobId: reviewResult?.job?.id || '',
          title: `文档变更 Webhook 触发 · ${task.jiraKey}`,
          markdownBody: `**来源**：${hook.provider.toUpperCase()} · ${rawTitle || pageId}\n**处理**：${summary}`,
          rawEvent: { eventType: 'WEBHOOK_TRIGGERED', provider: hook.provider, taskId: task.id },
        });
      }

      send(200, { processed: true, status: 'PROCESSED', taskId: task.id, asset: importedAsset, review: reviewResult });
      return true;
    } catch (error) {
      const errMsg = error instanceof ApiError ? error.message : 'Webhook 处理失败';
      recordEvent({ webhookId: hook.id, projectId, provider: hook.provider, eventType: hook.provider, status: 'FAILED', summary: errMsg });
      throw error;
    }
  }

  async function handle({ method, path, user, body, send, reauthorize }) {
    const listMatch = path.match(/^\/api\/projects\/([^/]+)\/(webhooks|webhook-events)$/);
    if (listMatch) {
      const [, projectId, resource] = listMatch;
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权访问 Webhook 配置');
      projectRole(user, projectId);
      if (resource === 'webhook-events') {
        if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
        const events = db.prepare('SELECT id,webhook_id AS webhookId,project_id AS projectId,provider,event_type AS eventType,task_id AS taskId,status,summary,created_at AS createdAt FROM webhook_events WHERE project_id=? ORDER BY rowid DESC LIMIT 50').all(projectId);
        send(200, { events });
        return true;
      }
      if (method === 'GET') {
        const rows = db.prepare('SELECT * FROM project_webhooks WHERE project_id=? ORDER BY rowid DESC').all(projectId);
        send(200, { webhooks: rows.map(serializeHook) });
        return true;
      }
      if (method === 'POST') {
        requireAdminOrLead(user, projectId);
        const provider = textField(body.provider, 'provider', { max: 32 });
        if (!WEBHOOK_PROVIDERS.includes(provider)) fail(400, 'INVALID_PROVIDER', 'Webhook 来源仅支持 gitlab / confluence / generic');
        const name = textField(body.name, 'name', { max: 100 });
        const autoReview = body.autoReview === undefined ? true : !!body.autoReview;
        const enabled = body.enabled === undefined ? true : !!body.enabled;
        const rawSecret = body.secret && String(body.secret).trim()
          ? textField(body.secret, 'secret', { min: 12, max: 256, preserve: true })
          : `tfwh_${randomBytes(24).toString('base64url')}`;
        const id = randomUUID();
        const now = new Date().toISOString();
        const sealed = sealSecret(loadKey, [id, projectId, provider, 'webhook'], { token: rawSecret });
        const preview = rawSecret.length > 8 ? `${rawSecret.slice(0, 4)}...${rawSecret.slice(-4)}` : '****';
        transaction(() => {
          reauthorize?.();
          requireAdminOrLead(user, projectId);
          db.prepare('INSERT INTO project_webhooks (id,project_id,provider,name,secret,secret_preview,enabled,auto_review,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)')
            .run(id, projectId, provider, name, sealed, preview, enabled ? 1 : 0, autoReview ? 1 : 0, user.id, now);
          audit(user.id, 'WEBHOOK_CREATE', id, projectId);
        });
        send(201, { webhook: serializeHook(db.prepare('SELECT * FROM project_webhooks WHERE id=?').get(id)), secret: rawSecret });
        return true;
      }
      fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式');
    }

    const itemMatch = path.match(/^\/api\/projects\/([^/]+)\/webhooks\/([^/]+)$/);
    if (!itemMatch) return false;
    const [, projectId, hookId] = itemMatch;
    requireAdminOrLead(user, projectId);
    const existing = db.prepare('SELECT * FROM project_webhooks WHERE id=? AND project_id=?').get(hookId, projectId);
    if (!existing) fail(404, 'WEBHOOK_NOT_FOUND', 'Webhook 配置不存在');

    if (method === 'PATCH') {
      const name = body.name === undefined ? existing.name : textField(body.name, 'name', { max: 100 });
      const enabled = body.enabled === undefined ? existing.enabled === 1 : !!body.enabled;
      const autoReview = body.autoReview === undefined ? existing.auto_review === 1 : !!body.autoReview;
      transaction(() => {
        reauthorize?.();
        requireAdminOrLead(user, projectId);
        db.prepare('UPDATE project_webhooks SET name=?,enabled=?,auto_review=? WHERE id=? AND project_id=?')
          .run(name, enabled ? 1 : 0, autoReview ? 1 : 0, existing.id, projectId);
        audit(user.id, 'WEBHOOK_UPDATE', existing.id, projectId);
      });
      send(200, { webhook: serializeHook(db.prepare('SELECT * FROM project_webhooks WHERE id=?').get(existing.id)) });
      return true;
    }

    if (method === 'DELETE') {
      transaction(() => {
        reauthorize?.();
        requireAdminOrLead(user, projectId);
        db.prepare('DELETE FROM project_webhooks WHERE id=? AND project_id=?').run(existing.id, projectId);
        audit(user.id, 'WEBHOOK_DELETE', existing.id, projectId);
      });
      send(204);
      return true;
    }

    fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式');
  }

  return { handleInbound, handle };
}
