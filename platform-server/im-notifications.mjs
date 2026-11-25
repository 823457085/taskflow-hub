import { createHmac, randomUUID } from 'node:crypto';
import { fail, textField } from './common.mjs';
import { createKeyLoader, httpRequestRaw, maskUrlPreview, redactText, sealSecret, unsealSecret, validateRemoteUrl } from './crypto-http.mjs';

export const IM_CHANNELS = ['feishu', 'dingtalk', 'wecom', 'generic'];
export const IM_EVENTS = ['REPORT_SUBMITTED', 'CRITICAL_BLOCKER', 'DECISION_MADE', 'WEBHOOK_TRIGGERED', 'MR_WRITEBACK'];

export function buildImPayload({ channel, signingSecret = '', title, markdownBody, linkUrl = '', rawEvent = {} }) {
  if (channel === 'feishu') {
    const template = rawEvent.hasCritical || rawEvent.decision === 'REQUEST_CHANGES'
      ? 'red'
      : rawEvent.decision === 'APPROVE'
        ? 'green'
        : 'blue';
    const elements = [{ tag: 'markdown', content: markdownBody }];
    if (linkUrl) {
      elements.push({
        tag: 'action',
        actions: [{
          tag: 'button',
          text: { tag: 'plain_text', content: '前往 TaskFlow 查看处理' },
          type: 'primary',
          url: linkUrl,
        }],
      });
    }
    const payload = {
      msg_type: 'interactive',
      card: {
        header: {
          template,
          title: { tag: 'plain_text', content: title.slice(0, 120) },
        },
        elements,
      },
    };
    if (signingSecret) {
      const timestamp = String(Math.floor(Date.now() / 1000));
      const sign = createHmac('sha256', `${timestamp}\n${signingSecret}`).digest('base64');
      payload.timestamp = timestamp;
      payload.sign = sign;
    }
    return { targetUrlSuffix: '', payload };
  }

  if (channel === 'dingtalk') {
    let targetUrlSuffix = '';
    if (signingSecret) {
      const timestamp = String(Date.now());
      const sign = encodeURIComponent(createHmac('sha256', signingSecret).update(`${timestamp}\n${signingSecret}`).digest('base64'));
      targetUrlSuffix = `timestamp=${timestamp}&sign=${sign}`;
    }
    return {
      targetUrlSuffix,
      payload: {
        msgtype: 'markdown',
        markdown: {
          title: title.slice(0, 120),
          text: `### ${title}\n\n${markdownBody}${linkUrl ? `\n\n[前往 TaskFlow 查看](${linkUrl})` : ''}`,
        },
      },
    };
  }

  if (channel === 'wecom') {
    return {
      targetUrlSuffix: '',
      payload: {
        msgtype: 'markdown',
        markdown: {
          content: `### ${title}\n${markdownBody}${linkUrl ? `\n> [前往 TaskFlow 查看](${linkUrl})` : ''}`,
        },
      },
    };
  }

  return {
    targetUrlSuffix: '',
    payload: {
      title,
      markdown: markdownBody,
      linkUrl: linkUrl || null,
      ...rawEvent,
      sentAt: new Date().toISOString(),
    },
  };
}

