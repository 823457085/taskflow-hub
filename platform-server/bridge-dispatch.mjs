import { randomUUID } from 'node:crypto';
import { REVIEW_ROLES, REVIEW_STAGES, fail, textField } from './common.mjs';
import { projectPermissions } from './permissions.mjs';
import { buildAiPrompt } from './ai-prompt.mjs';
import { extractReviewDraft } from './local-automation.mjs';

export const CONTEXT_FILE_PLACEHOLDER = '{{TASKFLOW_CONTEXT_FILE}}';
export const REPO_PATH_PLACEHOLDER = '{{TASKFLOW_REPO_PATH}}';
export const BRIDGE_ENGINES = [
  { id: 'codex', label: 'Codex CLI', tool: 'codex-cli' },
  { id: 'cursor', label: 'Cursor Agent', tool: 'cursor' },
];
export const BRIDGE_MODES = ['read', 'review', 'develop'];
const MODE_LABELS = { read: '任务分析', review: '评审草稿', develop: '代码开发' };
const LEASE_MS = 60_000;
const QUEUE_MS = 30 * 60_000;
const ONLINE_MS = 75_000;
const MAX_ACTIVE = 2;
const MAX_DEVICE_QUEUE = 4;
const OUTPUT_MAX = 64_000;
const PAYLOAD_MAX = 4 * 1024 * 1024;
const WAIT_MAX_S = 25;
const ACTIVE_PHASES = ['CLAIMED', 'EXECUTING'];

const keys = (body, allowed) => {
  if (!body || Object.keys(body).some(key => !allowed.includes(key))) fail(400, 'INVALID_INPUT', '请求包含不支持的字段');
};

