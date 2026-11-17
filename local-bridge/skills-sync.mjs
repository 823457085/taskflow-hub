import { lstat, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';

export const SKILL_MARKER = '.taskflow-skill.json';
const SKILL_NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;

export function skillDirName(projectKey, name) {
  const key = String(projectKey || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'project';
  return `taskflow-${key}-${name}`;
}

export function renderSkill(dirName, skill) {
  const body = String(skill.content || '').replace(/^\uFEFF?---\r?\n[\s\S]*?\r?\n---[ \t]*(?:\r?\n|$)/, '').replace(/^\s+/, '');
  return `---\nname: ${dirName}\ndescription: ${JSON.stringify(String(skill.description || '').replace(/[\r\n]+/g, ' '))}\n---\n\n${body.endsWith('\n') ? body : `${body}\n`}`;
}

async function entry(path) { try { return await lstat(path); } catch { return null; } }
async function managed(dir) {
  const marker = await entry(join(dir, SKILL_MARKER));
  if (!marker?.isFile()) return null;
  try { return JSON.parse(await readFile(join(dir, SKILL_MARKER), 'utf8')); } catch { return {}; }
}

export async function syncSkills({ targets }, call) {
  if (!Array.isArray(targets) || !targets.length || targets.some(target => typeof target !== 'string' || !isAbsolute(target))) throw new Error('请至少提供一个绝对路径的 Skill 目录');
  const { projects = [] } = await call('/api/projects');
  const desired = new Map();
  for (const project of projects) {
    const { skills = [] } = await call(`/api/skills?projectId=${encodeURIComponent(project.id)}&include=content&enabled=1`);
    for (const skill of skills) {
      if (!skill.enabled || !SKILL_NAME.test(skill.name || '')) continue;
      const dir = skillDirName(project.key, skill.name);
      desired.set(dir, { content: renderSkill(dir, skill), marker: { projectId: project.id, projectKey: project.key, skillId: skill.id, name: skill.name, version: skill.version } });
    }
  }
  const results = [];
  for (const target of targets) {
    const result = { target, written: [], unchanged: [], removed: [], conflicts: [] };
    const root = await entry(target);
    if (root && (!root.isDirectory() || root.isSymbolicLink())) throw new Error(`${target} 不是普通目录`);
    if (!root) await mkdir(target, { recursive: true });
    for (const [name, skill] of desired) {
      const dir = join(target, name), info = await entry(dir);
      if (info && (!info.isDirectory() || info.isSymbolicLink() || !(await managed(dir)))) { result.conflicts.push(name); continue; }
      const file = join(dir, 'SKILL.md');
      const current = info ? await readFile(file, 'utf8').catch(() => null) : null;
      if (current === skill.content) { result.unchanged.push(name); continue; }
      await mkdir(dir, { recursive: true });
      await writeFile(file, skill.content);
      await writeFile(join(dir, SKILL_MARKER), `${JSON.stringify({ ...skill.marker, syncedAt: new Date().toISOString() }, null, 2)}\n`);
      result.written.push(name);
    }
    for (const name of await readdir(target)) {
      if (!name.startsWith('taskflow-') || desired.has(name)) continue;
      const dir = join(target, name), info = await entry(dir);
      if (!info?.isDirectory() || info.isSymbolicLink() || !(await managed(dir))) continue;
      await rm(dir, { recursive: true, force: true });
      result.removed.push(name);
    }
    results.push(result);
  }
  return { skills: desired.size, targets: results };
}
