import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConfluenceTinyId, parseSourceReference } from '../preview-app/src/views/sourceReference.ts';
import { isDesignLink, parseReviewSourceLinks } from '../preview-app/src/views/reviewSourceLinks.ts';
import {
  buildAssetTemplate, buildClipboardGitCommand, detectPastedReference,
  extractTaskSmartHints, formatJiraDescriptionForDisplay, formatJiraTaskAsMarkdown,
} from '../preview-app/src/views/taskSmartLinks.ts';

test('configured Confluence page links yield page IDs including /x/ tiny links without copying URL parameters', () => {
  assert.deepEqual(parseSourceReference('confluence', 'https://docs.example/wiki/pages/viewpage.action?pageId=123&src=sidebar', 'https://docs.example/wiki'), { resource: 'confluence_page', pageId: '123' });
  assert.deepEqual(parseSourceReference('confluence', 'https://docs.example/wiki/spaces/DEV/pages/456/Plan#heading', 'https://docs.example/wiki'), { resource: 'confluence_page', pageId: '456' });
  assert.deepEqual(parseSourceReference('confluence', 'https://confluence.example.invalid/x/0gQ', 'https://confluence.example.invalid'), { resource: 'confluence_page', pageId: '1234' });
  assert.deepEqual(parseSourceReference('confluence', 'https://confluence.example.invalid/x/LhY', 'https://confluence.example.invalid'), { resource: 'confluence_page', pageId: '5678' });
  assert.equal(decodeConfluenceTinyId('AA'), null);
  assert.equal(decodeConfluenceTinyId('../bad'), null);
});

test('smart task hint extractor finds Confluence short links, related Jira keys, and matching local repositories', () => {
  const hints = extractTaskSmartHints({
    jiraKey: 'DEMO-799',
    title: '【前端】通知中心配置',
    externalRef: {
      provider: 'jira',
      key: 'DEMO-799',
      title: '【前端】通知中心配置',
      status: '待处理',
      version: '1',
      url: 'https://jira.example.invalid/browse/DEMO-799',
      parentKey: 'DEMO-778',
      description: '仓库：example-web\n需求文档：[PRD|https://confluence.example.invalid/x/LhY]\n关联接口：SAMPLE-603',
    },
  }, [
    { name: 'example-web', path: '/Users/demo/work/Sample/example-web', group: 'Sample' },
    { name: 'example-mobile', path: '/Users/demo/work/App/example-mobile', group: 'App' },
  ]);
  assert.equal(hints.detectedLinks.length, 1);
  assert.equal(hints.detectedLinks[0].url, 'https://confluence.example.invalid/x/LhY');
  assert.equal(hints.detectedLinks[0].provider, 'confluence');
  assert.deepEqual(hints.repoHintNames, ['example-web']);
  assert.deepEqual(hints.matchedRepos.map(r => r.name), ['example-web']);
  assert.deepEqual(hints.relatedJira.map(item => [item.key, item.relation, item.sameProject]), [
    ['DEMO-778', 'parent', true],
    ['SAMPLE-603', 'mentioned', false],
  ]);
});

test('Jira description display renders wiki links and removes only generated identifiers', () => {
  const design = 'https://www.figma.com/design/example?node-id=1-2';
  const description = [
    '*需求来源*',
    '产品需求 [DEMO-42|https://jira.example.invalid/browse/DEMO-42]。',
    `[${design}|${design}]`,
    'Repository ID: git-' + 'a'.repeat(64),
    'Repository ID: repository-from-user',
    'JIRA_DEV_REQUIREMENT_MARKER: jira-dev-requirement-abc-parent',
  ].join('\n');
  const display = formatJiraDescriptionForDisplay(description);
  assert.equal(display, [
    '**需求来源**',
    '产品需求 [DEMO-42](https://jira.example.invalid/browse/DEMO-42)。',
    `[Figma 设计稿](${design})`,
    'Repository ID: repository-from-user',
  ].join('\n'));
  assert.equal(formatJiraDescriptionForDisplay({ content: [{ text: '保留原文' }] }), '保留原文');
  assert.equal(formatJiraDescriptionForDisplay('[说明|javascript:alert(1)]'), '[说明|javascript:alert(1)]');
});

