import { randomBytes } from 'node:crypto';
import { ApiError, fail } from './common.mjs';

const TICKET_MS = 20_000;
const STATUS = new Set(['queued', 'running', 'completed', 'failed', 'interrupted', 'cancelled']);

function loopbackOrigin(value) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('工作台与 TaskFlow 地址必须使用明确端口的本机回环 HTTP 地址');
  }
  return url.origin;
}

export function createWorkbenchBridge(baseUrl, webUrl) {
  const origin = loopbackOrigin(baseUrl);
  const taskFlowOrigin = loopbackOrigin(webUrl);
  const tickets = new Map();

  function exchange(req, body) {
    if (!['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) ||
        req.headers.origin || req.headers.cookie) {
      fail(403, 'WORKBENCH_PEER_REQUIRED', '仅接受本机工作台服务调用');
    }
    const { ticket } = body;
    if (typeof ticket !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(ticket)) {
      fail(400, 'INVALID_HANDOFF', '交接票据格式无效');
    }
    const entry = tickets.get(ticket);
    tickets.delete(ticket);
    if (!entry || entry.expiresAt <= Date.now()) fail(403, 'HANDOFF_EXPIRED', '交接票据已失效');
    entry.authorize();
    return entry.command;
  }

  async function call(command, authorize) {
    if (tickets.size >= 128) fail(429, 'WORKBENCH_BUSY', '工作台连接繁忙，请稍后重试');
    const ticket = randomBytes(32).toString('base64url');
    tickets.set(ticket, { command, authorize, expiresAt: Date.now() + TICKET_MS });
    try {
      const response = await fetch(new URL('/api/taskflow/workbench', origin), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, redirect: 'error',
        body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(command.action === 'start' ? 12_000 : 4000),
      });
      const value = await response.json().catch(() => null);
      if (!response.ok) {
        if (typeof value?.error?.code === 'string' && typeof value.error.message === 'string') {
          fail(response.status, value.error.code, value.error.message);
        }
        fail(503, 'WORKBENCH_UNAVAILABLE', '5288 工作台尚未启用任务接入');
      }
      const run = value?.run;
      if (run?.id !== command.runId || !STATUS.has(run.status)) {
        fail(502, 'WORKBENCH_RESPONSE_INVALID', '工作台返回了无效的会话状态');
      }
      return run;
    } catch (error) {
      if (error instanceof ApiError) throw error;
      if (error.cause?.code === 'ECONNREFUSED') fail(503, 'WORKBENCH_UNAVAILABLE', '5288 工作台未运行');
      fail(503, 'WORKBENCH_UNREACHABLE', '暂时未收到 5288 工作台回执，请稍后查看执行记录');
    } finally {
      tickets.delete(ticket);
    }
  }

  return { origin, taskFlowOrigin, exchange, call };
}
