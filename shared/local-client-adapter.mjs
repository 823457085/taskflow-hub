const fields = ['schemaVersion', 'id', 'name', 'configPath', 'serversKey', 'includeType'];
const reservedKeys = new Set(['__proto__', 'constructor', 'prototype']);
const reservedDirectories = new Set(['.git', '.local', '.data', 'node_modules']);

export const DEFAULT_CLIENT_ADAPTER = Object.freeze({
  schemaVersion: 1,
  id: 'generic-workbench',
  name: '我的工作台',
  configPath: '.mcp.json',
  serversKey: 'mcpServers',
  includeType: true,
});

export function parseClientAdapter(value) {
  if (typeof value === 'string') {
    if (new TextEncoder().encode(value).length > 8192) throw new Error('客户端适配器 JSON 不能超过 8 KiB。');
    try { value = JSON.parse(value); }
    catch { throw new Error('客户端适配器必须是有效的 JSON。'); }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('客户端适配器必须是 JSON 对象。');
  const keys = Object.keys(value);
  if (keys.length !== fields.length || keys.some(key => !fields.includes(key)) || fields.some(key => !Object.hasOwn(value, key))) throw new Error('客户端适配器只能包含规定的六个字段，且全部必填。');
  if (value.schemaVersion !== 1) throw new Error('客户端适配器 schemaVersion 必须是 1。');
  if (typeof value.id !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(value.id)) throw new Error('客户端适配器 id 必须是最长 64 字符的小写字母、数字和连字符标识。');
  if (typeof value.name !== 'string' || !value.name.trim() || value.name.length > 80 || /[\x00-\x1f\x7f]/.test(value.name)) throw new Error('客户端适配器 name 必须是 1 至 80 字符的名称。');
  if (typeof value.configPath !== 'string' || value.configPath.length > 200 || !value.configPath.length) throw new Error('客户端配置路径必须是最长 200 字符的项目内相对 JSON 路径。');
  const segments = value.configPath.split('/');
  if (segments.length > 4 || segments.some(segment => !/^[A-Za-z0-9._-]+$/.test(segment) || segment === '.' || segment === '..' || reservedDirectories.has(segment.toLowerCase())) || !/\.json$/i.test(segments.at(-1))) throw new Error('客户端配置路径必须是最多四层的安全相对 JSON 路径，不能包含保留目录。');
  const basename = segments.at(-1).replace(/^\.+/, '').toLowerCase();
  if (/^(?:auth|session|credentials)(?:[._-].*)?\.json$/.test(basename) || /^package.*\.json$/.test(basename)) throw new Error('客户端配置路径不能指向凭据、会话或包管理文件。');
  if (typeof value.serversKey !== 'string' || !/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(value.serversKey) || reservedKeys.has(value.serversKey)) throw new Error('serversKey 必须是安全的单个根对象键。');
  if (typeof value.includeType !== 'boolean') throw new Error('includeType 必须是布尔值。');
  return { schemaVersion: 1, id: value.id, name: value.name, configPath: value.configPath, serversKey: value.serversKey, includeType: value.includeType };
}
