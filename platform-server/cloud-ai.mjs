import { ApiError, REVIEW_ROLES, REVIEW_STAGES, STAGE_AGENTS, STAGES, fail, taskRow, textField } from './common.mjs';
import { REVIEW_READABILITY_GUIDE } from './ai-prompt.mjs';
import { createKeyLoader, httpRequestRaw, redactText, sealSecret, unsealSecret, validateRemoteUrl } from './crypto-http.mjs';
import { extractReviewDraft } from './local-automation.mjs';
import { evaluateDeterministicPrechecks } from './policy-runner.mjs';
import { mapRunToSkillScopes } from './skill-bundles.mjs';
import { projectSkillRows } from './team-skills.mjs';
import { requireReviewableTask } from './workflow.mjs';

const STAGE_INSTRUCTIONS = {
  PRD: [
    '你正在执行【需求评审 (PRD)】。重点核查：',
    '1. 业务目标、主流程、状态机流转是否闭环，是否存在互相矛盾或未定义的状态；',
    '2. 边界条件、异常兜底、权限控制、多租户/灰度兼容性是否明确；',
    '3. 验收标准（AC）是否可测试、可量化，是否存在模糊表述。',
  ].join('\n'),
  TECH_SPEC: [
    '你正在执行【技术方案与接口文档审核 (TECH_SPEC)】。重点核查：',
    '1. 技术方案是否完整覆盖 PRD 需求与异常分支；',
    '2. 接口契约（OpenAPI/Swagger/Apifox）是否规范：鉴权、入参校验、错误码定义、幂等性、向下兼容性与破坏性变更；',
    '3. 数据表/索引变更、分布式并发控制、降级与回滚方案是否可行。',
  ].join('\n'),
  CODE_REVIEW: [
    '你正在执行【代码审核 (CODE_REVIEW)】。重点核查：',
    '1. 代码实现与 PRD / TECH_SPEC 及接口契约是否一致；',
    '2. 越权/注入/XSS/敏感信息泄露等安全问题、空指针与异常吞没、并发锁与事务一致性；',
    '3. 尽量为每个问题给出精确的 location（格式：文件路径:行号，例如 src/order.ts:42），以便回写 MR 行内评论。',
  ].join('\n'),
  TEST_CASE: [
    '你正在执行【测试用例评审 (TEST_CASE)】。重点核查：',
    '1. 测试用例是否覆盖 PRD 全部正向主链路与验收标准；',
    '2. 是否充分覆盖幂等重放、越权访问、参数边界、灰度兼容与异常回滚场景；',
    '3. 步骤、前置条件与预期结果是否具体可执行。',
  ].join('\n'),
  RELEASE: [
    '你正在执行【上线审核 (RELEASE)】。重点核查：',
    '1. 变更物料清单、配置/SQL 脚本顺序与构建版本证据是否齐备；',
    '2. 灰度放量节奏、监控告警指标与 5 分钟内可执行的回滚预案是否明确；',
    '3. 上下游依赖与历史存量数据兼容风险是否已兜底。',
  ].join('\n'),
};

export function buildApiEndpoint(baseUrl, suffix) {
  const cleanBase = String(baseUrl || '').replace(/\/+$/, '');
  const cleanSuffix = suffix.startsWith('/') ? suffix : `/${suffix}`;
  if (/\/v1$/i.test(cleanBase)) return `${cleanBase}${cleanSuffix}`;
  return `${cleanBase}/v1${cleanSuffix}`;
}

