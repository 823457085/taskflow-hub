import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createPlatform } from './server.mjs';

async function startMockRemote() {
  const gitlabToken = randomBytes(24).toString('base64url');
  const state = {
    openaiCalls: [],
    difyCalls: [],
    gitlabDiscussions: [],
    gitlabNotes: [],
    codeupComments: [],
    apifoxCalls: [],
    imPayloads: [],
    failNextGitlabDiscussion: false,
  };

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const json = raw ? JSON.parse(raw) : null;
    res.setHeader('Content-Type', 'application/json');

    // OpenAI-compatible mock
    if (url.pathname === '/openai/v1/models' && req.method === 'GET') {
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'deepseek-chat' }] }));
      return;
    }
    if (url.pathname === '/openai/v1/chat/completions' && req.method === 'POST') {
      state.openaiCalls.push({ auth: req.headers.authorization, body: json });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: '```json\n' + JSON.stringify({
              summary: '云端 LLM 已核对变更内容与边界条件，发现 1 项业务逻辑待补充。',
              evidence: '已检查冻结快照中的代码与规格定义',
              findings: [{
                severity: 'WARN',
                title: '建议补充重试幂等超时阈值说明',
                detail: '支付或状态写接口建议明确幂等键缓存 TTL 与并发冲突返回码。',
                location: 'src/order.ts:3',
              }],
            }) + '\n```',
          },
        }],
      }));
      return;
    }

    // Dify mock
    if (url.pathname === '/dify/v1/parameters' && req.method === 'GET') {
      res.end(JSON.stringify({ opening_statement: 'ready', user_input_form: [] }));
      return;
    }
    if (url.pathname === '/dify/v1/workflows/run' && req.method === 'POST') {
      state.difyCalls.push({ auth: req.headers.authorization, body: json });
      res.end(JSON.stringify({
        data: {
          status: 'succeeded',
          outputs: {
            summary: 'Dify 工作流已完成需求与方案交叉核验。',
            findings: [{
              severity: 'INFO',
              title: '建议补充灰度回滚监控指标名称',
              detail: '可在上线文档中标注具体告警阈值。',
              location: 'PRD#验收标准',
            }],
          },
        },
      }));
      return;
    }

    // Apifox export mock
    if (url.pathname === '/apifox/v1/projects/999/export-openapi' && req.method === 'POST') {
      state.apifoxCalls.push({ headers: req.headers, body: json });
      res.end(JSON.stringify({
        openapi: '3.0.3',
        info: { title: 'Order API', version: '2.0.0' },
        paths: {
          '/api/v1/orders': {
            post: {
              operationId: 'createOrder',
              summary: '创建订单',
              requestBody: {
                content: {
                  'application/json': {
                    schema: {
                      type: 'object',
                      required: ['amount', 'currency'],
                      properties: {
                        amount: { type: 'number' },
                        currency: { type: 'string' },
                      },
                    },
                  },
                },
              },
              responses: { 200: { description: 'ok' } },
            },
          },
        },
      }));
      return;
    }

    // GitLab mock (user, MR, diffs, discussions, notes)
    if (url.pathname.startsWith('/gitlab/') && req.headers['private-token'] !== gitlabToken) {
      res.writeHead(401);
      res.end(JSON.stringify({ message: 'GitLab fixture authentication failed' }));
      return;
    }
    if (url.pathname === '/gitlab/api/v4/user') {
      res.end(JSON.stringify({ id: 7, username: 'gitlab-bot', name: 'GitLab Bot', state: 'active' }));
      return;
    }
    if (url.pathname === '/gitlab/api/v4/projects/100/merge_requests/12' && req.method === 'GET') {
      res.end(JSON.stringify({
        id: 12,
        iid: 12,
        project_id: 100,
        title: 'PAY-101 实现订单支付幂等校验',
        description: '实现幂等与校验',
        state: 'opened',
        sha: 'a'.repeat(40),
        source_branch: 'feat/PAY-101',
        target_branch: 'main',
        source_project_id: 100,
        target_project_id: 100,
        detailed_merge_status: 'mergeable',
        diff_refs: { base_sha: 'b'.repeat(40), start_sha: 'c'.repeat(40), head_sha: 'a'.repeat(40) },
        web_url: `http://127.0.0.1:${server.address().port}/gitlab/team/repo/-/merge_requests/12`,
      }));
      return;
    }
    if (url.pathname === '/gitlab/api/v4/projects/100/merge_requests/12/diffs' && req.method === 'GET') {
      res.end(JSON.stringify([{
        old_path: 'src/order.ts',
        new_path: 'src/order.ts',
        diff: '@@ -1,2 +1,5 @@\n+const sql = `SELECT * FROM orders WHERE id = ${orderId}`;\n+const secret = "sk-abcdefghijklmnop123456";\n+console.log("order", orderId);\n',
      }]));
      return;
    }
    if (url.pathname === '/gitlab/api/v4/projects/100/merge_requests/12/discussions' && req.method === 'POST') {
      if (state.failNextGitlabDiscussion) {
        state.failNextGitlabDiscussion = false;
        res.writeHead(400);
        res.end(JSON.stringify({ message: 'line_code invalid' }));
        return;
      }
      state.gitlabDiscussions.push(json);
      res.writeHead(201);
      res.end(JSON.stringify({ id: 'disc-1' }));
      return;
    }
    if (url.pathname === '/gitlab/api/v4/projects/100/merge_requests/12/notes' && req.method === 'POST') {
      state.gitlabNotes.push(json);
      res.writeHead(201);
      res.end(JSON.stringify({ id: 'note-1' }));
      return;
    }

    // Yunxiao / Codeup mock
    if (url.pathname === '/oapi/v1/flow/organizations/org-1/pipelines') {
      res.end(JSON.stringify([{ pipelineId: 1, pipelineName: 'deploy' }]));
      return;
    }
    if (url.pathname === '/oapi/v1/codeup/organizations/org-1/repositories/200/changeRequests/8' && req.method === 'GET') {
      res.end(JSON.stringify({
        localId: 8,
        projectId: 200,
        title: 'PAY-101 Codeup MR',
        status: 'TO_BE_MERGED',
        sourceBranch: 'feat/PAY-101',
        targetBranch: 'main',
        sourceProjectId: 200,
        targetProjectId: 200,
        allRequirementsPass: true,
        conflictCheckStatus: 'NO_CONFLICT',
      }));
      return;
    }
    if (url.pathname === '/oapi/v1/codeup/organizations/org-1/repositories/200/changeRequests/8/patchSets') {
      res.end(JSON.stringify([{ patchSetBizId: 'ps-base' }, { patchSetBizId: 'ps-head' }]));
      return;
    }
    if (url.pathname === '/oapi/v1/codeup/organizations/org-1/repositories/200/changeRequests/8/comments' && req.method === 'POST') {
      state.codeupComments.push(json);
      res.writeHead(201);
      res.end(JSON.stringify({ commentBizId: 'c-1' }));
      return;
    }

    // IM Webhooks mock (feishu / dingtalk / wecom)
    if (url.pathname.startsWith('/im/')) {
      state.imPayloads.push({
        channel: url.pathname.split('/')[2],
        query: Object.fromEntries(url.searchParams.entries()),
        body: json,
      });
      res.end(JSON.stringify({ errcode: 0, errmsg: 'ok', code: 0 }));
      return;
    }

    res.writeHead(404);
    res.end(JSON.stringify({ message: `Unmocked ${req.method} ${url.pathname}` }));
  });

  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin,
    gitlabToken,
    state,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

