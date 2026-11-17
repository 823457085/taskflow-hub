#!/usr/bin/env node
// Usage: node backup.mjs <db-path> <backup-dir> [keep-count]
import { DatabaseSync, backup } from 'node:sqlite';
import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

const [dbPath, backupDir, keepArg = '14'] = process.argv.slice(2);
const keep = Number(keepArg);
if (!dbPath || !backupDir || !Number.isInteger(keep) || keep < 1) {
  console.error('用法: node backup.mjs <数据库路径> <备份目录> [保留份数]');
  process.exit(2);
}
mkdirSync(backupDir, { recursive: true, mode: 0o700 });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const target = resolve(backupDir, `platform-${stamp}.sqlite`);
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  await backup(db, target);
} finally { db.close(); }
chmodSync(target, 0o600);
const check = new DatabaseSync(target);
try {
  check.exec('PRAGMA journal_mode = DELETE');
  const result = check.prepare('PRAGMA integrity_check').get();
  if (Object.values(result)[0] !== 'ok') throw new Error('备份完整性检查失败');
} finally { check.close(); }
const old = readdirSync(backupDir).filter(name => /^platform-.*\.sqlite$/.test(name)).sort().reverse().slice(keep);
for (const name of old) for (const suffix of ['', '-wal', '-shm']) rmSync(join(backupDir, name + suffix), { force: true });
console.log(`备份完成: ${target}（保留 ${keep} 份，清理 ${old.length} 份）`);