test('GitLab nested namespaces and Jenkins Job/build links reuse connector identifiers', () => {
  assert.deepEqual(parseSourceReference('gitlab', 'https://git.example/team/sub/repo/-/merge_requests/28/diffs#note_1', 'https://git.example'), { resource: 'gitlab_mr', repositoryId: 'team/sub/repo', mrIid: '28' });
  assert.deepEqual(parseSourceReference('jenkins', 'https://ci.example/jenkins/job/folder/job/service/72/', 'https://ci.example/jenkins'), { resource: 'jenkins_build', jobName: 'folder/service', buildNumber: '72' });
  assert.deepEqual(parseSourceReference('jenkins', 'https://ci.example/jenkins/view/test/job/folder/job/service/72/console', 'https://ci.example/jenkins'), { resource: 'jenkins_build', jobName: 'folder/service', buildNumber: '72' });
  assert.deepEqual(parseSourceReference('jenkins', 'https://ci.example/jenkins/job/folder/job/service/', 'https://ci.example/jenkins'), { resource: 'jenkins_build', jobName: 'folder/service', buildNumber: 'lastSuccessfulBuild' });
});

test('foreign hosts, credentials, traversal and sensitive query parameters never become API input', () => {
  for (const reference of [
    'https://other.example/wiki/pages/viewpage.action?pageId=1',
    'https://user:password@docs.example/wiki/pages/viewpage.action?pageId=1',
    'javascript:alert(1)', 'https://docs.example/outside/pages/viewpage.action?pageId=1',
    'https://docs.example/wiki/../wiki/pages/viewpage.action?pageId=1',
    'https://docs.example/wiki/%2e%2e/wiki/pages/viewpage.action?pageId=1',
    'https://docs.example/wiki/pages/viewpage.action?pageId=1&access_token=private-value',
    'https://docs.example/wiki/pages/viewpage.action?pageId=1#token=private-value',
  ]) assert.throws(() => parseSourceReference('confluence', reference, 'https://docs.example/wiki'), error => !error.message.includes(reference) && !error.message.includes('private-value'));
});

test('unsupported or ambiguous links require explicit manual input instead of guessing IDs', () => {
  for (const reference of ['https://docs.example/display/DEV/Title', 'https://docs.example/pages/viewpage.action?pageId=1&pageId=2', 'https://docs.example/pages/viewpage.action?pageId=0']) assert.throws(() => parseSourceReference('confluence', reference, 'https://docs.example'));
  assert.throws(() => parseSourceReference('gitlab', 'https://git.example/team/repo/-/merge_requests/nope', 'https://git.example'));
  assert.throws(() => parseSourceReference('gitlab', 'https://git.example/team/repo/-/merge_requests/12345678901234567', 'https://git.example'));
  assert.throws(() => parseSourceReference('jenkins', 'https://ci.example/job/a/3/replay', 'https://ci.example'));
});