async function createTestApp(allowLoopbackHttp = true) {
  const password = 'automation-test-passphrase-123';
  const app = createPlatform({
    dbPath: ':memory:',
    connectorKey: randomBytes(32),
    allowConnectorLoopbackHttp: allowLoopbackHttp,
    publicOrigin: 'https://hub.example.test',
    logger: { error() {} },
  });
  app.server.listen(0, '127.0.0.1');
  await once(app.server, 'listening');
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const req = async (path, method = 'GET', body = undefined, token = undefined, headers = {}) => {
    const res = await fetch(base + path, {
      method,
      headers: {
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = text; }
    return { status: res.status, data, text };
  };
  const setup = async () => {
    await req('/api/setup', 'POST', { username: 'admin', password });
    const adminToken = (await req('/api/login', 'POST', { username: 'admin', password })).data.token;
    await req('/api/users', 'POST', { username: 'dev1', password, role: 'DEV' }, adminToken);
    await req('/api/users', 'POST', { username: 'lead1', password, role: 'LEAD' }, adminToken);
    const devToken = (await req('/api/login', 'POST', { username: 'dev1', password })).data.token;
    const leadToken = (await req('/api/login', 'POST', { username: 'lead1', password })).data.token;
    return { adminToken, devToken, leadToken };
  };
  return { app, base, req, setup, close: () => app.close() };
}

test('OpenAPI/Apifox contract lint, breaking-change diff, and declarative policy plugins execute deterministically', async t => {
  const mock = await startMockRemote();
  const f = await createTestApp(true);
  t.after(async () => { await f.close(); await mock.close(); });
  const { adminToken, devToken } = await f.setup();

  const task = (await f.req('/api/tasks', 'POST', { jiraKey: 'API-10', title: '订单接口契约升级' }, adminToken)).data.task;

  // Register declarative policy plugins + built-in preset
  const regBuiltin = await f.req('/api/plugins', 'POST', {
    id: 'sql-migration-safety',
    name: 'SQL 变更与索引回滚安全门禁',
    version: '1.0.0',
    stages: ['TECH_SPEC', 'CODE_REVIEW'],
    evaluator: 'sql-migration-safety',
  }, adminToken);
  assert.equal(regBuiltin.status, 201);
  assert.equal(regBuiltin.data.plugin.status, 'EXECUTABLE_DECLARATIVE');

  const regCustom = await f.req('/api/plugins', 'POST', {
    id: 'no-raw-fetch-http',
    name: '禁止明文 HTTP 请求',
    version: '1.0.0',
    stages: ['TECH_SPEC'],
    rules: [{
      type: 'regex_forbidden',
      pattern: 'http://internal\\.legacy',
      severity: 'CRITICAL',
      title: '技术方案引用了未加密内网域名',
      detail: '请统一切换为 HTTPS 网关地址。',
    }],
  }, adminToken);
  assert.equal(regCustom.status, 201);
  assert.equal(regCustom.data.plugin.status, 'EXECUTABLE_DECLARATIVE');

  // Import v1 OpenAPI YAML directly
  const v1Yaml = [
    'openapi: 3.0.3',
    'info:',
    '  title: Order Service',
    '  version: 1.0.0',
    'paths:',
    '  /api/v1/orders:',
    '    post:',
    '      operationId: createOrder',
    '      summary: 创建订单',
    '      requestBody:',
    '        content:',
    '          application/json:',
    '            schema:',
    '              type: object',
    '              required:',
    '                - amount',
    '              properties:',
    '                amount:',
    '                  type: number',
    '      responses:',
    '        "200":',
    '          description: ok',
    '          content:',
    '            application/json:',
    '              schema:',
    '                type: object',
    '                properties:',
    '                  orderId:',
    '                    type: string',
    '  /api/v1/legacy:',
    '    get:',
    '      summary: 旧接口',
    '      responses:',
    '        "200":',
    '          description: ok',
  ].join('\n');

  const impV1 = await f.req(`/api/tasks/${task.id}/assets/import-api-spec`, 'POST', {
    content: v1Yaml,
    logicalKey: 'api-contract',
  }, devToken);
  assert.equal(impV1.status, 201);
  assert.equal(impV1.data.specSummary.format, 'openapi-3.x');
  assert.equal(impV1.data.specSummary.endpointCount, 2);
  assert.ok(impV1.data.findings.some(item => item.severity === 'CRITICAL' && item.title.includes('缺少鉴权声明')));
  assert.ok(impV1.data.findings.some(item => item.severity === 'WARN' && item.title.includes('未声明幂等标识')));

  // Import v2 from Apifox mock -> should detect breaking changes against v1!
  const impV2 = await f.req(`/api/tasks/${task.id}/assets/import-api-spec`, 'POST', {
    apifoxProjectId: '999',
    apifoxToken: 'apifox-secret-token',
    apifoxBaseUrl: `${mock.origin}/apifox`,
    logicalKey: 'api-contract',
  }, devToken);
  assert.equal(impV2.status, 201);
  assert.equal(impV2.data.asset.revision, 2);
  assert.equal(mock.state.apifoxCalls.length, 1);
  assert.ok(impV2.data.findings.some(item => item.severity === 'CRITICAL' && item.title.includes('移除既有接口 GET /api/v1/legacy')));
  assert.ok(impV2.data.findings.some(item => item.severity === 'CRITICAL' && item.title.includes('新增必填请求字段 currency')));

  // Also add PRD + TECH_SPEC narrative with DDL & forbidden URL, then run job precheck
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: '订单需求', content: '订单创建主流程' }, adminToken);
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', {
    kind: 'TECH_SPEC',
    logicalKey: 'TECH_SPEC',
    title: '方案设计',
    content: 'ALTER TABLE orders ADD COLUMN fee INT;\n调用 http://internal.legacy/pay',
  }, devToken);
  const job = (await f.req('/api/reviews', 'POST', { taskId: task.id, stage: 'TECH_SPEC', executionMode: 'LOCAL_REPORT' }, devToken)).data.job;
  const precheck = await f.req(`/api/jobs/${job.id}/precheck`, 'POST', {}, devToken);
  assert.equal(precheck.status, 200);
  assert.ok(precheck.data.executedPlugins.includes('sql-migration-safety'));
  assert.ok(precheck.data.executedPlugins.includes('no-raw-fetch-http'));
  assert.ok(precheck.data.findings.some(item => item.title.includes('DDL')));
  assert.ok(precheck.data.findings.some(item => item.title.includes('未加密内网域名')));
  assert.ok(precheck.data.findings.some(item => item.title.includes('移除既有接口')));
});

