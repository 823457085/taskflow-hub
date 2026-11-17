import { fail } from './common.mjs';
import { projectPermissions } from './permissions.mjs';

const DAY = 24 * 60 * 60 * 1000;
const SECTION_LIMIT = 50;
const SECTIONS = ['completed', 'doing', 'review', 'blocked', 'todo'];

const dateField = value => {
  if (value === undefined || value === null || value === '') return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) fail(400, 'INVALID_DATE', '请选择有效的日期');
  return value;
};
const offsetField = value => {
  if (value === null || value === '') return 480;
  const offset = Number(value);
  if (!Number.isInteger(offset) || offset < -840 || offset > 840) fail(400, 'INVALID_TZ_OFFSET', '时区偏移不受支持');
  return offset;
};

export function createWorkReports({ db, projectRole }) {
  const window = (date, offset) => {
    const start = Date.parse(`${date}T00:00:00.000Z`) - offset * 60 * 1000;
    return { from: new Date(start).toISOString(), to: new Date(start + DAY).toISOString() };
  };
  const within = (value, range) => !!value && value >= range.from && value < range.to;

  function memberReport(projectId, memberId, includePersonal, date, range) {
    const sections = Object.fromEntries(SECTIONS.map(name => [name, []]));
    const push = (name, item) => sections[name].push(item);

    for (const task of db.prepare('SELECT id,jira_key,title,status,progress,last_summary,updated_at FROM tasks WHERE project_id=? AND assignee_id=? ORDER BY updated_at DESC').all(projectId, memberId)) {
      const item = { source: 'task', id: task.id, taskId: task.id, jiraKey: task.jira_key, title: task.title, status: task.status, detail: task.last_summary || (task.progress ? `进度 ${task.progress}%` : ''), updatedAt: task.updated_at };
      if (task.status === 'DONE') { if (within(task.updated_at, range)) push('completed', item); }
      else push({ IN_PROGRESS: 'doing', IN_REVIEW: 'review' }[task.status] || 'todo', item);
    }

    const todos = db.prepare(`SELECT t.*,k.jira_key FROM todos t LEFT JOIN tasks k ON k.id=t.task_id
      WHERE (t.project_id=? AND (t.assignee_id=? OR (t.assignee_id IS NULL AND t.owner_id=?))) OR (? AND t.project_id IS NULL AND t.owner_id=?)
      ORDER BY t.priority='high' DESC, t.due_date='' , t.due_date, t.updated_at DESC`).all(projectId, memberId, memberId, includePersonal ? 1 : 0, memberId);
    for (const todo of todos) {
      const item = { source: 'todo', id: todo.id, taskId: todo.task_id, jiraKey: todo.jira_key, title: todo.title, status: todo.status, detail: todo.details, dueDate: todo.due_date, priority: todo.priority, personal: !todo.project_id, updatedAt: todo.updated_at };
      if (todo.status === 'done') { if (within(todo.updated_at, range)) push('completed', item); }
      else if (todo.due_date && todo.due_date < date) push('blocked', { ...item, detail: [`已逾期（截止 ${todo.due_date}）`, todo.details].filter(Boolean).join('；') });
      else push(todo.status === 'doing' ? 'doing' : 'todo', item);
    }

    const runs = db.prepare(`SELECT r.id,r.task_id,r.mode,r.tool,r.status,r.error,r.started_at,r.finished_at,r.updated_at,k.jira_key,k.title FROM local_ai_runs r JOIN tasks k ON k.id=r.task_id
      WHERE r.project_id=? AND r.actor_id=? AND (r.status IN ('QUEUED','RUNNING') OR (r.started_at>=? AND r.started_at<?) OR (r.finished_at>=? AND r.finished_at<?))
      ORDER BY r.started_at DESC`).all(projectId, memberId, range.from, range.to, range.from, range.to);
    const modes = { read: '只读分析', develop: '开发', review: '评审' };
    const latestRuns = new Set();
    for (const run of runs) {
      if (latestRuns.has(`${run.task_id}:${run.mode}`)) continue;
      latestRuns.add(`${run.task_id}:${run.mode}`);
      const item = { source: 'run', id: run.id, taskId: run.task_id, jiraKey: run.jira_key, title: `${modes[run.mode] || run.mode}：${run.title}`, status: run.status, detail: [`执行工具：${run.tool}`, run.error].filter(Boolean).join('；'), updatedAt: run.finished_at || run.updated_at };
      if (['QUEUED', 'RUNNING'].includes(run.status)) push('doing', item);
      else if (run.status === 'SUCCEEDED') push('completed', item);
      else if (['FAILED', 'INTERRUPTED'].includes(run.status)) push('blocked', item);
    }

    const progress = db.prepare(`SELECT e.id,e.task_id,e.tool,e.progress,e.summary,e.branch,e.created_at,k.jira_key,k.title FROM progress_events e JOIN tasks k ON k.id=e.task_id
      WHERE k.project_id=? AND e.actor_id=? AND e.created_at>=? AND e.created_at<? ORDER BY e.created_at DESC LIMIT ?`).all(projectId, memberId, range.from, range.to, SECTION_LIMIT)
      .map(row => ({ id: row.id, taskId: row.task_id, jiraKey: row.jira_key, title: row.title, tool: row.tool, progress: row.progress, summary: row.summary, branch: row.branch, createdAt: row.created_at }));

    const counts = Object.fromEntries(SECTIONS.map(name => [name, sections[name].length]));
    for (const name of SECTIONS) sections[name] = sections[name].slice(0, SECTION_LIMIT);
    return { sections, counts, progress };
  }

  return function handle({ method, path, url, user, send }) {
    if (path !== '/api/work-reports') return false;
    if (method !== 'GET') fail(405, 'METHOD_NOT_ALLOWED', '该操作仅支持GET');
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权查看工作报告');
    const projectId = url.searchParams.get('projectId');
    if (!projectId) fail(400, 'PROJECT_REQUIRED', '请选择项目');
    const role = projectRole(user, projectId);
    const offset = offsetField(url.searchParams.get('tzOffset'));
    const date = dateField(url.searchParams.get('date')) || new Date(Date.now() + offset * 60 * 1000).toISOString().slice(0, 10);
    const range = window(date, offset);
    const team = url.searchParams.get('scope') === 'team';
    const memberId = url.searchParams.get('memberId') || user.id;
    const canViewOthers = projectPermissions(user, role).assignTasks;
    if ((team || memberId !== user.id) && !canViewOthers) fail(403, 'REPORT_FORBIDDEN', '只有项目负责人、PM 和管理员可以查看其他成员的报告');

    const projectMembers = db.prepare('SELECT u.id,u.username,m.role FROM project_members m JOIN users u ON u.id=m.user_id WHERE m.project_id=? ORDER BY u.username').all(projectId);
    let targets;
    if (team) targets = projectMembers;
    else {
      const member = projectMembers.find(row => row.id === memberId) || (memberId === user.id ? { id: user.id, username: user.username, role } : null);
      if (!member) fail(404, 'REPORT_MEMBER_NOT_FOUND', '该成员不在此项目中');
      targets = [member];
    }
    const members = targets.map(member => ({ member: { id: member.id, username: member.username, role: member.role }, ...memberReport(projectId, member.id, member.id === user.id, date, range) }));
    send(200, { report: { projectId, date, tzOffset: offset, from: range.from, to: range.to, scope: team ? 'team' : 'member', generatedAt: new Date().toISOString(), canViewOthers, members } });
    return true;
  };
}