test('in-task smart material helpers classify pasted links/keys and safely quote shell commands', () => {
  assert.equal(detectPastedReference('demo-778').provider, 'jira');
  assert.equal(detectPastedReference('demo-778').issueKey, 'DEMO-778');
  assert.equal(detectPastedReference('https://confluence.example.invalid/x/0gQ').provider, 'confluence');
  assert.equal(detectPastedReference('https://git.example/group/repo/-/merge_requests/99').provider, 'gitlab');
  assert.equal(detectPastedReference('https://codeup.aliyun.com/0123456789abcdef01234567/example-team/example-web/change/42').provider, 'yunxiao');
  assert.deepEqual(parseSourceReference('yunxiao', 'https://codeup.aliyun.com/0123456789abcdef01234567/example-team/example-web/change/42', 'https://openapi-rdc.aliyuncs.com'), {
    resource: 'yunxiao_mr', repositoryId: '0123456789abcdef01234567/example-team/example-web', mrLocalId: '42',
  });
  assert.deepEqual(parseSourceReference('yunxiao', 'https://codeup.aliyun.com/0123456789abcdef01234567/example-team/example-web/commit/0123456789abcdef0123456789abcdef01234567', 'https://openapi-rdc.aliyuncs.com'), {
    resource: 'yunxiao_commit', repositoryId: '0123456789abcdef01234567/example-team/example-web', commitSha: '0123456789abcdef0123456789abcdef01234567',
  });
  assert.equal(detectPastedReference('not-a-valid-reference').provider, null);

  const md = formatJiraTaskAsMarkdown({
    jiraKey: 'SAMPLE-602',
    title: '新增通知渠道',
    externalRef: {
      provider: 'jira', key: 'SAMPLE-602', title: '新增通知渠道', status: '进行中', version: '2',
      url: 'https://jira.example.invalid/browse/SAMPLE-602', description: '改造说明正文',
    },
  });
  assert.ok(md.includes('# SAMPLE-602 · 新增通知渠道'));
  assert.ok(md.includes('改造说明正文'));

  const specTpl = buildAssetTemplate('TECH_SPEC', { jiraKey: 'SAMPLE-602', title: '新增通知渠道' }, '/Users/demo/Sample/example-web');
  assert.ok(specTpl.title.includes('example-web'));
  assert.ok(specTpl.content.includes('/Users/demo/Sample/example-web'));

  const clipCmd = buildClipboardGitCommand("/Users/demo/O'Reilly/repo", 'working');
  assert.ok(clipCmd.includes("'/Users/demo/O'\\''Reilly/repo'"));
  assert.ok(clipCmd.endsWith('| pbcopy'));
});

test('reviewSourceLinks splits multiple comma/whitespace links and recognizes figma.site prototypes safely', () => {
  const mixed = parseReviewSourceLinks(
    'https://linen-dawn-06160935.figma.site, https://confluence.hahabianli.com/spaces/PRD/pages/57533222/%E3%80%90%E6%9C%8D%E5%8A%A1%E7%90%86%E8%B5%94%E3%80%91',
  );
  assert.equal(mixed.error, undefined);
  assert.deepEqual(mixed.links, [
    'https://linen-dawn-06160935.figma.site/',
    'https://confluence.hahabianli.com/spaces/PRD/pages/57533222/%E3%80%90%E6%9C%8D%E5%8A%A1%E7%90%86%E8%B5%94%E3%80%91',
  ]);

  const noSpace = parseReviewSourceLinks('https://demo.figma.site/,https://docs.example/spaces/PRD/pages/101/Spec，\nhttps://docs.example/a,b');
  assert.equal(noSpace.error, undefined);
  assert.deepEqual(noSpace.links, [
    'https://demo.figma.site/',
    'https://docs.example/spaces/PRD/pages/101/Spec',
    'https://docs.example/a,b',
  ]);

  assert.equal(isDesignLink('https://linen-dawn-06160935.figma.site'), true);
  assert.equal(isDesignLink('https://www.figma.com/design/abc'), true);
  assert.equal(isDesignLink('https://modao.cc/proto/123'), true);
  assert.equal(isDesignLink('https://evilfigma.site/fake'), false);
  assert.equal(isDesignLink('https://confluence.hahabianli.com/spaces/PRD/pages/57533222'), false);

  assert.ok(parseReviewSourceLinks('https://user:pass@docs.example/page').error);
  assert.ok(parseReviewSourceLinks('https://docs.example/page?token=abc').error);
  assert.ok(parseReviewSourceLinks('not-a-url').error);
  assert.deepEqual(parseReviewSourceLinks('   '), { links: [] });
});
