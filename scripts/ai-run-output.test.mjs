import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAiRunOutput } from '../preview-app/src/views/aiRunOutputParser.ts';

test('parseAiRunOutput strips Codex hook/shell noise and translates commands into readable Chinese steps', () => {
  const noisy = [
    'OpenAI Codex v0.118.0',
    '--------',
    'workdir: /Users/lzr/Library/Application Support/TaskFlow/a9da9aeceeae/.runs/6bb51401-0043-4609-942c-c1ce68fb2dab',
    'model: gpt-5.4',
    'hook: PostToolUse',
    'hook: PostToolUse Completed',
    'exec',
    `/bin/zsh -lc "pwd && rg --files -g '!node_modules' -g '!vendor' --hidden" in /Users/lzr/Library/Application Support/TaskFlow/a9da9aeceeae/.runs/6bb51401-0043-4609-942c-c1ce68fb2dab`,
    ' succeeded in 0ms:',
    '/Users/lzr/Library/Application Support/TaskFlow/a9da9aeceeae/.runs/6bb51401-0043-4609-942c-c1ce68fb2dab',
    'context.json',
    'hook: PostToolUse',
    'hook: PostToolUse Completed',
    'exec',
    `/bin/zsh -lc "nl -ba src/views/activityManage/components/ActivityDetail.vue | sed -n '1,60p'" in /Users/lzr/repo`,
    ' succeeded in 12ms:',
    '   1  <template>',
    'thinking',
    '正在核对 ActivityDetail.vue 与冻结 PRD 范围是否一致。',
  ].join('\n');

  const parsed = parseAiRunOutput(noisy, { status: 'RUNNING', mode: 'review' });
  assert.equal(parsed.hasRawNoise, true);
  assert.equal(parsed.steps.length, 2);
  assert.equal(parsed.steps[0].kind, 'scan');
  assert.equal(parsed.steps[0].title, '扫描项目目录与文件清单');
  assert.equal(parsed.steps[0].duration, '0ms');
  assert.equal(parsed.steps[1].kind, 'read');
  assert.equal(parsed.steps[1].title, '查阅源码与配置细节');
  assert.equal(parsed.steps[1].detail, 'ActivityDetail.vue');
  assert.match(parsed.latestThought, /ActivityDetail\.vue/);
  assert.equal(JSON.stringify(parsed).includes('PostToolUse'), false);
  assert.equal(JSON.stringify(parsed).includes('.runs/6bb51401'), false);
});

test('parseAiRunOutput extracts final Markdown answer and suppresses duplicate review JSON blocks', () => {
  const finished = [
    'exec',
    '/bin/zsh -lc "node --test tests/offline-door-password.test.mjs" in /Users/lzr/repo',
    ' exited 1 in 750ms:',
    '1 failed',
    'codex',
    '审核完成，发现 1 项词条缺失风险。',
    '```taskflow-review-draft',
    '{"summary":"存在词条缺失","findings":[]}',
    '```',
    'tokens used',
    '12,345',
  ].join('\n');

  const withDraft = parseAiRunOutput(finished, { status: 'SUCCEEDED', mode: 'review', hasReviewDraft: true });
  assert.equal(withDraft.steps[0].kind, 'test');
  assert.equal(withDraft.steps[0].status, 'failed');
  assert.equal(withDraft.steps[0].detail, 'offline-door-password.test.mjs');
  assert.equal(withDraft.finalMarkdown, '审核完成，发现 1 项词条缺失风险。');

  const withAnswer = parseAiRunOutput('hook: PostToolUse\nraw dump', {
    status: 'SUCCEEDED',
    mode: 'read',
    draftAnswer: '## 结论\n任务材料齐全，可直接进入开发。',
  });
  assert.equal(withAnswer.finalMarkdown, '## 结论\n任务材料齐全，可直接进入开发。');
});