test('project-shared GitLab account powers webhook imports and MR writeback alongside cloud reviews and IM notifications', async t => {
  const mock = await startMockRemote();
  const f = await createTestApp(true);
  t.after(async () => { await f.close(); await mock.close(); });
  const { adminToken, devToken, leadToken } = await f.setup();

  const gitlabAccount = await f.req('/api/accounts', 'POST', {
    name: 'GitLab project automation',
    provider: 'gitlab',
    scope: 'PROJECT',
    projectId: 'default',
    baseUrl: `${mock.origin}/gitlab`,
    authMode: 'PRIVATE_TOKEN',
    token: mock.gitlabToken,
  }, adminToken);
  assert.equal(gitlabAccount.status, 201);
  assert.ok(!gitlabAccount.text.includes(mock.gitlabToken));
  const defaults = await f.req('/api/connectors?projectId=default&defaults=1', 'GET', undefined, adminToken);
  assert.equal(defaults.status, 200);
  assert.equal(defaults.data.connectors.find(item => item.provider === 'gitlab').hasCredential, false);

  // Configure IM webhooks: Feishu & DingTalk (with signing secret) & WeCom
  const feishu = await f.req('/api/projects/default/notifications', 'POST', {
    channel: 'feishu',
    name: '研发评审飞书群',
    webhookUrl: `${mock.origin}/im/feishu/hook`,
    signingSecret: 'feishu-sign-secret',
  }, leadToken);
  assert.equal(feishu.status, 201);
  assert.ok(!feishu.text.includes('feishu-sign-secret'));

  const dingtalk = await f.req('/api/projects/default/notifications', 'POST', {
    channel: 'dingtalk',
    name: '钉钉告警群',
    webhookUrl: `${mock.origin}/im/dingtalk/robot?access_token=abc`,
    signingSecret: 'SEC-ding-secret',
  }, leadToken);
  assert.equal(dingtalk.status, 201);

  const testIm = await f.req(`/api/projects/default/notifications/${dingtalk.data.notification.id}/test`, 'POST', {}, leadToken);
  assert.equal(testIm.status, 200);
  const lastDing = mock.state.imPayloads.at(-1);
  assert.equal(lastDing.channel, 'dingtalk');
  assert.ok(lastDing.query.timestamp && lastDing.query.sign);

  // DEV cannot configure Cloud AI
  const forbiddenAi = await f.req('/api/projects/default/cloud-ai', 'PUT', {
    providerType: 'openai_compatible',
    name: 'DeepSeek',
    baseUrl: `${mock.origin}/openai`,
    model: 'deepseek-chat',
    apiKey: 'sk-live-secret-999',
  }, devToken);
  assert.equal(forbiddenAi.status, 403);

  // LEAD configures OpenAI-compatible Cloud AI with autoWritebackMr=true
  const aiSave = await f.req('/api/projects/default/cloud-ai', 'PUT', {
    providerType: 'openai_compatible',
    name: 'DeepSeek Reviewer',
    baseUrl: `${mock.origin}/openai`,
    model: 'deepseek-chat',
    apiKey: 'sk-live-secret-999',
    enabled: true,
    autoStages: ['PRD', 'TECH_SPEC', 'CODE_REVIEW'],
    autoWritebackMr: true,
  }, leadToken);
  assert.equal(aiSave.status, 200);
  assert.ok(!aiSave.text.includes('sk-live-secret-999'));
  assert.equal(aiSave.data.config.autoWritebackMr, true);

  const aiTest = await f.req('/api/projects/default/cloud-ai/test', 'POST', {}, leadToken);
  assert.equal(aiTest.status, 200);
  assert.ok(aiTest.data.config.lastCheckedAt);

  // Create task PAY-101 and seed PRD + TECH_SPEC
  const task = (await f.req('/api/tasks', 'POST', { jiraKey: 'PAY-101', title: '实现订单支付幂等校验' }, devToken)).data.task;
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: '支付需求', content: '# 验收标准\n幂等校验\n# 异常\n超时提示\n# 权限\n商家角色' }, adminToken);
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: '支付方案', content: '使用 Idempotency-Key 防止重复支付' }, devToken);

  // Create GitLab webhook
  const hookCreate = await f.req('/api/projects/default/webhooks', 'POST', {
    provider: 'gitlab',
    name: 'GitLab 主仓 MR Webhook',
    autoReview: true,
  }, leadToken);
  assert.equal(hookCreate.status, 201);
  const webhookPath = hookCreate.data.webhook.webhookPath;
  const webhookSecret = hookCreate.data.secret;

  // Reject invalid webhook token
  const badHook = await f.req(webhookPath, 'POST', { object_kind: 'merge_request' }, undefined, { 'X-Gitlab-Token': 'wrong-token' });
  assert.equal(badHook.status, 401);

  // Trigger GitLab MR webhook -> auto-imports GitLab MR diffs -> runs deterministic code scan + OpenAI Cloud AI -> auto-writes back to GitLab MR -> emits IM notifications!
  const mrPayload = {
    object_kind: 'merge_request',
    project: { id: 100, path_with_namespace: 'team/repo' },
    object_attributes: {
      iid: 12,
      title: 'PAY-101 实现订单支付幂等校验',
      source_branch: 'feat/PAY-101',
      target_branch: 'main',
      state: 'opened',
      last_commit: { id: 'a'.repeat(40) },
    },
  };
  const goodHook = await f.req(webhookPath, 'POST', mrPayload, undefined, { 'X-Gitlab-Token': webhookSecret });
  assert.equal(goodHook.status, 200);
  assert.equal(goodHook.data.processed, true);
  assert.equal(goodHook.data.taskId, task.id);
  const codeJob = goodHook.data.review.job;
  assert.equal(codeJob.executionMode, 'CLOUD_AI');
  assert.equal(codeJob.status, 'REPORT_SUBMITTED');
  assert.equal(codeJob.report.source, 'CLOUD_AI');
  // Must contain deterministic SQLi + secret findings AND OpenAI LLM finding!
  assert.ok(codeJob.findings.some(item => item.title.includes('SQL 拼接注入')));
  assert.ok(codeJob.findings.some(item => item.title.includes('大模型密钥')));
  assert.ok(codeJob.findings.some(item => item.title.includes('重试幂等超时阈值')));
  // Auto writeback posted inline discussions + summary note to GitLab!
  assert.ok(mock.state.gitlabDiscussions.length >= 2);
  assert.equal(mock.state.gitlabNotes.length, 1);
  assert.equal(mock.state.gitlabDiscussions[0].position.new_path, 'src/order.ts');

  // Verify webhook event & notification logs were recorded
  const whEvents = await f.req('/api/projects/default/webhook-events', 'GET', undefined, devToken);
  assert.equal(whEvents.status, 200);
  assert.equal(whEvents.data.events[0].status, 'PROCESSED');

  // Manual MR writeback with fallback test (force first discussion to 400 -> must fall back into summary note!)
  const selection = await f.req('/api/accounts/select', 'POST', {
    projectId: 'default', provider: 'gitlab', accountId: gitlabAccount.data.account.id,
  }, leadToken);
  assert.equal(selection.status, 200);
  mock.state.failNextGitlabDiscussion = true;
  const manualWb = await f.req(`/api/tasks/${task.id}/merge-requests/${goodHook.data.asset.id}/writeback`, 'POST', {
    jobId: codeJob.id,
  }, leadToken);
  assert.equal(manualWb.status, 201);
  assert.equal(manualWb.data.writeback.summaryPosted, true);
  assert.ok(manualWb.data.writeback.fallbackReason);

  // Switch Cloud AI to Dify workflow and run PRD review via HMAC-signed generic webhook!
  const difySave = await f.req('/api/projects/default/cloud-ai', 'PUT', {
    providerType: 'dify',
    name: 'Dify PRD Reviewer',
    baseUrl: `${mock.origin}/dify`,
    difyMode: 'workflow',
    enabled: true,
    autoStages: ['PRD'],
  }, leadToken);
  assert.equal(difySave.status, 200);

  const docHook = await f.req('/api/projects/default/webhooks', 'POST', {
    provider: 'generic',
    name: 'Confluence/文档更新 Webhook',
    secret: 'hmac-shared-secret-1234',
    autoReview: true,
  }, leadToken);
  assert.equal(docHook.status, 201);

  const docBody = JSON.stringify({
    taskKey: 'PAY-101',
    kind: 'PRD',
    title: 'PAY-101 支付需求 v2',
    content: '# 验收标准\n支持新版退款与幂等\n# 异常\n网络超时可重试\n# 权限\n管理员可操作',
  });
  const sig = 'sha256=' + createHmac('sha256', 'hmac-shared-secret-1234').update(docBody).digest('hex');
  const docTrigger = await fetch(f.base + docHook.data.webhook.webhookPath, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Taskflow-Signature-256': sig },
    body: docBody,
  });
  assert.equal(docTrigger.status, 200);
  const docJson = await docTrigger.json();
  assert.equal(docJson.processed, true);
  assert.equal(docJson.review.job.report.source, 'CLOUD_AI');
  assert.equal(mock.state.difyCalls.length, 1);
  assert.ok(docJson.review.job.findings.some(item => item.title.includes('灰度回滚监控指标')));

  // Wait briefly for non-blocking IM emits to flush
  await new Promise(resolve => setTimeout(resolve, 100));
  const imLogs = await f.req('/api/projects/default/notification-logs', 'GET', undefined, devToken);
  assert.equal(imLogs.status, 200);
  assert.ok(imLogs.data.logs.some(l => l.status === 'SENT' && l.eventType === 'CRITICAL_BLOCKER'));
});

