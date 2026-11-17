import { lstat, rename, chmod } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { ensureNoSession, saveSession, loadSession, loadSessionWithPath, sessionPath, hostSessionPath, usesDefaultState, request, validateUrl } from './api-client.mjs';
import { createBrowserHandoff, openDailyChrome } from './browser-handoff.mjs';

export const DEFAULT_API_URL = 'http://127.0.0.1:5187';
export const DEFAULT_WEB_URL = 'http://127.0.0.1:5186';
const milliseconds = value => typeof value === 'number' ? value : Date.parse(value);
const validToken = value => typeof value === 'string' && value.length >= 16 && value.length <= 4096 && !/[\r\n\x00-\x1f]/.test(value);

export async function pairDevice(options, { output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`), sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), now = Date.now, presentAuthorization } = {}) {
  const url = validateUrl(options.url || DEFAULT_API_URL);
  const webUrl = validateUrl(options['web-url'] || (url === DEFAULT_API_URL ? DEFAULT_WEB_URL : url));
  const expiredMessage = `设备配对已过期，请重新运行 ${presentAuthorization ? 'connect' : 'pair'}。`;
  await ensureNoSession();
  const authorization = await request(url, '/api/device-authorizations', { method: 'POST', body: { deviceName: options.name, tool: options.tool } });
  const expires = milliseconds(authorization?.expiresAt);
  if (!validToken(authorization?.deviceCode) || !/^[A-Za-z0-9-]{4,32}$/.test(authorization?.userCode || '') ||
      !Number.isFinite(expires) || !Number.isInteger(authorization?.interval) || authorization.interval < 1 || authorization.interval > 60) throw new Error('平台返回的设备配对信息不正确。');
  if (expires <= now()) throw new Error(expiredMessage);
  let cleanup;
  try {
    if (presentAuthorization) cleanup = await presentAuthorization(authorization, webUrl);
    else output({ status: '等待浏览器确认', verificationUrl: `${webUrl}/#view=local`, userCode: authorization.userCode, expiresAt: authorization.expiresAt });
    for (;;) {
      const remaining = expires - now();
      if (remaining <= 0) throw new Error(expiredMessage);
      await sleep(Math.min(authorization.interval * 1000, remaining));
      if (now() >= expires) throw new Error(expiredMessage);
      const result = await request(url, '/api/device-authorizations/poll', { method: 'POST', body: { deviceCode: authorization.deviceCode } });
      if (result?.status === 'PENDING') continue;
      if (result?.status === 'DENIED') throw new Error('设备配对已拒绝。');
      if (result?.status !== 'AUTHORIZED' || !validToken(result.token) || !/^[A-Za-z0-9_-]{1,80}$/.test(result.deviceId || '') ||
          !Array.isArray(result.projectIds) || result.projectIds.length > 1000 || result.projectIds.some(id => typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) ||
          !Number.isFinite(milliseconds(result.expiresAt)) || milliseconds(result.expiresAt) <= now()) throw new Error('平台返回的设备授权信息不正确。');
      try {
        await saveSession({ url, token: result.token, deviceId: result.deviceId, projectIds: result.projectIds, expiresAt: result.expiresAt }, { exclusive: true });
      } catch (error) {
        // A competing pair/login must never be overwritten. Revoke only this just-issued token.
        await request(url, '/api/logout', { token: result.token, method: 'POST' }).catch(() => {});
        throw error;
      }
      output({ status: '设备配对成功', username: result.user?.username, role: result.user?.role, deviceId: result.deviceId, projectCount: result.projectIds.length, expiresAt: result.expiresAt });
      return;
    }
  } finally { await cleanup?.(); }
}

export async function connectDevice(options, { output = value => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`), openBrowser = openDailyChrome, handoffFactory = createBrowserHandoff, ...pairOptions } = {}) {
  const url = validateUrl(options.url || DEFAULT_API_URL);
  let targetPath = sessionPath;
  let original;
  try { original = await lstat(sessionPath); } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法检查本地登录文件。'); }
  if (!original && usesDefaultState && hostSessionPath !== sessionPath) {
    try { original = await lstat(hostSessionPath); targetPath = hostSessionPath; } catch (error) { if (error.code !== 'ENOENT') throw new Error('无法检查本地登录文件。'); }
  }
  const verify = async (session, filePath = sessionPath) => {
    if (session.url !== url) throw new Error('已有会话属于另一平台，请先核对原连接，不会自动覆盖。');
    const startingFile = await lstat(filePath);
    const me = await request(url, '/api/me', { token: session.token });
    if (me.authorization?.kind !== 'LOCAL_DEVICE') throw new Error('已有普通成员会话，请先运行 logout，再使用 connect 配对受限设备。');
    const tasks = await request(url, '/api/tasks', { token: session.token });
    if (!Array.isArray(tasks?.tasks)) throw new Error('平台任务响应格式不正确。');
    const actualWithPath = await loadSessionWithPath(); const actual = actualWithPath.session; const latestFile = await lstat(filePath);
    if (actualWithPath.path !== filePath || actual.url !== session.url || actual.token !== session.token || actual.deviceId !== session.deviceId ||
        latestFile.ino !== startingFile.ino || latestFile.dev !== startingFile.dev || latestFile.mtimeMs !== startingFile.mtimeMs || latestFile.size !== startingFile.size) throw new Error('登录文件已被其他程序更新，请重新运行 connect 核验。');
    return { status: '已连接并验证任务读取', taskCount: tasks.tasks.length, projectCount: me.authorization.projectIds?.length || 0 };
  };
  if (original) {
    if (!original.isFile() || original.isSymbolicLink() || original.size > 16_384 || original.mode & 0o077 || process.getuid && original.uid !== process.getuid()) throw new Error('本地登录文件不安全，未修改已有文件。');
    const session = await loadSession();
    try { const result = await verify(session, targetPath); output(result); return result; }
    catch (error) { if (error.status !== 401) throw error; }
    const latest = await lstat(targetPath);
    if (latest.ino !== original.ino || latest.dev !== original.dev || latest.mtimeMs !== original.mtimeMs || latest.size !== original.size) throw new Error('登录文件已被其他程序更新，未开始新的配对。');
    const backup = `${targetPath}.expired-${randomUUID()}`;
    await rename(targetPath, backup); await chmod(backup, 0o600);
    output({ status: '原登录已失效，已保留私有备份，正在重新连接' });
  }
  await pairDevice(options, {
    ...pairOptions,
    output: value => { if (value.status === '设备配对成功') output({ status: '设备授权已保存，正在验证读取' }); },
    presentAuthorization: async (authorization, webUrl) => {
      const handoff = await handoffFactory({ webUrl, userCode: authorization.userCode, deviceName: options.name, tool: options.tool, expiresAt: authorization.expiresAt, suggestedProjectIds: options.projects || [] });
      try {
        output({ status: '等待已登录网页确认设备和项目', verificationUrl: handoff.verificationUrl, expiresAt: authorization.expiresAt });
        await openBrowser(handoff.verificationUrl);
        return handoff.close;
      } catch (error) { await handoff.close(); throw error; }
    },
  });
  const result = await verify(await loadSession(), sessionPath); output(result); return result;
}
