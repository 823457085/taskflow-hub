export interface ImportDoc { sourceRef: string; title: string; body: string; tags: string[] }

const text = (value: unknown, max = 500) => typeof value === 'string' ? value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim().slice(0, max) : '';
const cell = (value: unknown) => text(value).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ') || '—';
const tag = (value: unknown) => text(value, 30).replace(/,/g, ' ');

export function catalogDocs(raw: unknown): ImportDoc[] {
  const root = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const catalog = root.catalog && typeof root.catalog === 'object' ? root.catalog as Record<string, unknown> : root;
  const systems = [...(Array.isArray(catalog.systems) ? catalog.systems : []), ...(Array.isArray(root.localSystems) ? root.localSystems : [])];
  const docs: ImportDoc[] = [];
  for (const item of systems) {
    if (!item || typeof item !== 'object') continue;
    const system = item as Record<string, unknown>;
    const id = text(system.id, 120), name = text(system.name, 200);
    if (!id || !name) continue;
    const source = system.source && typeof system.source === 'object' ? system.source as Record<string, unknown> : {};
    const environments = (Array.isArray(system.environments) ? system.environments : []).filter((env): env is Record<string, unknown> => !!env && typeof env === 'object');
    const accounts = environments.reduce((sum, env) => sum + (Array.isArray(env.accounts) ? env.accounts.length : 0), 0);
    const lines = [`# ${name}`, ''];
    if (text(system.region)) lines.push(`- 区域：${text(system.region)}`);
    if (text(system.repository)) lines.push(`- 仓库：${text(system.repository)}`);
    if (text(source.url)) lines.push(`- 来源：[${text(source.title) || text(source.url)}](${text(source.url)})`);
    if (environments.length) {
      lines.push('', '## 环境', '', '| 环境 | 分支 | 地址 | 流水线 | 备注 |', '| --- | --- | --- | --- | --- |');
      for (const env of environments) lines.push(`| ${cell(env.name)} | ${cell(env.branch)} | ${cell(env.url)} | ${cell(env.pipeline)} | ${cell(env.notes)} |`);
    }
    if (accounts) lines.push('', `> 该系统登记了 ${accounts} 个测试账号，账号密码不导入知识库，请到来源页或密码管理处查看。`);
    docs.push({ sourceRef: `catalog:${id}`, title: name, body: lines.join('\n').slice(0, 30_000), tags: ['系统目录', tag(system.region)].filter(Boolean) });
  }
  return docs;
}

export function markdownDoc(fileName: string, content: string): ImportDoc {
  const body = content.replace(/^\uFEFF/, '');
  const front = body.match(/^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/);
  const meta = (key: string) => front?.[1].match(new RegExp(`^${key}:\\s*(.+)$`, 'm'))?.[1].trim().replace(/^["']|["']$/g, '') || '';
  const rest = front ? body.slice(front[0].length) : body;
  const heading = rest.match(/^#\s+(.+)$/m)?.[1].trim();
  const title = text(meta('title') || heading || fileName.replace(/\.(md|markdown|txt)$/i, ''), 200) || '未命名文档';
  const tags = meta('tags').replace(/^\[|\]$/g, '').split(/[,，]/).map(tag).filter(Boolean).slice(0, 10);
  return { sourceRef: `file:${fileName.slice(0, 190)}`, title, body: rest.trim().slice(0, 30_000), tags };
}