test('Codeup MR comment writeback uses Yunxiao GLOBAL_COMMENT / INLINE_COMMENT endpoint cleanly', async t => {
  const mock = await startMockRemote();
  const f = await createTestApp(true);
  t.after(async () => { await f.close(); await mock.close(); });
  const { adminToken, leadToken } = await f.setup();

  await f.req('/api/connectors/yunxiao/config', 'POST', {
    projectId: 'default',
    baseUrl: mock.origin,
    authMode: 'PRIVATE_TOKEN',
    token: 'yx-token-123',
    organizationId: 'org-1',
  }, adminToken);

  const task = (await f.req('/api/tasks', 'POST', { jiraKey: 'YX-1', title: 'Codeup Writeback' }, adminToken)).data.task;
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'PRD', title: 'PRD', content: 'PRD' }, adminToken);
  await f.req(`/api/tasks/${task.id}/assets`, 'POST', { kind: 'TECH_SPEC', title: 'Spec', content: 'Spec' }, adminToken);
  const imp = await f.req('/api/connectors/yunxiao/import', 'POST', {
    projectId: 'default',
    resource: 'yunxiao_mr',
    repositoryId: '200',
    mrLocalId: '8',
    taskId: task.id,
    kind: 'CODE',
  }, adminToken);
  assert.equal(imp.status, 200);

  const job = (await f.req('/api/reviews', 'POST', { taskId: task.id, stage: 'CODE_REVIEW', executionMode: 'HUMAN_REVIEW' }, adminToken)).data.job;
  await f.req(`/api/jobs/${job.id}/report`, 'POST', {
    summary: '发现空捕获风险',
    source: 'MANUAL',
    findings: [{ severity: 'WARN', title: '空 catch 块', detail: '补充错误日志', location: 'src/pay.ts:18' }],
  }, adminToken);

  const wb = await f.req(`/api/tasks/${task.id}/merge-requests/${imp.data.asset.id}/writeback`, 'POST', { jobId: job.id }, leadToken);
  assert.equal(wb.status, 201);
  assert.equal(wb.data.writeback.inlineCount, 1);
  assert.equal(wb.data.writeback.summaryPosted, true);
  assert.equal(mock.state.codeupComments.length, 2);
  assert.equal(mock.state.codeupComments[0].comment_type, 'INLINE_COMMENT');
  assert.equal(mock.state.codeupComments[0].file_path, '/src/pay.ts');
  assert.equal(mock.state.codeupComments[1].comment_type, 'GLOBAL_COMMENT');
});