export function createImNotifications({ db, dbPath, transaction, audit, projectRole, key, allowLoopbackHttp = false, publicOrigin = '', logger = console }) {
  const loadKey = createKeyLoader(dbPath, key);

  const serializeRow = row => ({
    id: row.id,
    projectId: row.project_id,
    channel: row.channel,
    name: row.name,
    urlPreview: row.url_preview,
    hasSigningSecret: !!row.signing_secret,
    events: JSON.parse(row.events || '[]'),
    enabled: row.enabled === 1,
    createdBy: row.created_by,
    createdAt: row.created_at,
    lastSentAt: row.last_sent_at || null,
    lastError: row.last_error || null,
  });

  const requireAdminOrLead = (user, projectId) => {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权管理 IM 通知配置');
    const role = projectRole(user, projectId);
    if (!['ADMIN', 'LEAD'].includes(role) && user.role !== 'ADMIN') {
      fail(403, 'FORBIDDEN', '仅项目负责人或系统管理员可管理 IM 通知配置');
    }
    return role;
  };

  async function deliverSingle(row, eventPayload) {
    const { url: rawWebhookUrl } = unsealSecret(loadKey, [row.id, row.project_id, row.channel, 'url'], row.webhook_url);
    const signingSecret = row.signing_secret
      ? unsealSecret(loadKey, [row.id, row.project_id, row.channel, 'secret'], row.signing_secret).secret
      : '';
    const secrets = [rawWebhookUrl, signingSecret].filter(Boolean);
    const { targetUrlSuffix, payload } = buildImPayload({
      channel: row.channel,
      signingSecret,
      title: eventPayload.title,
      markdownBody: eventPayload.markdownBody,
      linkUrl: eventPayload.linkUrl,
      rawEvent: eventPayload.rawEvent || {},
    });
    let finalUrl = rawWebhookUrl;
    if (targetUrlSuffix) {
      finalUrl += (rawWebhookUrl.includes('?') ? '&' : '?') + targetUrlSuffix;
    }
    const now = new Date().toISOString();
    try {
      const res = await httpRequestRaw(finalUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: payload,
        timeoutMs: 10_000,
        maxBytes: 262_144,
        secrets,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`HTTP ${res.status}: ${res.text.slice(0, 300)}`);
      }
      let parsedBody = null;
      try { parsedBody = JSON.parse(res.text); } catch { /* plain 200 OK */ }
      if (parsedBody && ((parsedBody.errcode !== undefined && parsedBody.errcode !== 0) || (parsedBody.code !== undefined && parsedBody.code !== 0 && parsedBody.StatusCode !== 0))) {
        const msg = parsedBody.errmsg || parsedBody.msg || JSON.stringify(parsedBody).slice(0, 200);
        throw new Error(String(msg));
      }
      db.prepare('UPDATE project_im_webhooks SET last_sent_at=?,last_error=NULL WHERE id=?').run(now, row.id);
      db.prepare('INSERT INTO im_notification_logs VALUES (?,?,?,?,?,?,?,?,?)').run(
        randomUUID(), row.id, row.project_id, row.channel, eventPayload.eventType, 'SENT', eventPayload.title.slice(0, 200), null, now
      );
      return { ok: true };
    } catch (error) {
      const safeError = redactText(error?.message || '发送失败', secrets);
      db.prepare('UPDATE project_im_webhooks SET last_error=? WHERE id=?').run(safeError, row.id);
      db.prepare('INSERT INTO im_notification_logs VALUES (?,?,?,?,?,?,?,?,?)').run(
        randomUUID(), row.id, row.project_id, row.channel, eventPayload.eventType, 'FAILED', eventPayload.title.slice(0, 200), safeError, now
      );
      return { ok: false, error: safeError };
    }
  }

  function buildTaskLink(taskId, jobId) {
    if (!publicOrigin) return '';
    const base = publicOrigin.replace(/\/$/, '');
    const params = new URLSearchParams({ view: 'tasks', task: taskId, tab: 'reviews' });
    if (jobId) params.set('job', jobId);
    return `${base}/#${params.toString()}`;
  }

  async function emitProjectEvent({ projectId, eventType, title, markdownBody, taskId = '', jobId = '', rawEvent = {} }) {
    const rows = db.prepare('SELECT * FROM project_im_webhooks WHERE project_id=? AND enabled=1').all(projectId);
    if (!rows.length) return [];
    const linkUrl = taskId ? buildTaskLink(taskId, jobId) : '';
    const matched = rows.filter(row => {
      const events = JSON.parse(row.events || '[]');
      return !events.length || events.includes(eventType);
    });
    if (!matched.length) return [];
    const results = [];
    for (const row of matched) {
      try {
        results.push({ id: row.id, ...(await deliverSingle(row, { eventType, title, markdownBody, linkUrl, rawEvent })) });
      } catch (err) {
        logger.error('IM notification failed:', err?.message || 'unknown');
      }
    }
    return results;
  }

  function validateEvents(rawEvents) {
    if (rawEvents === undefined) return [...IM_EVENTS];
    if (!Array.isArray(rawEvents) || !rawEvents.length || rawEvents.some(e => !IM_EVENTS.includes(e))) {
      fail(400, 'INVALID_INPUT', '通知事件类型不受支持');
    }
    return [...new Set(rawEvents)];
  }

  async function handle({ method, path, user, body, send, reauthorize }) {
    const listMatch = path.match(/^\/api\/projects\/([^/]+)\/(notifications|notification-logs)$/);
    if (listMatch) {
      const [, projectId, resource] = listMatch;
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权访问项目通知配置');
      projectRole(user, projectId);
      if (resource === 'notification-logs') {
        if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 GET');
        const logs = db.prepare('SELECT id,im_webhook_id AS imWebhookId,project_id AS projectId,channel,event_type AS eventType,status,summary,error,created_at AS createdAt FROM im_notification_logs WHERE project_id=? ORDER BY rowid DESC LIMIT 50').all(projectId);
        send(200, { logs });
        return true;
      }
      if (method === 'GET') {
        const rows = db.prepare('SELECT * FROM project_im_webhooks WHERE project_id=? ORDER BY rowid DESC').all(projectId);
        send(200, { notifications: rows.map(serializeRow) });
        return true;
      }
      if (method === 'POST') {
        requireAdminOrLead(user, projectId);
        const channel = textField(body.channel, 'channel', { max: 32 });
        if (!IM_CHANNELS.includes(channel)) fail(400, 'INVALID_CHANNEL', 'IM 渠道仅支持 feishu / dingtalk / wecom / generic');
        const name = textField(body.name, 'name', { max: 100 });
        const webhookUrl = validateRemoteUrl(body.webhookUrl, { allowLoopbackHttp, allowQuery: true, trimTrailingSlash: false, field: 'webhookUrl' });
        const events = validateEvents(body.events);
        const enabled = body.enabled === undefined ? true : !!body.enabled;
        const signingSecret = body.signingSecret === undefined || body.signingSecret === '' ? '' : textField(body.signingSecret, 'signingSecret', { max: 512, preserve: true });
        const id = randomUUID();
        const now = new Date().toISOString();
        const sealedUrl = sealSecret(loadKey, [id, projectId, channel, 'url'], { url: webhookUrl });
        const sealedSecret = signingSecret ? sealSecret(loadKey, [id, projectId, channel, 'secret'], { secret: signingSecret }) : null;
        transaction(() => {
          reauthorize?.();
          requireAdminOrLead(user, projectId);
          db.prepare('INSERT INTO project_im_webhooks (id,project_id,channel,name,webhook_url,url_preview,signing_secret,events,enabled,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)')
            .run(id, projectId, channel, name, sealedUrl, maskUrlPreview(webhookUrl), sealedSecret, JSON.stringify(events), enabled ? 1 : 0, user.id, now);
          audit(user.id, 'IM_WEBHOOK_CREATE', id, projectId);
        });
        send(201, { notification: serializeRow(db.prepare('SELECT * FROM project_im_webhooks WHERE id=?').get(id)) });
        return true;
      }
      fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式');
    }

    const itemMatch = path.match(/^\/api\/projects\/([^/]+)\/notifications\/([^/]+)(?:\/(test))?$/);
    if (!itemMatch) return false;
    const [, projectId, notifId, action] = itemMatch;
    requireAdminOrLead(user, projectId);
    const existing = db.prepare('SELECT * FROM project_im_webhooks WHERE id=? AND project_id=?').get(notifId, projectId);
    if (!existing) fail(404, 'NOTIFICATION_NOT_FOUND', 'IM 通知配置不存在');

    if (action === 'test') {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
      const project = db.prepare('SELECT key,name FROM projects WHERE id=?').get(projectId);
      const outcome = await deliverSingle(existing, {
        eventType: 'TEST',
        title: `TaskFlow 通知连通测试 · ${project?.key || projectId}`,
        markdownBody: `**项目**：${project?.name || projectId}\n**通知机器人**：${existing.name}\n**状态**：已连通，后续评审提交、阻断告警与审批流转将自动推送到此群。`,
        linkUrl: publicOrigin ? `${publicOrigin.replace(/\/$/, '')}/#view=connections` : '',
        rawEvent: { eventType: 'TEST', projectId },
      });
      if (!outcome.ok) fail(502, 'IM_DELIVERY_FAILED', `通知测试发送失败：${outcome.error}`);
      audit(user.id, 'IM_WEBHOOK_TEST', existing.id, projectId);
      send(200, { ok: true, notification: serializeRow(db.prepare('SELECT * FROM project_im_webhooks WHERE id=?').get(existing.id)) });
      return true;
    }

    if (method === 'PATCH') {
      const name = body.name === undefined ? existing.name : textField(body.name, 'name', { max: 100 });
      const enabled = body.enabled === undefined ? existing.enabled === 1 : !!body.enabled;
      const events = body.events === undefined ? JSON.parse(existing.events || '[]') : validateEvents(body.events);
      let sealedUrl = existing.webhook_url;
      let urlPreview = existing.url_preview;
      if (body.webhookUrl !== undefined && body.webhookUrl !== '') {
        const nextUrl = validateRemoteUrl(body.webhookUrl, { allowLoopbackHttp, allowQuery: true, trimTrailingSlash: false, field: 'webhookUrl' });
        sealedUrl = sealSecret(loadKey, [existing.id, projectId, existing.channel, 'url'], { url: nextUrl });
        urlPreview = maskUrlPreview(nextUrl);
      }
      let sealedSecret = existing.signing_secret;
      if (body.signingSecret !== undefined) {
        sealedSecret = body.signingSecret === '' ? null : sealSecret(loadKey, [existing.id, projectId, existing.channel, 'secret'], { secret: textField(body.signingSecret, 'signingSecret', { max: 512, preserve: true }) });
      }
      transaction(() => {
        reauthorize?.();
        requireAdminOrLead(user, projectId);
        db.prepare('UPDATE project_im_webhooks SET name=?,webhook_url=?,url_preview=?,signing_secret=?,events=?,enabled=? WHERE id=? AND project_id=?')
          .run(name, sealedUrl, urlPreview, sealedSecret, JSON.stringify(events), enabled ? 1 : 0, existing.id, projectId);
        audit(user.id, 'IM_WEBHOOK_UPDATE', existing.id, projectId);
      });
      send(200, { notification: serializeRow(db.prepare('SELECT * FROM project_im_webhooks WHERE id=?').get(existing.id)) });
      return true;
    }

    if (method === 'DELETE') {
      transaction(() => {
        reauthorize?.();
        requireAdminOrLead(user, projectId);
        db.prepare('DELETE FROM project_im_webhooks WHERE id=? AND project_id=?').run(existing.id, projectId);
        audit(user.id, 'IM_WEBHOOK_DELETE', existing.id, projectId);
      });
      send(204);
      return true;
    }

    fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式');
  }

  return { handle, emitProjectEvent };
}
