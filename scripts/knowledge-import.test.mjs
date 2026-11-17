import test from 'node:test';
import assert from 'node:assert/strict';
import { catalogDocs, markdownDoc } from '../preview-app/src/views/knowledgeImport.ts';

test('Delivery system catalog becomes one knowledge doc per system without any account credentials', () => {
  const docs = catalogDocs({
    catalog: { systems: [
      { id: 'sample', name: 'SAMPLE 后台', region: '海外', repository: 'https://codeup.example/example-web.git', source: { title: '项目汇总', url: 'https://wiki.example/1' },
        environments: [{ name: '开发', branch: 'develop', url: 'https://dev.example/', pipeline: '云效|dev', notes: '', accounts: [{ username: 'zhangpan', password: 'p@ss-123456' }] }] },
      { id: '', name: '缺 ID' },
    ] },
    localSystems: [{ id: 'local', name: '本地系统', environments: [] }],
  });
  assert.deepEqual(docs.map(doc => [doc.sourceRef, doc.title, doc.tags]), [['catalog:sample', 'SAMPLE 后台', ['系统目录', '海外']], ['catalog:local', '本地系统', ['系统目录']]]);
  assert.match(docs[0].body, /\| 开发 \| develop \| https:\/\/dev\.example\/ \| 云效\\\|dev \| — \|/);
  assert.match(docs[0].body, /1 个测试账号，账号密码不导入/);
  assert.ok(!docs[0].body.includes('p@ss-123456') && !docs[0].body.includes('zhangpan'));
  assert.deepEqual(catalogDocs(null), []);
});

test('markdown files take title and tags from front matter or first heading', () => {
  assert.deepEqual(markdownDoc('pay.md', '---\ntitle: "支付排障"\ntags: [支付, SOP]\n---\n\n# 另一个标题\n正文'), { sourceRef: 'file:pay.md', title: '支付排障', body: '# 另一个标题\n正文', tags: ['支付', 'SOP'] });
  assert.deepEqual(markdownDoc('notes.md', '\uFEFF# 部署手册\n步骤'), { sourceRef: 'file:notes.md', title: '部署手册', body: '# 部署手册\n步骤', tags: [] });
  assert.equal(markdownDoc('空.txt', '').title, '空');
});