export function createCloudAi({ db, dbPath, transaction, audit, projectRole, getTask, workflow, mrWriteback, imNotifications, key, allowLoopbackHttp = false }) {
  const loadKey = createKeyLoader(dbPath, key);
  const inFlightJobs = new Set();

  const rawRow = projectId => db.prepare('SELECT * FROM cloud_ai_configs WHERE project_id=?').get(projectId) || null;

  function getCloudExecutor(projectId) {
    const row = rawRow(projectId);
    if (!row || row.enabled !== 1) return null;
    return {
      projectId: row.project_id,
      providerType: row.provider_type,
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      difyMode: row.dify_mode,
      enabled: true,
      autoStages: JSON.parse(row.auto_stages || '[]'),
      autoWritebackMr: row.auto_writeback_mr === 1,
      timeoutMs: row.timeout_ms,
      executorLabel: row.provider_type === 'openai_compatible'
        ? `openai:${row.model || 'default'}`
        : `dify:${row.dify_mode || 'workflow'}`,
    };
  }

  function serializeConfig(row) {
    if (!row) return null;
    return {
      projectId: row.project_id,
      providerType: row.provider_type,
      name: row.name,
      baseUrl: row.base_url,
      model: row.model,
      difyMode: row.dify_mode,
      hasCredential: !!row.credential,
      enabled: row.enabled === 1,
      autoStages: JSON.parse(row.auto_stages || '[]'),
      autoWritebackMr: row.auto_writeback_mr === 1,
      timeoutMs: row.timeout_ms,
      version: row.version,
      updatedBy: row.updated_by,
      updatedAt: row.updated_at,
      lastCheckedAt: row.last_checked_at || null,
      lastError: row.last_error || null,
    };
  }

  const requireAdminOrLead = (user, projectId) => {
    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权管理云端 AI 配置');
    const role = projectRole(user, projectId);
    if (!['ADMIN', 'LEAD'].includes(role) && user.role !== 'ADMIN') {
      fail(403, 'FORBIDDEN', '仅项目负责人或系统管理员可配置云端 AI 执行器');
    }
    return role;
  };

  function decryptApiKey(row) {
    const parsed = unsealSecret(loadKey, [row.project_id, 'cloud_ai'], row.credential, '云端 AI 密钥无法读取，请重新保存');
    if (!parsed?.apiKey) fail(500, 'CREDENTIAL_UNAVAILABLE', '云端 AI 密钥不可用');
    return parsed.apiKey;
  }

  function loadPreviousAssetsByKey(taskId, snapshotAssets = []) {
    const map = new Map();
    for (const asset of snapshotAssets) {
      if (!asset?.kind || !asset?.logicalKey || !Number.isInteger(asset.revision) || asset.revision <= 1) continue;
      const prev = db.prepare('SELECT * FROM assets WHERE task_id=? AND kind=? AND logical_key=? AND revision<? ORDER BY revision DESC LIMIT 1')
        .get(taskId, asset.kind, asset.logicalKey, asset.revision);
      if (prev) map.set(`${asset.kind}:${asset.logicalKey}`, prev);
    }
    return map;
  }

  function loadProjectKnowledgeContext(projectId, taskTitle = '', stage = null, user = null) {
    const targetScopes = stage ? mapRunToSkillScopes({ mode: 'review', stage }) : [];
    const scopeSet = new Set(targetScopes);
    const parseArr = raw => { try { const v = JSON.parse(raw || '[]'); return Array.isArray(v) ? v : []; } catch { return []; } };
    const rows = projectSkillRows(db, projectId, { ownerId: user?.localDevice ? null : user?.id, onlyEnabled: true });
    const merged = rows.sort((a, b) => a.visibility.localeCompare(b.visibility)).map(s => ({
      name: s.name,
      description: s.description,
      content: s.content,
      scopes: parseArr(s.scopes),
      files: parseArr(s.files),
      updated_at: s.updated_at,
    }));
    const byName = new Map();
    for (const s of merged) {
      if (scopeSet.size && s.scopes.length && !s.scopes.some(sc => scopeSet.has(sc))) continue;
      if (!byName.has(s.name)) byName.set(s.name, s);
    }
    const skills = [...byName.values()].slice(0, 6);
    const docs = db.prepare('SELECT title,body,tags FROM knowledge_docs WHERE project_id=? ORDER BY updated_at DESC LIMIT 12').all(projectId);
    const keywords = String(taskTitle || '').toLowerCase().split(/[\s,，。.:：/()（）_-]+/).filter(w => w.length >= 2);
    const scoredDocs = docs
      .map(d => {
        const hay = `${d.title} ${d.tags} ${d.body.slice(0, 400)}`.toLowerCase();
        const score = keywords.reduce((sum, kw) => sum + (hay.includes(kw) ? 1 : 0), 0);
        return { ...d, score };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);
    return { skills, docs: scoredDocs };
  }

  function buildCloudReviewPrompts({ task, job, precheck, knowledge }) {
    const agent = STAGE_AGENTS[job.stage] || { persona: 'ai-reviewer', skills: [] };
    const assets = Array.isArray(job.snapshot?.assets) ? job.snapshot.assets : [];
    const plugins = Array.isArray(job.snapshot?.plugins) ? job.snapshot.plugins : [];

    const systemPrompt = [
      `你是 TaskFlow AI Hub 的云端评审专家（角色：${agent.persona}，默认能力：${agent.skills.join(', ')}）。`,
      '请严格基于提供的冻结任务上下文、材料版本和确定性预检结果进行专业、客观、可落地的评审。',
      '不要编造不存在的文件名、行号或未检查的事实。',
      REVIEW_READABILITY_GUIDE,
      '必须输出合法 JSON（可放在 ```json 代码块中），格式严格为：',
      '{"summary":"总体结论(中文)","evidence":"核对的材料与依据","findings":[{"severity":"CRITICAL|WARN|INFO","title":"问题简述","detail":"详细原因与修改建议","location":"文件:行号或章节"}]}',
    ].join('\n');

    const sections = [
      STAGE_INSTRUCTIONS[job.stage] || `当前阶段：${job.stage}`,
      `## 任务信息\n- Key: ${task.jiraKey}\n- 标题: ${task.title}\n- 阶段: ${job.stage}\n- 上下文版本: v${task.contextVersion}`,
    ];

    if (task.externalRef?.description) {
      sections.push(`## Jira 原始描述\n${String(task.externalRef.description).slice(0, 4000)}`);
    }
    if (plugins.length) {
      sections.push(`## 生效门禁策略插件\n${plugins.map(p => `- ${p.name} (${p.id}@${p.version})`).join('\n')}`);
    }
    if (knowledge.skills.length) {
      sections.push(`## 团队 / 个人 Skill 规范\n${knowledge.skills.map(s => {
        const refText = (Array.isArray(s.files) ? s.files : [])
          .filter(f => /\.md$/i.test(f.path || ''))
          .slice(0, 3)
          .map(f => `#### 参考文档：${f.path}\n${String(f.content || '').slice(0, 900)}`)
          .join('\n\n');
        return `### ${s.name}\n${s.description}\n${String(s.content || '').slice(0, 1800)}${refText ? `\n\n${refText}` : ''}`;
      }).join('\n\n')}`);
    }
    if (knowledge.docs.length) {
      sections.push(`## 团队知识库参考\n${knowledge.docs.map(d => `### ${d.title}\n${String(d.body || '').slice(0, 1200)}`).join('\n\n')}`);
    }
    if (precheck.findings.length) {
      sections.push(`## 确定性规则/契约预检已发现问题（请结合上下文补充深度语义审查，不必重复照抄相同条目）\n${precheck.findings.map(f => `- [${f.severity}] ${f.title}${f.location ? ` @ ${f.location}` : ''}: ${f.detail}`).join('\n')}`);
    }
    sections.push('## 冻结待审材料快照');
    for (const asset of assets) {
      sections.push(`### [${asset.kind}] ${asset.title} (r${asset.revision}, sha256:${String(asset.sha256 || '').slice(0, 8)})\n${String(asset.content || '').slice(0, 16000)}`);
    }

    return { systemPrompt, userPrompt: sections.join('\n\n').slice(0, 90_000) };
  }

  async function callCloudProvider(row, apiKey, { systemPrompt, userPrompt, stage, task, snapshot }) {
    const secrets = [apiKey];
    const headers = {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    };

    if (row.provider_type === 'openai_compatible') {
      const endpoint = buildApiEndpoint(row.base_url, '/chat/completions');
      const res = await httpRequestRaw(endpoint, {
        method: 'POST',
        headers,
        body: {
          model: row.model || 'gpt-4o-mini',
          temperature: 0.1,
          messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
          ],
        },
        timeoutMs: row.timeout_ms || 60_000,
        secrets,
      });
      let data;
      try { data = JSON.parse(res.text); } catch { fail(502, 'CLOUD_AI_INVALID_RESPONSE', '云端模型服务未返回有效 JSON'); }
      if (res.status < 200 || res.status >= 300) {
        const msg = data?.error?.message || data?.message || `HTTP ${res.status}`;
        fail(502, 'CLOUD_AI_REQUEST_FAILED', redactText(`云端模型调用失败：${msg}`, secrets));
      }
      const rawContent = data?.choices?.[0]?.message?.content;
      const text = Array.isArray(rawContent)
        ? rawContent.map(part => part?.text || '').join('\n')
        : String(rawContent || '');
      if (!text.trim()) fail(502, 'CLOUD_AI_EMPTY_RESPONSE', '云端模型返回内容为空');
      return { text, usage: data?.usage || null };
    }

    // Dify workflow or chat API
    if (row.dify_mode === 'chat') {
      const endpoint = buildApiEndpoint(row.base_url, '/chat-messages');
      const res = await httpRequestRaw(endpoint, {
        method: 'POST',
        headers,
        body: {
          inputs: {
            stage,
            task_key: task.jiraKey,
            task_title: task.title,
            system_prompt: systemPrompt,
          },
          query: userPrompt,
          response_mode: 'blocking',
          user: `taskflow-${task.projectId}`,
        },
        timeoutMs: row.timeout_ms || 60_000,
        secrets,
      });
      let data;
      try { data = JSON.parse(res.text); } catch { fail(502, 'CLOUD_AI_INVALID_RESPONSE', 'Dify 未返回有效 JSON'); }
      if (res.status < 200 || res.status >= 300) {
        fail(502, 'CLOUD_AI_REQUEST_FAILED', redactText(`Dify 调用失败：${data?.message || `HTTP ${res.status}`}`, secrets));
      }
      const answer = String(data?.answer || '').trim();
      if (!answer) fail(502, 'CLOUD_AI_EMPTY_RESPONSE', 'Dify 返回内容为空');
      return { text: answer, usage: data?.metadata?.usage || null };
    }

    const endpoint = buildApiEndpoint(row.base_url, '/workflows/run');
    const res = await httpRequestRaw(endpoint, {
      method: 'POST',
      headers,
      body: {
        inputs: {
          stage,
          task_key: task.jiraKey,
          task_title: task.title,
          system_prompt: systemPrompt,
          prompt: userPrompt,
          snapshot_json: JSON.stringify(snapshot).slice(0, 30_000),
        },
        response_mode: 'blocking',
        user: `taskflow-${task.projectId}`,
      },
      timeoutMs: row.timeout_ms || 60_000,
      secrets,
    });
    let data;
    try { data = JSON.parse(res.text); } catch { fail(502, 'CLOUD_AI_INVALID_RESPONSE', 'Dify Workflow 未返回有效 JSON'); }
    if (res.status < 200 || res.status >= 300 || data?.data?.status === 'failed') {
      const msg = data?.data?.error || data?.message || `HTTP ${res.status}`;
      fail(502, 'CLOUD_AI_REQUEST_FAILED', redactText(`Dify Workflow 执行失败：${msg}`, secrets));
    }
    const outputs = data?.data?.outputs || data?.outputs || {};
    if (typeof outputs.summary === 'string' && Array.isArray(outputs.findings)) {
      return { text: JSON.stringify(outputs), usage: data?.data?.total_tokens ? { total_tokens: data.data.total_tokens } : null };
    }
    const outputText = outputs.result || outputs.text || outputs.output || outputs.answer || (typeof outputs === 'string' ? outputs : JSON.stringify(outputs));
    if (!String(outputText || '').trim()) fail(502, 'CLOUD_AI_EMPTY_RESPONSE', 'Dify Workflow 返回输出为空');
    return { text: String(outputText), usage: null };
  }

  async function testConfig(row) {
    const apiKey = decryptApiKey(row);
    const secrets = [apiKey];
    const headers = { Authorization: `Bearer ${apiKey}`, Accept: 'application/json' };
    try {
      if (row.provider_type === 'openai_compatible') {
        const modelsRes = await httpRequestRaw(buildApiEndpoint(row.base_url, '/models'), { method: 'GET', headers, timeoutMs: 12_000, secrets });
        if (modelsRes.status >= 200 && modelsRes.status < 300) {
          let ok = false;
          try { const parsed = JSON.parse(modelsRes.text); ok = !!parsed && typeof parsed === 'object'; } catch { ok = false; }
          if (!ok) fail(502, 'CLOUD_AI_INVALID_RESPONSE', '模型列表接口未返回有效 JSON');
        } else if (modelsRes.status === 404 || modelsRes.status === 405) {
          const pingRes = await httpRequestRaw(buildApiEndpoint(row.base_url, '/chat/completions'), {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body: { model: row.model || 'gpt-4o-mini', max_tokens: 1, messages: [{ role: 'user', content: 'ping' }] },
            timeoutMs: 15_000,
            secrets,
          });
          if (pingRes.status < 200 || pingRes.status >= 300) {
            fail(502, 'CLOUD_AI_TEST_FAILED', redactText(`连通测试失败（HTTP ${pingRes.status}）`, secrets));
          }
        } else {
          fail(502, 'CLOUD_AI_TEST_FAILED', redactText(`连通测试失败（HTTP ${modelsRes.status}）`, secrets));
        }
      } else {
        const difyRes = await httpRequestRaw(buildApiEndpoint(row.base_url, '/parameters'), { method: 'GET', headers, timeoutMs: 12_000, secrets });
        if (difyRes.status < 200 || difyRes.status >= 300) {
          fail(502, 'CLOUD_AI_TEST_FAILED', redactText(`Dify 参数探测失败（HTTP ${difyRes.status}）`, secrets));
        }
      }
      const checkedAt = new Date().toISOString();
      db.prepare('UPDATE cloud_ai_configs SET last_checked_at=?,last_error=NULL WHERE project_id=?').run(checkedAt, row.project_id);
      return { ok: true, config: serializeConfig(rawRow(row.project_id)) };
    } catch (error) {
      const safeErr = redactText(error?.message || '连接测试失败', secrets);
      db.prepare('UPDATE cloud_ai_configs SET last_checked_at=?,last_error=? WHERE project_id=?').run(new Date().toISOString(), safeErr, row.project_id);
      throw error instanceof ApiError ? error : new ApiError(502, 'CLOUD_AI_TEST_FAILED', safeErr);
    }
  }

  async function executeJob({ jobId, actorId, user = null }) {
    const jobRowRaw = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!jobRowRaw) fail(404, 'JOB_NOT_FOUND', '评审任务不存在');
    const task = user ? getTask(jobRowRaw.task_id, user) : taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(jobRowRaw.task_id));
    if (!task) fail(404, 'TASK_NOT_FOUND', '任务不存在');
    requireReviewableTask(task, jobRowRaw.stage);
    if (task.status === 'DONE') fail(409, 'TASK_DONE', '任务已完成，请先重开任务');

    const configRow = rawRow(task.projectId);
    if (!configRow || configRow.enabled !== 1) {
      fail(409, 'EXECUTOR_UNCONFIGURED', '当前项目尚未启用云端 AI 执行器，请在「平台连接」中配置并启用');
    }
    if (jobRowRaw.execution_mode !== 'CLOUD_AI') {
      fail(400, 'INVALID_MODE', '仅 CLOUD_AI 模式的评审任务支持云端 AI 自动执行');
    }
    const job = workflow.jobRow(jobRowRaw, task);
    if (job.stale) fail(409, 'STALE_REVIEW', '评审输入或上游审批已变化，请基于最新材料重新发起评审');
    if (job.report) fail(409, 'REPORT_EXISTS', '该评审任务已提交报告');
    if (inFlightJobs.has(jobId)) fail(409, 'CLOUD_AI_IN_PROGRESS', '云端 AI 正在评审该任务，请稍候刷新');

    inFlightJobs.add(jobId);
    try {
      const apiKey = decryptApiKey(configRow);
      const prevMap = loadPreviousAssetsByKey(task.id, job.snapshot?.assets || []);
      const precheck = evaluateDeterministicPrechecks({ stage: job.stage, snapshot: job.snapshot, previousAssetsByKey: prevMap });
      const knowledge = loadProjectKnowledgeContext(task.projectId, task.title, job.stage, user);
      const prompts = buildCloudReviewPrompts({ task, job, precheck, knowledge });

      const aiRes = await callCloudProvider(configRow, apiKey, {
        ...prompts,
        stage: job.stage,
        task,
        snapshot: job.snapshot,
      });

      const parsedDraft = extractReviewDraft(aiRes.text, { allowPlainText: true }) || {
        summary: aiRes.text.slice(0, 8000),
        findings: [],
      };

      const combinedFindings = [];
      const seen = new Set();
      for (const item of [...precheck.findings, ...(parsedDraft.findings || [])]) {
        const keyStr = `${item.severity}|${item.title}|${item.location || ''}`;
        if (seen.has(keyStr)) continue;
        seen.add(keyStr);
        combinedFindings.push({
          severity: item.severity,
          title: String(item.title).slice(0, 200),
          detail: String(item.detail).slice(0, 4000),
          ...(item.location ? { location: String(item.location).slice(0, 500) } : {}),
        });
        if (combinedFindings.length >= 50) break;
      }

      const evidenceParts = [
        `执行引擎: ${configRow.name} (${configRow.provider_type === 'openai_compatible' ? configRow.model : configRow.dify_mode})`,
        precheck.checks.length ? `确定性检查: ${precheck.checks.join(', ')}` : '',
        precheck.executedPlugins.length ? `执行策略插件: ${precheck.executedPlugins.join(', ')}` : '',
        parsedDraft.evidence || '',
      ].filter(Boolean);

      const latestRaw = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
      const latestTask = user ? getTask(task.id, user) : taskRow(db.prepare('SELECT * FROM tasks WHERE id=?').get(task.id));
      if (!latestTask || !latestRaw) fail(404, 'JOB_NOT_FOUND', '评审任务不存在');
      const updatedJob = workflow.submitCloudReport(latestRaw, latestTask, actorId, {
        summary: parsedDraft.summary,
        evidence: evidenceParts.join('\n').slice(0, 8000),
        tool: `${configRow.provider_type}:${configRow.model || configRow.dify_mode}`.slice(0, 100),
        findings: combinedFindings,
      });

      let writebackResult = null;
      if (updatedJob.stage === 'CODE_REVIEW' && configRow.auto_writeback_mr === 1 && mrWriteback) {
        try {
          writebackResult = await mrWriteback.writeback({
            taskId: task.id,
            jobId: updatedJob.id,
            actorId,
            mode: 'AUTO',
          });
        } catch (err) {
          writebackResult = { skipped: true, reason: err?.message || '自动回写失败' };
        }
      }

      if (imNotifications) {
        const criticalCount = updatedJob.findings.filter(f => f.severity === 'CRITICAL' && !f.waiver).length;
        const warnCount = updatedJob.findings.filter(f => f.severity === 'WARN').length;
        const eventType = criticalCount > 0 ? 'CRITICAL_BLOCKER' : 'REPORT_SUBMITTED';
        void imNotifications.emitProjectEvent({
          projectId: task.projectId,
          eventType,
          taskId: task.id,
          jobId: updatedJob.id,
          title: `${criticalCount > 0 ? '🚨 存在阻断问题 · ' : ''}${task.jiraKey} ${updatedJob.stage} 云端 AI 评审完成`,
          markdownBody: `**任务**：${task.jiraKey} · ${task.title}\n**发现统计**：阻断 ${criticalCount} / 风险 ${warnCount} / 总计 ${updatedJob.findings.length}\n**摘要**：${updatedJob.report.summary.slice(0, 240)}`,
          rawEvent: { eventType, taskId: task.id, jobId: updatedJob.id, hasCritical: criticalCount > 0 },
        });
      }

      return { job: updatedJob, precheck, writeback: writebackResult };
    } finally {
      inFlightJobs.delete(jobId);
    }
  }

  async function handle({ method, path, user, body, send, reauthorize }) {
    const cfgMatch = path.match(/^\/api\/projects\/([^/]+)\/cloud-ai(?:\/(test))?$/);
    if (cfgMatch) {
      const [, projectId, action] = cfgMatch;
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权访问云端 AI 配置');
      projectRole(user, projectId);
      if (action === 'test') {
        if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
        requireAdminOrLead(user, projectId);
        const row = rawRow(projectId);
        if (!row) fail(409, 'CLOUD_AI_UNCONFIGURED', '请先保存云端 AI 配置');
        const result = await testConfig(row);
        audit(user.id, 'CLOUD_AI_TEST', projectId, projectId);
        send(200, result);
        return true;
      }
      if (method === 'GET') {
        send(200, { config: serializeConfig(rawRow(projectId)) });
        return true;
      }
      if (method === 'PUT') {
        requireAdminOrLead(user, projectId);
        const existing = rawRow(projectId);
        const providerType = textField(body.providerType, 'providerType', { max: 32 });
        if (!['openai_compatible', 'dify'].includes(providerType)) {
          fail(400, 'INVALID_PROVIDER', '云端 AI 类型仅支持 openai_compatible 或 dify');
        }
        const name = textField(body.name || (providerType === 'dify' ? 'Dify 工作流' : 'OpenAI 兼容模型'), 'name', { max: 100 });
        const baseUrl = validateRemoteUrl(body.baseUrl, { allowLoopbackHttp, allowQuery: false, trimTrailingSlash: true, field: 'baseUrl' });
        const model = body.model === undefined ? (existing?.model || '') : textField(body.model, 'model', { min: 0, max: 120 });
        if (providerType === 'openai_compatible' && !model) {
          fail(400, 'MODEL_REQUIRED', 'OpenAI 兼容接口请填写模型名称（如 deepseek-chat / gpt-4o）');
        }
        const difyMode = body.difyMode === undefined ? (existing?.dify_mode || 'workflow') : textField(body.difyMode, 'difyMode', { max: 20 });
        if (!['workflow', 'chat'].includes(difyMode)) fail(400, 'INVALID_INPUT', 'difyMode 仅支持 workflow 或 chat');
        const enabled = body.enabled === undefined ? true : !!body.enabled;
        const autoWritebackMr = body.autoWritebackMr === undefined ? (existing?.auto_writeback_mr === 1) : !!body.autoWritebackMr;
        const autoStages = body.autoStages === undefined
          ? (existing ? JSON.parse(existing.auto_stages || '[]') : ['PRD', 'TECH_SPEC', 'CODE_REVIEW'])
          : (Array.isArray(body.autoStages) && body.autoStages.every(s => REVIEW_STAGES.includes(s)) ? [...new Set(body.autoStages)] : fail(400, 'INVALID_STAGE', 'autoStages 包含不受支持的阶段'));
        const timeoutMs = body.timeoutMs === undefined ? (existing?.timeout_ms || 60_000) : Number(body.timeoutMs);
        if (!Number.isInteger(timeoutMs) || timeoutMs < 5000 || timeoutMs > 180_000) {
          fail(400, 'INVALID_INPUT', 'timeoutMs 须为 5000 至 180000 之间的整数');
        }

        let apiKey;
        const originChanged = existing && new URL(existing.base_url).origin !== new URL(baseUrl).origin;
        if (body.apiKey !== undefined && body.apiKey !== '') {
          apiKey = textField(body.apiKey, 'apiKey', { max: 4096, preserve: true });
          if (/[\r\n\x00]/.test(apiKey)) fail(400, 'INVALID_INPUT', 'API Key 格式不正确');
        } else if (existing && !originChanged) {
          apiKey = decryptApiKey(existing);
        } else {
          fail(400, 'API_KEY_REQUIRED', originChanged ? '修改服务地址后请重新填写 API Key' : '请填写云端 AI API Key');
        }

        const sealed = sealSecret(loadKey, [projectId, 'cloud_ai'], { apiKey });
        const now = new Date().toISOString();
        transaction(() => {
          reauthorize?.();
          requireAdminOrLead(user, projectId);
          db.prepare(`INSERT INTO cloud_ai_configs (project_id,provider_type,name,base_url,model,dify_mode,credential,enabled,auto_stages,auto_writeback_mr,timeout_ms,version,updated_by,updated_at)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,1,?,?)
            ON CONFLICT(project_id) DO UPDATE SET
              provider_type=excluded.provider_type,name=excluded.name,base_url=excluded.base_url,model=excluded.model,
              dify_mode=excluded.dify_mode,credential=excluded.credential,enabled=excluded.enabled,
              auto_stages=excluded.auto_stages,auto_writeback_mr=excluded.auto_writeback_mr,timeout_ms=excluded.timeout_ms,
              version=cloud_ai_configs.version+1,updated_by=excluded.updated_by,updated_at=excluded.updated_at,
              last_checked_at=NULL,last_error=NULL`)
            .run(projectId, providerType, name, baseUrl, model, difyMode, sealed, enabled ? 1 : 0, JSON.stringify(autoStages), autoWritebackMr ? 1 : 0, timeoutMs, user.id, now);
          audit(user.id, 'CLOUD_AI_CONFIG', projectId, projectId);
        });
        send(200, { config: serializeConfig(rawRow(projectId)) });
        return true;
      }
      fail(405, 'METHOD_NOT_ALLOWED', '不支持的请求方式');
    }

    const jobActionMatch = path.match(/^\/api\/jobs\/([^/]+)\/(precheck|cloud-execute)$/);
    if (!jobActionMatch) return false;
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
    const [, jobId, action] = jobActionMatch;
    const jobRowRaw = db.prepare('SELECT * FROM jobs WHERE id=?').get(jobId);
    if (!jobRowRaw) fail(404, 'JOB_NOT_FOUND', '评审任务不存在');
    const task = getTask(jobRowRaw.task_id, user);
    const role = projectRole(user, task.projectId);
    if (!REVIEW_ROLES[role]?.includes(jobRowRaw.stage)) {
      fail(403, 'FORBIDDEN', '当前项目角色无权执行此阶段评审检查');
    }

    if (action === 'precheck') {
      const job = workflow.jobRow(jobRowRaw, task);
      const prevMap = loadPreviousAssetsByKey(task.id, job.snapshot?.assets || []);
      const result = evaluateDeterministicPrechecks({ stage: job.stage, snapshot: job.snapshot, previousAssetsByKey: prevMap });
      send(200, result);
      return true;
    }

    if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权触发云端 AI 执行');
    const result = await executeJob({ jobId, actorId: user.id, user });
    send(200, result);
    return true;
  }

  return { getCloudExecutor, executeJob, handle };
}
