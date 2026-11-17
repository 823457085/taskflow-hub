import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { renderSkill, skillDirName, syncSkills, SKILL_MARKER } from './skills-sync.mjs';
import { skillSyncConfig } from './worker.mjs';

test('skill files get platform-owned frontmatter regardless of uploaded headers', () => {
  assert.equal(skillDirName('VMS_Pay', 'pay-review'), 'taskflow-vms-pay-pay-review');
  const text = renderSkill('taskflow-vms-pay-review', { description: '评审: 支付\n清单', content: '---\nname: evil\ndescription: x\n---\n\n# 支付评审\n- 金额用分' });
  assert.equal(text, '---\nname: taskflow-vms-pay-review\ndescription: "评审: 支付 清单"\n---\n\n# 支付评审\n- 金额用分\n');
});

test('skills sync writes enabled team skills, keeps local folders, and removes only managed skills that went away', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-skills-'));
  try {
    const target = join(dir, 'skills');
    let skills = [
      { id: 's1', name: 'pay-review', description: '支付评审', content: '# v1', version: 1, enabled: true },
      { id: 's2', name: 'mine', description: '同名', content: '# team', version: 1, enabled: true },
      { id: 's3', name: 'off', description: '停用', content: '# off', version: 1, enabled: false },
    ];
    const paths = [];
    const call = async path => {
      paths.push(path);
      if (path === '/api/projects') return { projects: [{ id: 'default', key: 'VMS' }] };
      return { skills };
    };
    mkdirSync(join(target, 'taskflow-vms-mine'), { recursive: true });
    writeFileSync(join(target, 'taskflow-vms-mine', 'SKILL.md'), 'local');
    mkdirSync(join(target, 'taskflow-unmanaged'));
    symlinkSync(dir, join(target, 'taskflow-link'));

    const first = await syncSkills({ targets: [target] }, call);
    assert.deepEqual(first.targets[0], { target, written: ['taskflow-vms-pay-review'], unchanged: [], removed: [], conflicts: ['taskflow-vms-mine'] });
    assert.equal(paths[1], '/api/skills?projectId=default&include=content&enabled=1');
    assert.match(readFileSync(join(target, 'taskflow-vms-pay-review', 'SKILL.md'), 'utf8'), /name: taskflow-vms-pay-review[\s\S]*# v1/);
    assert.equal(JSON.parse(readFileSync(join(target, 'taskflow-vms-pay-review', SKILL_MARKER), 'utf8')).version, 1);
    assert.equal(readFileSync(join(target, 'taskflow-vms-mine', 'SKILL.md'), 'utf8'), 'local');

    assert.deepEqual((await syncSkills({ targets: [target] }, call)).targets[0].unchanged, ['taskflow-vms-pay-review']);
    skills = [{ ...skills[0], content: '# v2', version: 2 }];
    assert.deepEqual((await syncSkills({ targets: [target] }, call)).targets[0].written, ['taskflow-vms-pay-review']);
    skills = [];
    assert.deepEqual((await syncSkills({ targets: [target] }, call)).targets[0].removed, ['taskflow-vms-pay-review']);
    assert.ok(!existsSync(join(target, 'taskflow-vms-pay-review')));
    assert.ok(existsSync(join(target, 'taskflow-unmanaged')) && existsSync(join(target, 'taskflow-link')) && existsSync(join(target, 'taskflow-vms-mine')));

    await assert.rejects(syncSkills({ targets: [join(target, 'taskflow-link')] }, call), /不是普通目录/);
    await assert.rejects(syncSkills({ targets: ['relative'] }, call), /绝对路径/);
    await assert.rejects(syncSkills({ targets: [target] }, async () => { throw new Error('网络中断'); }), /网络中断/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('skillSync config requires existing parent directories and bounded intervals', () => {
  const dir = mkdtempSync(join(tmpdir(), 'taskflow-skillcfg-'));
  try {
    assert.equal(skillSyncConfig(undefined), null);
    const config = skillSyncConfig({ targets: [join(dir, 'skills'), join(dir, 'skills')] });
    assert.equal(config.targets.length, 1);
    assert.equal(config.intervalMinutes, 30);
    assert.throws(() => skillSyncConfig({ targets: [join(dir, 'missing', 'skills')] }), /上级目录 不存在/);
    assert.throws(() => skillSyncConfig({ targets: ['skills'] }), /绝对路径/);
    assert.throws(() => skillSyncConfig({ targets: [join(dir, 's')], intervalMinutes: 0 }), /1\.\.1440/);
    assert.throws(() => skillSyncConfig({ targets: [join(dir, 's')], extra: 1 }), /仅支持字段/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