export function createBridgeDispatch({ db, transaction, audit, projectRole, getTask, taskRole, assertWritable, assertAncestorsOpen, workflow, allowedModes = ['read', 'review'], now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (allowedModes.some(mode => !BRIDGE_MODES.includes(mode))) throw new Error('bridge modes must be read, review or develop');
  const iso = () => new Date(now()).toISOString();

  const runRow = row => {
    let draft = null;
    if (row.draft_json) { try { draft = JSON.parse(row.draft_json); } catch { draft = null; } }
    const target = row.device_id ? db.prepare('SELECT d.device_name,d.user_id,u.username FROM local_device_sessions d JOIN users u ON u.id=d.user_id WHERE d.id=?').get(row.device_id) : null;
    return {
      deviceName: target?.device_name || null, deviceOwner: target ? { id: target.user_id, username: target.username } : null,
      id: row.id, taskId: row.task_id, projectId: row.project_id, jobId: row.job_id || null,
      actorId: row.actor_id, mode: row.mode, engine: row.engine, tool: row.tool, repoPath: null,
      status: row.status, exitCode: row.exit_code ?? null, output: row.output || '', draft,
      error: row.error || null, startedAt: row.started_at, finishedAt: row.finished_at || null, updatedAt: row.updated_at,
      runner: 'bridge', deviceId: row.device_id, bridgePhase: row.phase, cancelRequested: !!row.cancel_requested,
    };
  };

  const liveDevice = deviceId => db.prepare(`SELECT d.* FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
    WHERE d.id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>?`).get(deviceId, now(), now());
  const memberRole = (userId, projectId) => {
    const owner = db.prepare('SELECT id,role FROM users WHERE id=?').get(userId);
    try { return owner ? projectRole(owner, projectId) : null; } catch { return null; }
  };
  const isOnline = row => !!row.last_seen_at && now() - Date.parse(row.last_seen_at) <= ONLINE_MS;

  function agentsFor(user, projectId) {
    const canAssign = projectPermissions(user, projectRole(user, projectId)).assignTasks;
    return db.prepare(`SELECT d.*,u.username FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash JOIN users u ON u.id=d.user_id
      WHERE d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>? ORDER BY d.last_seen_at DESC, d.created_at DESC LIMIT 500`)
      .all(now(), now())
      .filter(row => JSON.parse(row.project_ids).includes(projectId) && memberRole(row.user_id, projectId))
      .map(row => {
        const mine = row.user_id === user.id; const teamDispatch = !!row.team_dispatch;
        return {
          id: row.id, deviceName: row.device_name, tool: row.tool, owner: { id: row.user_id, username: row.username },
          lastSeenAt: row.last_seen_at, online: isOnline(row), teamDispatch, mine, dispatchable: mine || canAssign && teamDispatch,
        };
      });
  }

  function devicesFor(user) {
    return db.prepare(`SELECT d.* FROM local_device_sessions d JOIN sessions s ON s.token_hash=d.token_hash
      WHERE d.user_id=? AND d.revoked_at IS NULL AND d.expires_at>? AND s.expires_at>? ORDER BY d.last_seen_at DESC, d.created_at DESC LIMIT 50`)
      .all(user.id, now(), now())
      .map(row => ({
        id: row.id, deviceName: row.device_name, tool: row.tool, projectIds: JSON.parse(row.project_ids),
        lastSeenAt: row.last_seen_at, expiresAt: new Date(row.expires_at).toISOString(),
        online: !!row.last_seen_at && now() - Date.parse(row.last_seen_at) <= ONLINE_MS,
      }));
  }

  function sweep() {
    const at = iso();
    db.prepare(`UPDATE local_ai_runs SET status='INTERRUPTED',error=?,finished_at=?,updated_at=?
      WHERE runner='bridge' AND status='RUNNING' AND phase IN ('CLAIMED','EXECUTING') AND lease_until<?`)
      .run('本机 Bridge 超过 60 秒未回报，执行已中断', at, at, now());
    db.prepare(`UPDATE local_ai_runs SET status='INTERRUPTED',error=?,finished_at=?,updated_at=?
      WHERE runner='bridge' AND status='RUNNING' AND phase='QUEUED' AND started_at<?`)
      .run('本机 Bridge 30 分钟内未领取，派发已过期', at, at, new Date(now() - QUEUE_MS).toISOString());
  }

  const requireBrowser = (req, user, mutate = false) => {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权发起或查看派发');
    if (user.authTransport !== 'COOKIE' || mutate && !req.headers.origin) fail(403, 'BROWSER_SESSION_REQUIRED', '请在已登录的平台网页中执行此操作');
  };
  const requireDevice = user => {
    if (!user.localDevice) fail(403, 'BRIDGE_DEVICE_REQUIRED', '仅已配对的本机 Bridge 可领取派发');
    return user.localDevice;
  };

  const ownRun = (user, id) => {
    const row = db.prepare("SELECT * FROM local_ai_runs WHERE id=? AND runner='bridge'").get(id);
    const onMyDevice = row?.device_id && db.prepare('SELECT 1 FROM local_device_sessions WHERE id=? AND user_id=?').get(row.device_id, user.id);
    if (!row || row.actor_id !== user.id && !onMyDevice) fail(404, 'AI_RUN_NOT_FOUND', '本地 AI 执行记录不存在');
    getTask(row.task_id, user);
    return row;
  };
  const deviceRun = (device, id) => {
    const row = db.prepare("SELECT * FROM local_ai_runs WHERE id=? AND runner='bridge' AND device_id=?").get(id, device.id);
    if (!row) fail(404, 'AI_RUN_NOT_FOUND', '派发记录不存在');
    return row;
  };

  function start(req, user, task, body) {
    keys(body, ['mode', 'engine', 'jobId', 'stage', 'autoClaim', 'customInstruction', 'runner', 'deviceId']);
    if (body.runner !== undefined && body.runner !== 'bridge') fail(400, 'INVALID_AI_RUNNER', '服务器部署仅支持派发到已配对的本机 Bridge');
    const mode = body.mode || 'read';
    if (!BRIDGE_MODES.includes(mode)) fail(400, 'INVALID_AI_MODE', '不支持的 AI 执行模式');
    if (!allowedModes.includes(mode)) fail(403, 'BRIDGE_MODE_DISABLED', `当前服务器未开放「${MODE_LABELS[mode]}」派发`);
    const engine = BRIDGE_ENGINES.find(item => item.id === (body.engine || 'codex'));
    if (!engine) fail(400, 'INVALID_AI_ENGINE', '本机 Bridge 支持 Codex 与 Cursor Agent');
    const device = liveDevice(textField(body.deviceId, 'deviceId', { max: 80 }));
    const foreign = !!device && device.user_id !== user.id;
    const teamDispatcher = foreign && projectPermissions(user, taskRole(task, user)).assignTasks;
    if (!device || foreign && (!teamDispatcher || !memberRole(device.user_id, task.projectId))) fail(404, 'BRIDGE_DEVICE_UNAVAILABLE', '所选本机 Bridge 不存在、已撤销或已过期，请重新配对');
    if (!JSON.parse(device.project_ids).includes(task.projectId)) fail(403, 'BRIDGE_DEVICE_PROJECT_SCOPE', '所选本机 Bridge 未获授权访问该项目');
    if (foreign && !device.team_dispatch) fail(403, 'BRIDGE_TEAM_DISPATCH_DISABLED', '该成员尚未在「本机接入」中开启「允许团队派发」');
    sweep();
    const active = db.prepare("SELECT COUNT(*) AS count FROM local_ai_runs WHERE actor_id=? AND runner='bridge' AND status='RUNNING'").get(user.id).count;
    if (active >= MAX_ACTIVE) fail(429, 'AI_RUN_BUSY', `当前已有 ${MAX_ACTIVE} 个派发在排队或执行，请等待完成或停止后再发起`);
    const queued = db.prepare("SELECT COUNT(*) AS count FROM local_ai_runs WHERE device_id=? AND runner='bridge' AND status='RUNNING'").get(device.id).count;
    if (queued >= MAX_DEVICE_QUEUE) fail(429, 'BRIDGE_DEVICE_BUSY', `该设备已有 ${MAX_DEVICE_QUEUE} 个派发在排队或执行，请稍后再派发`);

    let currentTask = getTask(task.id, user);
    const role = taskRole(currentTask, user);
    if (mode !== 'read') assertWritable(currentTask, user);
    if (mode === 'develop' && foreign) {
      if (currentTask.assigneeId !== device.user_id) fail(409, 'BRIDGE_TARGET_NOT_ASSIGNEE', '开发任务需先指派给设备所属成员，再派发到他的本机 Bridge');
    } else if (mode === 'develop') {
      if (!currentTask.assigneeId && body.autoClaim === true) {
        assertAncestorsOpen(currentTask, user);
        transaction(() => {
          const fresh = getTask(currentTask.id, user);
          if (!fresh.assigneeId) {
            db.prepare("UPDATE tasks SET assignee_id=?,status='IN_PROGRESS',version=version+1,context_version=context_version+1,updated_at=? WHERE id=?").run(user.id, iso(), fresh.id);
            audit(user.id, 'TASK_CLAIM', fresh.id, fresh.projectId);
          }
        });
        currentTask = getTask(currentTask.id, user);
      }
      if (currentTask.assigneeId !== user.id && !projectPermissions(user, role).assignTasks) fail(403, 'FORBIDDEN', '请先认领该任务后再派发开发');
    }

    let targetJob = null;
    if (mode === 'review') {
      if (body.jobId) {
        const row = db.prepare('SELECT * FROM jobs WHERE id=?').get(textField(body.jobId, 'jobId', { max: 64 }));
        if (!row || row.task_id !== currentTask.id) fail(404, 'JOB_NOT_FOUND', '指定的本地评审申请不存在');
        const hydrated = workflow.jobRow(row, currentTask);
        if (hydrated.executionMode !== 'LOCAL_REPORT' || hydrated.report || hydrated.decision || hydrated.stale) fail(409, 'JOB_NOT_ELIGIBLE', '该评审申请已过期或已提交报告，请重新发起本地评审');
        if (!REVIEW_ROLES[role]?.includes(hydrated.stage)) fail(403, 'FORBIDDEN', '当前角色无权执行该阶段评审');
        targetJob = hydrated;
      } else {
        if (!REVIEW_STAGES.includes(body.stage)) fail(400, 'STAGE_REQUIRED', '请选择要执行的评审阶段或已有本地评审申请');
        targetJob = workflow.createReview(currentTask, user, role, { stage: body.stage, executionMode: 'LOCAL_REPORT' }).job;
      }
    }

    const customInstruction = body.customInstruction ? textField(body.customInstruction, 'customInstruction', { min: 0, max: 2000, preserve: true }) : '';
    const objective = buildAiPrompt({ mode, task: currentTask, job: targetJob, repoPath: REPO_PATH_PLACEHOLDER, contextFilePath: CONTEXT_FILE_PLACEHOLDER, customInstruction });
    const context = {
      task: currentTask, assets: workflow.assetsFor(currentTask.id), gates: workflow.gates(currentTask),
      ...(targetJob ? { reviewJob: { id: targetJob.id, stage: targetJob.stage, inputHash: targetJob.inputHash }, reviewSnapshot: targetJob.snapshot } : {}),
    };
    const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
    const payload = JSON.stringify({
      title: `${currentTask.jiraKey} · ${currentTask.title}`, objective, context, ...(foreign ? { dispatchedBy: user.username } : {}),
      taskFlowUrl: origin ? `${origin}/#view=tasks&task=${currentTask.id}${targetJob ? `&tab=reviews&job=${targetJob.id}` : ''}` : '',
    });
    if (Buffer.byteLength(payload) > PAYLOAD_MAX) fail(413, 'BRIDGE_PAYLOAD_TOO_LARGE', '任务材料超过 4 MiB，请精简后再派发');

    const id = randomUUID(); const at = iso();
    transaction(() => {
      const fresh = getTask(currentTask.id, user);
      if (mode !== 'read') assertWritable(fresh, user);
      const latest = liveDevice(device.id);
      if (!latest || latest.user_id !== device.user_id || foreign && !latest.team_dispatch) fail(404, 'BRIDGE_DEVICE_UNAVAILABLE', '所选本机 Bridge 已撤销、已过期或已关闭团队派发');
      db.prepare(`INSERT INTO local_ai_runs (id,task_id,project_id,job_id,actor_id,mode,engine,tool,repo_path,status,output,started_at,updated_at,runner,device_id,phase,cancel_requested,payload)
        VALUES (?,?,?,?,?,?,?,?,NULL,'RUNNING','',?,?,'bridge',?,'QUEUED',0,?)`)
        .run(id, currentTask.id, currentTask.projectId, targetJob?.id || null, user.id, mode, engine.id, engine.tool, at, at, device.id, payload);
      audit(user.id, 'BRIDGE_RUN_QUEUE', id, currentTask.projectId);
    });
    return { run: runRow(db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(id)), task: getTask(currentTask.id, user), ...(targetJob ? { job: targetJob } : {}) };
  }

  function list(user, taskId) {
    sweep();
    const task = getTask(taskId, user);
    return db.prepare(`SELECT * FROM local_ai_runs WHERE task_id=? AND runner='bridge'
      AND (actor_id=? OR device_id IN (SELECT id FROM local_device_sessions WHERE user_id=?)) ORDER BY started_at DESC, rowid DESC LIMIT 20`)
      .all(task.id, user.id, user.id).map(runRow);
  }

  function stop(user, id) {
    const row = ownRun(user, id);
    if (row.status !== 'RUNNING') return runRow(row);
    const at = iso();
    if (row.phase === 'QUEUED') {
      db.prepare("UPDATE local_ai_runs SET status='CANCELLED',error=?,finished_at=?,updated_at=? WHERE id=? AND status='RUNNING' AND phase='QUEUED'").run('已在领取前取消', at, at, id);
    } else {
      db.prepare("UPDATE local_ai_runs SET cancel_requested=1,updated_at=? WHERE id=? AND status='RUNNING'").run(at, id);
    }
    audit(user.id, 'BRIDGE_RUN_STOP', id, row.project_id);
    return runRow(db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(id));
  }

  async function next(req, reauthorize, waitSeconds) {
    const deadline = now() + Math.min(Math.max(waitSeconds, 0), WAIT_MAX_S) * 1000;
    let closed = false;
    req.once('close', () => { closed = true; });
    for (;;) {
      const device = requireDevice(reauthorize());
      sweep();
      const row = db.prepare("SELECT * FROM local_ai_runs WHERE runner='bridge' AND device_id=? AND status='RUNNING' AND phase='QUEUED' ORDER BY started_at, rowid LIMIT 1").get(device.id);
      if (row) return { run: { id: row.id, taskId: row.task_id, projectId: row.project_id, mode: row.mode, engine: row.engine, startedAt: row.started_at } };
      if (closed || now() >= deadline) return { run: null };
      await sleep(1000);
    }
  }

  function claim(user, id) {
    const device = requireDevice(user);
    let claimed;
    transaction(() => {
      const row = deviceRun(device, id);
      if (row.status !== 'RUNNING' || row.phase !== 'QUEUED') fail(409, 'BRIDGE_RUN_NOT_QUEUED', '该派发已被领取、取消或结束');
      const task = getTask(row.task_id, user);
      if (row.mode !== 'read') assertWritable(task, user);
      if (row.mode === 'develop' && task.assigneeId !== user.id && !projectPermissions(user, taskRole(task, user)).assignTasks) fail(403, 'FORBIDDEN', '任务已改派，派发失效');
      db.prepare("UPDATE local_ai_runs SET phase='CLAIMED',lease_until=?,updated_at=? WHERE id=?").run(now() + LEASE_MS, iso(), id);
      audit(user.id, 'BRIDGE_RUN_CLAIM', id, row.project_id);
      claimed = row;
    });
    return {
      run: { id: claimed.id, taskId: claimed.task_id, projectId: claimed.project_id, jobId: claimed.job_id, mode: claimed.mode, engine: claimed.engine, tool: claimed.tool },
      payload: JSON.parse(claimed.payload), leaseMs: LEASE_MS,
      placeholders: { contextFile: CONTEXT_FILE_PLACEHOLDER, repoPath: REPO_PATH_PLACEHOLDER },
    };
  }

  const tail = value => {
    if (value === undefined) return undefined;
    if (typeof value !== 'string' || value.length > OUTPUT_MAX * 4) fail(400, 'INVALID_INPUT', 'output格式不正确');
    return value.slice(-OUTPUT_MAX);
  };
  const liveRun = (device, id) => {
    const row = deviceRun(device, id);
    if (row.status !== 'RUNNING' || !ACTIVE_PHASES.includes(row.phase)) fail(409, 'BRIDGE_RUN_CLOSED', '派发已结束或已被中断，请停止本机执行');
    return row;
  };

  function progress(user, id, body) {
    const device = requireDevice(user);
    keys(body, ['output']);
    const output = tail(body.output);
    const row = liveRun(device, id);
    db.prepare("UPDATE local_ai_runs SET phase='EXECUTING',output=COALESCE(?,output),lease_until=?,updated_at=? WHERE id=?").run(output ?? null, now() + LEASE_MS, iso(), id);
    return { cancelRequested: !!row.cancel_requested, leaseMs: LEASE_MS };
  }

  function result(user, id, body) {
    const device = requireDevice(user);
    keys(body, ['status', 'output', 'error', 'exitCode']);
    if (!['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(body.status)) fail(400, 'INVALID_STATUS', 'status必须为SUCCEEDED、FAILED或CANCELLED');
    const output = tail(body.output) ?? '';
    const error = body.error === undefined || body.error === null ? null : textField(body.error, 'error', { max: 4000, preserve: true }).slice(0, 1000);
    if (body.exitCode !== undefined && body.exitCode !== null && !Number.isInteger(body.exitCode)) fail(400, 'INVALID_INPUT', 'exitCode格式不正确');
    const row = liveRun(device, id);
    const draft = body.status === 'SUCCEEDED' && row.mode === 'review' ? extractReviewDraft(output, { allowPlainText: false }) : null;
    const at = iso();
    db.prepare('UPDATE local_ai_runs SET status=?,output=?,draft_json=?,error=?,exit_code=?,finished_at=?,updated_at=?,lease_until=NULL WHERE id=?')
      .run(body.status, output, draft ? JSON.stringify(draft) : null, error, body.exitCode ?? null, at, at, id);
    audit(user.id, 'BRIDGE_RUN_FINISH', id, row.project_id);
    return { run: runRow(db.prepare('SELECT * FROM local_ai_runs WHERE id=?').get(id)) };
  }

  async function handle({ req, method, path, url, user, body, send, reauthorize }) {
    if (method === 'GET' && path === '/api/bridge/runs/next') {
      const wait = Number(url.searchParams.get('wait') || 0);
      if (!Number.isFinite(wait)) fail(400, 'INVALID_INPUT', 'wait格式不正确');
      requireDevice(user);
      send(200, await next(req, reauthorize, wait));
      return true;
    }
    const deviceAction = path.match(/^\/api\/bridge\/runs\/([^/]+)\/(claim|progress|result)$/);
    if (deviceAction && method === 'POST') {
      const [, id, action] = deviceAction;
      send(200, action === 'claim' ? claim(user, id) : action === 'progress' ? progress(user, id, body) : result(user, id, body));
      return true;
    }
    const taskRuns = path.match(/^\/api\/tasks\/([^/]+)\/ai-runs$/);
    if (taskRuns && method === 'GET') { requireBrowser(req, user); send(200, { runs: list(user, taskRuns[1]) }); return true; }
    if (taskRuns && method === 'POST') { requireBrowser(req, user, true); send(201, start(req, user, getTask(taskRuns[1], user), body)); return true; }
    const runRoute = path.match(/^\/api\/ai-runs\/([^/]+)(\/stop)?$/);
    if (runRoute && method === 'GET' && !runRoute[2]) { requireBrowser(req, user); sweep(); send(200, { run: runRow(ownRun(user, runRoute[1])) }); return true; }
    if (runRoute && method === 'POST' && runRoute[2]) { requireBrowser(req, user, true); send(200, { run: stop(user, runRoute[1]) }); return true; }
    if (method === 'GET' && path === '/api/agents') {
      requireBrowser(req, user);
      send(200, { agents: agentsFor(user, textField(url.searchParams.get('projectId'), 'projectId', { max: 64 })) });
      return true;
    }
    if (method === 'GET' && path === '/api/local-automation/capabilities') {
      requireBrowser(req, user);
      send(200, {
        supported: true, deployment: 'server', runners: ['bridge'], bridgeModes: allowedModes,
        engines: BRIDGE_ENGINES.map(item => ({ ...item, available: true })), devices: devicesFor(user),
        apps: { cursor: false, terminal: false, finder: false, workbenchUrl: '' },
      });
      return true;
    }
    return false;
  }

  return { handle, sweep, devicesFor };
}
