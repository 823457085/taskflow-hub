#!/usr/bin/env node
// 打包成员客户端：Bridge（必需）和工作台（--workbench <目录>，可选），写入 preview-app/dist 并生成 taskflow-release.json。
// 版本号取文件内容哈希，内容不变则版本不变，成员端不会重复更新。
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const out = join(root, 'preview-app', 'dist');
const args = process.argv.slice(2);
const workbenchIndex = args.indexOf('--workbench');
const workbenchDir = workbenchIndex >= 0 ? resolve(args[workbenchIndex + 1] || '') : null;
const env = { ...process.env, COPYFILE_DISABLE: '1' };

const sha = data => createHash('sha256').update(data).digest('hex');
function contentVersion(base, files) {
  const hash = createHash('sha256');
  for (const file of [...files].sort()) hash.update(`${file}\0${sha(readFileSync(join(base, file)))}\0`);
  return hash.digest('hex').slice(0, 12);
}
function listFiles(base, command, args) {
  return execFileSync(command, args, { cwd: base, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean)
    .filter(file => existsSync(join(base, file)) && statSync(join(base, file)).isFile());
}
function tarball(base, files, target) {
  const list = join(mkdtempSync(join(tmpdir(), 'taskflow-pack-')), 'files');
  writeFileSync(list, files.join('\n'));
  try { execFileSync('tar', ['czf', target, '-C', base, '-T', list], { env }); }
  finally { rmSync(list, { force: true }); }
  const data = readFileSync(target);
  return { sha256: sha(data), size: data.length };
}

if (!existsSync(join(out, 'index.html'))) throw new Error('请先构建任务中心网页（preview-app/dist）');

const bridgeFiles = listFiles(root, 'git', ['ls-files', '-z', '-co', '--exclude-standard', '--', 'local-bridge', 'shared/local-client-adapter.mjs', 'shared/local-client-adapter.d.mts'])
  .filter(file => !file.endsWith('.test.mjs') && !file.includes('/node_modules/') && file !== 'local-bridge/release.json');
const bridgeVersion = contentVersion(root, bridgeFiles);
writeFileSync(join(root, 'local-bridge', 'release.json'), `${JSON.stringify({ version: bridgeVersion }, null, 2)}\n`);
const release = { createdAt: new Date().toISOString(), bridge: { version: bridgeVersion, ...tarball(root, [...bridgeFiles, 'local-bridge/release.json'], join(out, 'taskflow-bridge.tgz')) } };
rmSync(join(root, 'local-bridge', 'release.json'));
copyFileSync(join(root, 'deploy', 'install-bridge.sh'), join(out, 'install-bridge.sh'));

if (workbenchDir) {
  if (!existsSync(join(workbenchDir, 'dist', 'index.html')) || !existsSync(join(workbenchDir, 'server', 'index.ts'))) throw new Error(`${workbenchDir} 不是已构建的工作台目录（缺少 dist/index.html 或 server/index.ts）`);
  const source = listFiles(workbenchDir, 'git', ['ls-files', '-z', '-co', '--exclude-standard']);
  const built = listFiles(workbenchDir, 'find', ['dist', '-type', 'f', '-print0']);
  const files = [...new Set([...source, ...built])].filter(file => !/^(\.env|\.data|\.local|node_modules)(\/|$)/.test(file));
  release.workbench = { version: contentVersion(workbenchDir, files), ...tarball(workbenchDir, files, join(out, 'taskflow-workbench.tgz')) };
} else if (existsSync(join(out, 'taskflow-workbench.tgz'))) rmSync(join(out, 'taskflow-workbench.tgz'));

writeFileSync(join(out, 'taskflow-release.json'), `${JSON.stringify(release, null, 2)}\n`);
console.log(JSON.stringify({ out: relative(root, out), bridge: release.bridge, workbench: release.workbench || null }, null, 2));
