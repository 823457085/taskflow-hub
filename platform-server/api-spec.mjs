import { randomUUID } from 'node:crypto';
import { ASSET_ROLES, fail, sha, textField } from './common.mjs';
import { httpRequestRaw, validateRemoteUrl } from './crypto-http.mjs';
import { runDeterministicCodeChecks } from './code-review-engine.mjs';

const HTTP_METHODS = ['get', 'post', 'put', 'patch', 'delete', 'head', 'options'];
const WRITE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const CRITICAL_WRITE_PATH_RE = /(?:pay|refund|order|withdraw|transfer|settlement|payout|charge|cancel|submit|approve|create)/i;
const IDEMPOTENCY_NAME_RE = /(?:idempotency|request[_-]?id|trace[_-]?id|client[_-]?order[_-]?no|biz[_-]?no|nonce)/i;

function parseYamlScalar(raw) {
  const trimmed = raw.trim();
  if (!trimmed || trimmed === '~' || trimmed === 'null') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(?:\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    if (trimmed.startsWith('"')) {
      try { return JSON.parse(trimmed); } catch { return trimmed.slice(1, -1); }
    }
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  if ((trimmed.startsWith('[') && trimmed.endsWith(']')) || (trimmed.startsWith('{') && trimmed.endsWith('}'))) {
    try { return JSON.parse(trimmed); } catch { /* fallback to flow split */ }
    if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
      const inner = trimmed.slice(1, -1).trim();
      return inner ? inner.split(',').map(part => parseYamlScalar(part)) : [];
    }
  }
  return trimmed;
}

function stripYamlComment(line) {
  let quote = null;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (quote) {
      if (ch === quote && line[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '#' && (i === 0 || /\s/.test(line[i - 1]))) {
      return line.slice(0, i);
    }
  }
  return line;
}

function splitKeyVal(text) {
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (quote) {
      if (ch === quote && text[i - 1] !== '\\') quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ':' && (i === text.length - 1 || /\s/.test(text[i + 1]))) {
      const rawKey = text.slice(0, i).trim();
      const key = String(parseYamlScalar(rawKey) ?? rawKey);
      const val = text.slice(i + 1).trim();
      return { key, val };
    }
  }
  return null;
}

export function parseSimpleYaml(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const tokens = [];
  for (let i = 0; i < lines.length; i += 1) {
    const clean = stripYamlComment(lines[i]);
    if (!clean.trim() || clean.trim() === '---' || clean.trim() === '...') continue;
    const indent = clean.match(/^\s*/)[0].length;
    tokens.push({ indent, trimmed: clean.trim(), raw: clean, lineNo: i });
  }
  let idx = 0;

  function parseBlockScalar(parentIndent) {
    const collected = [];
    let blockIndent = null;
    while (idx < tokens.length) {
      const cur = tokens[idx];
      if (cur.indent <= parentIndent) break;
      if (blockIndent === null) blockIndent = cur.indent;
      collected.push(cur.raw.slice(Math.min(blockIndent, cur.raw.length)));
      idx += 1;
    }
    return collected.join('\n');
  }

  function parseNode(expectedIndent) {
    if (idx >= tokens.length) return null;
    if (tokens[idx].trimmed.startsWith('- ') || tokens[idx].trimmed === '-') {
      return parseArray(tokens[idx].indent);
    }
    return parseObject(expectedIndent);
  }

  function parseArray(arrIndent) {
    const arr = [];
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok.indent < arrIndent || !(tok.trimmed === '-' || tok.trimmed.startsWith('- '))) break;
      if (tok.indent > arrIndent) break;
      const afterDash = tok.trimmed.slice(1).trim();
      idx += 1;
      if (!afterDash) {
        if (idx < tokens.length && tokens[idx].indent > arrIndent) {
          arr.push(parseNode(tokens[idx].indent));
        } else {
          arr.push(null);
        }
        continue;
      }
      const kv = splitKeyVal(afterDash);
      if (kv) {
        const obj = {};
        const inlineIndent = tok.indent + 2;
        if (!kv.val) {
          if (idx < tokens.length && tokens[idx].indent > inlineIndent) obj[kv.key] = parseNode(tokens[idx].indent);
          else if (idx < tokens.length && tokens[idx].indent === inlineIndent && (tokens[idx].trimmed === '-' || tokens[idx].trimmed.startsWith('- '))) obj[kv.key] = parseArray(inlineIndent);
          else obj[kv.key] = null;
        } else if (kv.val === '|' || kv.val === '>') {
          obj[kv.key] = parseBlockScalar(inlineIndent);
        } else {
          obj[kv.key] = parseYamlScalar(kv.val);
        }
        while (idx < tokens.length && tokens[idx].indent >= inlineIndent && !(tokens[idx].indent === arrIndent && tokens[idx].trimmed.startsWith('-'))) {
          const nextTok = tokens[idx];
          if (nextTok.indent > inlineIndent) break;
          const nextKv = splitKeyVal(nextTok.trimmed);
          if (!nextKv) { idx += 1; continue; }
          idx += 1;
          if (!nextKv.val) {
            if (idx < tokens.length && tokens[idx].indent > nextTok.indent) obj[nextKv.key] = parseNode(tokens[idx].indent);
            else if (idx < tokens.length && tokens[idx].indent === nextTok.indent && (tokens[idx].trimmed === '-' || tokens[idx].trimmed.startsWith('- '))) obj[nextKv.key] = parseArray(nextTok.indent);
            else obj[nextKv.key] = null;
          } else if (nextKv.val === '|' || nextKv.val === '>') {
            obj[nextKv.key] = parseBlockScalar(nextTok.indent);
          } else {
            obj[nextKv.key] = parseYamlScalar(nextKv.val);
          }
        }
        arr.push(obj);
      } else {
        arr.push(parseYamlScalar(afterDash));
      }
    }
    return arr;
  }

  function parseObject(objIndent) {
    const obj = {};
    while (idx < tokens.length) {
      const tok = tokens[idx];
      if (tok.indent < objIndent || tok.trimmed.startsWith('- ') || tok.trimmed === '-') break;
      if (tok.indent > objIndent) break;
      const kv = splitKeyVal(tok.trimmed);
      if (!kv) { idx += 1; continue; }
      idx += 1;
      if (!kv.val) {
        if (idx < tokens.length && tokens[idx].indent > tok.indent) {
          obj[kv.key] = parseNode(tokens[idx].indent);
        } else if (idx < tokens.length && tokens[idx].indent === tok.indent && (tokens[idx].trimmed === '-' || tokens[idx].trimmed.startsWith('- '))) {
          obj[kv.key] = parseArray(tok.indent);
        } else {
          obj[kv.key] = null;
        }
      } else if (kv.val === '|' || kv.val === '>') {
        obj[kv.key] = parseBlockScalar(tok.indent);
      } else {
        obj[kv.key] = parseYamlScalar(kv.val);
      }
    }
    return obj;
  }

  if (!tokens.length) return null;
  return parseNode(tokens[0].indent);
}

function resolveRef(root, node, seen = new Set()) {
  if (!node || typeof node !== 'object') return node;
  if (typeof node.$ref === 'string' && node.$ref.startsWith('#/')) {
    if (seen.has(node.$ref)) return node;
    const nextSeen = new Set(seen);
    nextSeen.add(node.$ref);
    const parts = node.$ref.slice(2).split('/').map(s => s.replace(/~1/g, '/').replace(/~0/g, '~'));
    let cur = root;
    for (const part of parts) {
      if (cur && typeof cur === 'object' && Object.hasOwn(cur, part)) cur = cur[part];
      else { cur = null; break; }
    }
    if (cur && typeof cur === 'object') return resolveRef(root, cur, nextSeen);
  }
  return node;
}

function collectSchemaFields(root, rawSchema, depth = 0, seen = new Set()) {
  if (!rawSchema || typeof rawSchema !== 'object' || depth > 4) return { properties: {}, required: [] };
  const schema = resolveRef(root, rawSchema, seen);
  if (!schema || typeof schema !== 'object') return { properties: {}, required: [] };
  const properties = {};
  const required = new Set(Array.isArray(schema.required) ? schema.required.map(String) : []);
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) {
      const merged = collectSchemaFields(root, sub, depth + 1, seen);
      Object.assign(properties, merged.properties);
      for (const req of merged.required) required.add(req);
    }
  }
  if (schema.properties && typeof schema.properties === 'object') {
    for (const [key, propSchema] of Object.entries(schema.properties)) {
      const resolved = resolveRef(root, propSchema, seen) || {};
      const type = resolved.type || (resolved.properties ? 'object' : resolved.items ? 'array' : 'any');
      properties[key] = { type: String(type), required: required.has(key), description: typeof resolved.description === 'string' ? resolved.description : '' };
    }
  }
  return { properties, required: [...required] };
}

function parseApifoxDocument(doc) {
  const endpoints = [];
  const walkFolder = (items = []) => {
    for (const item of items) {
      if (!item || typeof item !== 'object') continue;
      if (Array.isArray(item.items)) walkFolder(item.items);
      const apiDef = item.api || (item.method && item.path ? item : null);
      if (!apiDef || typeof apiDef.method !== 'string' || typeof apiDef.path !== 'string') continue;
      const method = apiDef.method.toUpperCase();
      const params = [
        ...(Array.isArray(apiDef.parameters?.query) ? apiDef.parameters.query.map(p => ({ ...p, in: 'query' })) : []),
        ...(Array.isArray(apiDef.parameters?.path) ? apiDef.parameters.path.map(p => ({ ...p, in: 'path' })) : []),
        ...(Array.isArray(apiDef.parameters?.header) ? apiDef.parameters.header.map(p => ({ ...p, in: 'header' })) : []),
      ];
      const reqSchema = apiDef.requestBody?.jsonSchema || null;
      const reqFields = collectSchemaFields(doc, reqSchema);
      const responses = Array.isArray(apiDef.responses) ? apiDef.responses : [];
      const okResp = responses.find(r => Number(r.code) >= 200 && Number(r.code) < 300);
      const hasErrorResponse = responses.some(r => Number(r.code) >= 400);
      const respFields = collectSchemaFields(doc, okResp?.jsonSchema || null);
      const hasSecurity = !!(apiDef.auth && apiDef.auth.type && apiDef.auth.type !== 'noauth') || params.some(p => /auth|token/i.test(p.name || ''));
      endpoints.push({
        method,
        path: apiDef.path,
        operationId: apiDef.operationId || apiDef.id ? String(apiDef.operationId || apiDef.id) : '',
        summary: String(apiDef.name || item.name || ''),
        hasSecurity,
        hasErrorResponse,
        parameters: params.map(p => ({ name: String(p.name || ''), in: String(p.in || 'query'), required: !!p.required, type: String(p.type || 'string') })),
        requestFields: reqFields.properties,
        requestRequired: reqFields.required,
        responseFields: respFields.properties,
        hasRequestBodySchema: !!(reqSchema && (Object.keys(reqFields.properties).length > 0 || reqSchema.type)),
        hasResponseSchema: !!(okResp?.jsonSchema && (Object.keys(respFields.properties).length > 0 || okResp.jsonSchema.type)),
      });
    }
  };
  walkFolder(doc.apiCollection || []);
  return {
    format: 'apifox',
    title: String(doc.info?.name || 'Apifox 接口集合'),
    version: String(doc.info?.version || doc.schemaVersion || '1.0.0'),
    globalSecurity: false,
    endpoints,
  };
}

function parseOpenApiDocument(doc) {
  const isSwagger2 = typeof doc.swagger === 'string';
  const globalSecurity = Array.isArray(doc.security) && doc.security.length > 0;
  const endpoints = [];
  const paths = doc.paths && typeof doc.paths === 'object' ? doc.paths : {};
  for (const [pathKey, pathItem] of Object.entries(paths)) {
    if (!pathItem || typeof pathItem !== 'object') continue;
    const sharedParams = Array.isArray(pathItem.parameters) ? pathItem.parameters : [];
    for (const methodKey of HTTP_METHODS) {
      const op = pathItem[methodKey];
      if (!op || typeof op !== 'object') continue;
      const method = methodKey.toUpperCase();
      const rawParams = [...sharedParams, ...(Array.isArray(op.parameters) ? op.parameters : [])]
        .map(p => resolveRef(doc, p))
        .filter(Boolean);
      const bodyParam = isSwagger2 ? rawParams.find(p => p.in === 'body') : null;
      const params = rawParams.filter(p => p.in !== 'body').map(p => ({
        name: String(p.name || ''),
        in: String(p.in || 'query'),
        required: !!p.required || p.in === 'path',
        type: String(p.schema?.type || p.type || 'string'),
      }));
      const jsonBody = isSwagger2
        ? bodyParam?.schema
        : (op.requestBody?.content?.['application/json']?.schema || op.requestBody?.content?.['*/*']?.schema || Object.values(op.requestBody?.content || {})[0]?.schema);
      const reqFields = collectSchemaFields(doc, jsonBody);
      const responses = op.responses && typeof op.responses === 'object' ? op.responses : {};
      const responseCodes = Object.keys(responses);
      const hasErrorResponse = responseCodes.some(code => code === 'default' || /^[45]\d\d$/.test(code));
      const okCode = responseCodes.find(code => /^2\d\d$/.test(code));
      const okResp = okCode ? resolveRef(doc, responses[okCode]) : null;
      const okSchema = isSwagger2 ? okResp?.schema : (okResp?.content?.['application/json']?.schema || Object.values(okResp?.content || {})[0]?.schema);
      const respFields = collectSchemaFields(doc, okSchema);
      const hasSecurity = Array.isArray(op.security)
        ? op.security.length > 0
        : globalSecurity || params.some(p => p.in === 'header' && /authorization|token|api[-_]?key/i.test(p.name));
      endpoints.push({
        method,
        path: pathKey,
        operationId: typeof op.operationId === 'string' ? op.operationId : '',
        summary: String(op.summary || op.description || '').split(/\r?\n/)[0].slice(0, 120),
        hasSecurity,
        hasErrorResponse,
        parameters: params,
        requestFields: reqFields.properties,
        requestRequired: reqFields.required,
        responseFields: respFields.properties,
        hasRequestBodySchema: !!(jsonBody && (Object.keys(reqFields.properties).length > 0 || jsonBody.type || jsonBody.$ref)),
        hasResponseSchema: !!(okSchema && (Object.keys(respFields.properties).length > 0 || okSchema.type || okSchema.$ref)),
      });
    }
  }
  return {
    format: isSwagger2 ? 'swagger-2.0' : 'openapi-3.x',
    title: String(doc.info?.title || 'OpenAPI 接口文档'),
    version: String(doc.info?.version || '1.0.0'),
    globalSecurity,
    endpoints,
  };
}

export function tryParseApiSpecDocument(rawContent) {
  if (typeof rawContent !== 'string' || !rawContent.trim()) return null;
  let parsed = null;
  const trimmed = rawContent.trim();
  const fencedMatch = trimmed.match(/```(?:json|yaml|yml|openapi)?\s*([\s\S]*?)```/i);
  const candidate = fencedMatch?.[1]?.trim() || trimmed;
  if (candidate.startsWith('{')) {
    try { parsed = JSON.parse(candidate); } catch { parsed = null; }
  } else if (/(?:^|\n)\s*(?:openapi|swagger|apifoxProject|paths)\s*:/m.test(candidate)) {
    try { parsed = parseSimpleYaml(candidate); } catch { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  if (Array.isArray(parsed.apiCollection) || parsed.apifoxProject) return parseApifoxDocument(parsed);
  if ((typeof parsed.openapi === 'string' || typeof parsed.swagger === 'string') && parsed.paths && typeof parsed.paths === 'object') {
    return parseOpenApiDocument(parsed);
  }
  return null;
}

export function parseApiSpecDocument(rawContent) {
  const parsed = tryParseApiSpecDocument(rawContent);
  if (!parsed) fail(400, 'INVALID_API_SPEC', '未能识别有效的 OpenAPI 3.x / Swagger 2.0 / Apifox 接口文档（支持 JSON 或 YAML）');
  return parsed;
}

export function lintApiSpec(spec) {
  const findings = [];
  if (!spec.endpoints.length) {
    findings.push({
      severity: 'WARN',
      title: '接口文档未定义任何接口路径',
      detail: '未检测到 paths 或 apiCollection 接口节点，请确认文档是否完整。',
      location: 'openapi:paths',
    });
    return findings;
  }
  const seenOpIds = new Map();
  for (const ep of spec.endpoints) {
    const loc = `${ep.method} ${ep.path}`;
    if (ep.operationId) {
      if (seenOpIds.has(ep.operationId)) {
        findings.push({
          severity: 'WARN',
          title: `存在重复的 operationId: ${ep.operationId}`,
          detail: `接口 ${loc} 与 ${seenOpIds.get(ep.operationId)} 使用了相同 operationId，可能导致客户端代码生成冲突。`,
          location: loc,
        });
      } else {
        seenOpIds.set(ep.operationId, loc);
      }
    }
    if (WRITE_METHODS.has(ep.method) && !ep.hasSecurity && !/\/(?:login|auth|token|webhook|health|public)\b/i.test(ep.path)) {
      findings.push({
        severity: 'CRITICAL',
        title: `写接口 ${loc} 缺少鉴权声明`,
        detail: 'POST/PUT/PATCH/DELETE 接口未配置 security 鉴权方案，也未声明 Authorization 请求头，存在未授权访问风险。',
        location: loc,
      });
    }
    if (!ep.hasErrorResponse) {
      findings.push({
        severity: 'WARN',
        title: `接口 ${loc} 缺少 4xx/5xx 异常响应定义`,
        detail: '仅定义了正常响应码，缺少错误码与异常响应结构说明，不利于前后端联调与错误码契约对齐。',
        location: loc,
      });
    }
    if (WRITE_METHODS.has(ep.method) && CRITICAL_WRITE_PATH_RE.test(ep.path)) {
      const hasIdem = ep.parameters.some(p => IDEMPOTENCY_NAME_RE.test(p.name))
        || Object.keys(ep.requestFields).some(name => IDEMPOTENCY_NAME_RE.test(name));
      if (!hasIdem) {
        findings.push({
          severity: 'WARN',
          title: `核心写接口 ${loc} 未声明幂等标识`,
          detail: '涉及订单、支付、退款或状态提交的写操作建议显式声明 Idempotency-Key / requestId 参数以防止重试重复提交。',
          location: loc,
        });
      }
    }
    if (['POST', 'PUT', 'PATCH'].includes(ep.method) && !ep.hasRequestBodySchema && !ep.parameters.length) {
      findings.push({
        severity: 'WARN',
        title: `接口 ${loc} 缺少请求体或参数 Schema`,
        detail: '变更类接口未声明 requestBody 或 parameters 字段结构，无法校验入参类型和必填项。',
        location: loc,
      });
    }
    if (!ep.hasResponseSchema && ep.method !== 'DELETE') {
      findings.push({
        severity: 'INFO',
        title: `接口 ${loc} 缺少 2xx 响应 Schema`,
        detail: '建议补充 200/201 响应体字段结构，便于自动化契约校验与测试用例推导。',
        location: loc,
      });
    }
  }
  return findings.slice(0, 50);
}

export function diffApiSpecs(previousRawContent, nextSpec) {
  const prev = tryParseApiSpecDocument(previousRawContent);
  if (!prev) return [];
  const findings = [];
  const prevMap = new Map(prev.endpoints.map(ep => [`${ep.method} ${ep.path}`, ep]));
  const nextMap = new Map(nextSpec.endpoints.map(ep => [`${ep.method} ${ep.path}`, ep]));

  for (const [key] of prevMap) {
    if (!nextMap.has(key)) {
      findings.push({
        severity: 'CRITICAL',
        title: `破坏性变更：移除既有接口 ${key}`,
        detail: `上一版接口契约中存在 ${key}，新版本已删除该端点，可能直接导致既有调用方失败。`,
        location: key,
      });
    }
  }
  for (const [key, nextEp] of nextMap) {
    const prevEp = prevMap.get(key);
    if (!prevEp) continue;
    const prevRequired = new Set(prevEp.requestRequired);
    for (const reqField of nextEp.requestRequired) {
      if (!prevRequired.has(reqField)) {
        findings.push({
          severity: 'CRITICAL',
          title: `破坏性变更：${key} 新增必填请求字段 ${reqField}`,
          detail: `接口 ${key} 在新版本中将请求字段 ${reqField} 设为必填，旧版客户端未传该字段将被拒绝。`,
          location: `${key}#request.${reqField}`,
        });
      }
    }
    const prevReqParams = new Set(prevEp.parameters.filter(p => p.required).map(p => `${p.in}:${p.name}`));
    for (const p of nextEp.parameters) {
      if (p.required && !prevReqParams.has(`${p.in}:${p.name}`)) {
        findings.push({
          severity: 'CRITICAL',
          title: `破坏性变更：${key} 新增必填参数 ${p.name} (${p.in})`,
          detail: `原有接口参数列表新增必填 ${p.in} 参数 ${p.name}，破坏向下兼容性。`,
          location: `${key}#param.${p.name}`,
        });
      }
    }
    for (const [fieldName, prevField] of Object.entries(prevEp.responseFields)) {
      const nextField = nextEp.responseFields[fieldName];
      if (!nextField) {
        findings.push({
          severity: 'WARN',
          title: `响应兼容性风险：${key} 移除响应字段 ${fieldName}`,
          detail: `上一版本响应包含字段 ${fieldName}，当前版本已缺失，请确认无消费方依赖。`,
          location: `${key}#response.${fieldName}`,
        });
      } else if (prevField.type !== nextField.type) {
        findings.push({
          severity: 'CRITICAL',
          title: `破坏性变更：${key} 响应字段 ${fieldName} 类型变更`,
          detail: `字段 ${fieldName} 类型由 ${prevField.type} 变更为 ${nextField.type}，可能破坏反序列化。`,
          location: `${key}#response.${fieldName}`,
        });
      }
    }
  }
  return findings.slice(0, 50);
}

export function formatApiSpecAssetContent(rawContent, spec, lintFindings = [], diffFindings = []) {
  const lines = [
    `# 接口契约：${spec.title} (v${spec.version})`,
    `- 格式：\`${spec.format}\` · 端点数：${spec.endpoints.length}`,
    '',
    '## 接口清单',
    ...spec.endpoints.slice(0, 40).map(ep => {
      const reqList = ep.requestRequired.length ? ` · 必填入参: \`${ep.requestRequired.join(', ')}\`` : '';
      return `- \`${ep.method} ${ep.path}\`${ep.summary ? ` — ${ep.summary}` : ''}${ep.hasSecurity ? ' [需鉴权]' : ' [未声明鉴权]'}${reqList}`;
    }),
  ];
  const allFindings = [...diffFindings, ...lintFindings];
  if (allFindings.length) {
    lines.push('', '## 自动契约预检摘要');
    for (const item of allFindings.slice(0, 20)) {
      lines.push(`- [${item.severity}] ${item.title} (${item.location || 'spec'})`);
    }
  }
  const header = lines.join('\n');
  const trimmed = rawContent.trim();
  const fenceLang = trimmed.startsWith('{') ? 'json' : 'yaml';
  const fencedSpec = `\n\n## 原始接口规范\n\`\`\`${fenceLang}\n${trimmed}\n\`\`\``;
  if (header.length + fencedSpec.length <= 65_000) return header + fencedSpec;
  const maxRaw = Math.max(0, 65_000 - header.length - 64);
  if (maxRaw > 500) {
    return `${header}\n\n## 原始接口规范（节选）\n\`\`\`${fenceLang}\n${trimmed.slice(0, maxRaw)}\n\`\`\``;
  }
  return header.slice(0, 65_000);
}

export function createApiSpecRoutes({ db, transaction, audit, getTask, taskRole, assertWritable, workflow, allowLoopbackHttp = false }) {
  return async function handle({ method, path, user, body, send, reauthorize }) {
    const importMatch = path.match(/^\/api\/tasks\/([^/]+)\/assets\/import-api-spec$/);
    if (importMatch) {
      if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
      if (user.localDevice) fail(403, 'LOCAL_DEVICE_SCOPE', '本地设备无权拉取外部接口文档');
      const task = getTask(importMatch[1], user);
      assertWritable(task, user);
      const role = taskRole(task, user);
      if (!ASSET_ROLES.TECH_SPEC.includes(role)) fail(403, 'FORBIDDEN', '当前项目角色无权写入技术方案与接口文档');

      const logicalKey = body.logicalKey === undefined || body.logicalKey === ''
        ? 'api-contract'
        : textField(body.logicalKey, 'logicalKey', { max: 100 });
      let rawSpec = '';
      let sourceUrl = null;

      if (typeof body.content === 'string' && body.content.trim()) {
        if (body.content.length > 256_000) fail(400, 'INVALID_INPUT', '接口文档内容过长（上限 256KB）');
        rawSpec = body.content;
        if (body.sourceUrl) {
          sourceUrl = validateRemoteUrl(body.sourceUrl, { allowLoopbackHttp, allowQuery: true, trimTrailingSlash: false, field: 'sourceUrl' });
        }
      } else if (body.apifoxProjectId) {
        const apifoxProjectId = textField(String(body.apifoxProjectId), 'apifoxProjectId', { max: 64 });
        if (!/^[A-Za-z0-9_-]+$/.test(apifoxProjectId)) fail(400, 'INVALID_INPUT', 'Apifox 项目 ID 格式不正确');
        const apifoxToken = textField(body.apifoxToken, 'apifoxToken', { max: 1024, preserve: true });
        const apifoxBase = body.apifoxBaseUrl
          ? validateRemoteUrl(body.apifoxBaseUrl, { allowLoopbackHttp, allowQuery: false, trimTrailingSlash: true, field: 'apifoxBaseUrl' })
          : 'https://api.apifox.com';
        const exportUrl = `${apifoxBase}/v1/projects/${encodeURIComponent(apifoxProjectId)}/export-openapi?locale=zh-CN`;
        const res = await httpRequestRaw(exportUrl, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apifoxToken}`,
            'X-Apifox-Api-Version': '2024-03-28',
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
          body: { scope: { type: 'ALL' }, oasVersion: '3.1', exportFormat: 'JSON' },
          timeoutMs: 20_000,
          secrets: [apifoxToken],
        });
        if (res.status < 200 || res.status >= 300) {
          fail(502, 'APIFOX_IMPORT_FAILED', `Apifox 导出失败（HTTP ${res.status}）`);
        }
        rawSpec = res.text;
        sourceUrl = `${apifoxBase}/projects/${encodeURIComponent(apifoxProjectId)}`;
      } else if (body.sourceUrl) {
        sourceUrl = validateRemoteUrl(body.sourceUrl, { allowLoopbackHttp, allowQuery: true, trimTrailingSlash: false, field: 'sourceUrl' });
        const headers = { Accept: 'application/json, application/yaml, text/yaml, text/plain' };
        const secrets = [];
        if (body.token) {
          const tok = textField(body.token, 'token', { max: 1024, preserve: true });
          headers.Authorization = `Bearer ${tok}`;
          secrets.push(tok);
        }
        const res = await httpRequestRaw(sourceUrl, { method: 'GET', headers, timeoutMs: 20_000, secrets });
        if (res.status < 200 || res.status >= 300) {
          fail(502, 'REMOTE_REQUEST_FAILED', `拉取接口文档失败（HTTP ${res.status}）`);
        }
        rawSpec = res.text;
      } else {
        fail(400, 'INVALID_INPUT', '请粘贴 OpenAPI / Swagger / Apifox 文档内容，或提供文档链接 / Apifox 项目配置');
      }

      const spec = parseApiSpecDocument(rawSpec);
      const lintFindings = lintApiSpec(spec);
      const prevRow = db.prepare('SELECT * FROM assets WHERE task_id=? AND kind=? AND logical_key=? ORDER BY revision DESC LIMIT 1')
        .get(task.id, 'TECH_SPEC', logicalKey);
      const diffFindings = prevRow ? diffApiSpecs(prevRow.content, spec) : [];
      const findings = [...diffFindings, ...lintFindings].slice(0, 50);

      const title = body.title && String(body.title).trim()
        ? textField(body.title, 'title', { max: 200, preserve: true })
        : `接口契约 · ${spec.title} (v${spec.version})`.slice(0, 200);
      const formatted = formatApiSpecAssetContent(rawSpec, spec, lintFindings, diffFindings);
      const id = randomUUID();
      const now = new Date().toISOString();

      reauthorize?.();
      transaction(() => {
        assertWritable(getTask(task.id, user), user);
        const revision = db.prepare('SELECT COALESCE(MAX(revision),0)+1 AS revision FROM assets WHERE task_id=? AND kind=? AND logical_key=?')
          .get(task.id, 'TECH_SPEC', logicalKey).revision;
        db.prepare('INSERT INTO assets VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
          .run(id, task.id, task.projectId, 'TECH_SPEC', logicalKey, title, formatted, sourceUrl, revision, sha(formatted), user.id, now);
        db.prepare('UPDATE tasks SET version=version+1,updated_at=? WHERE id=?').run(now, task.id);
        audit(user.id, 'API_SPEC_IMPORT', id, task.projectId);
      });

      const asset = workflow.assetsFor(task.id).find(item => item.id === id);
      send(201, {
        asset,
        specSummary: {
          format: spec.format,
          title: spec.title,
          version: spec.version,
          endpointCount: spec.endpoints.length,
          endpoints: spec.endpoints.slice(0, 30).map(ep => ({
            method: ep.method,
            path: ep.path,
            summary: ep.summary,
            hasSecurity: ep.hasSecurity,
            hasErrorResponse: ep.hasErrorResponse,
          })),
        },
        findings,
      });
      return true;
    }

    const analyzeMatch = path.match(/^\/api\/tasks\/([^/]+)\/assets\/([^/]+)\/analyze-contract$/);
    if (!analyzeMatch) return false;
    if (method !== 'POST') fail(405, 'METHOD_NOT_ALLOWED', '仅支持 POST');
    const [, taskId, assetId] = analyzeMatch;
    const task = getTask(taskId, user);
    const asset = workflow.assetsFor(task.id).find(item => item.id === assetId);
    if (!asset) fail(404, 'ASSET_NOT_FOUND', '资产版本不存在');

    const spec = tryParseApiSpecDocument(asset.content);
    if (spec) {
      const prevRow = db.prepare('SELECT * FROM assets WHERE task_id=? AND kind=? AND logical_key=? AND revision<? ORDER BY revision DESC LIMIT 1')
        .get(task.id, asset.kind, asset.logicalKey, asset.revision);
      const lintFindings = lintApiSpec(spec);
      const diffFindings = prevRow ? diffApiSpecs(prevRow.content, spec) : [];
      send(200, {
        kind: 'API_SPEC',
        specSummary: {
          format: spec.format,
          title: spec.title,
          version: spec.version,
          endpointCount: spec.endpoints.length,
        },
        findings: [...diffFindings, ...lintFindings].slice(0, 50),
      });
      return true;
    }

    if (asset.kind === 'CODE') {
      send(200, {
        kind: 'CODE_SCAN',
        findings: runDeterministicCodeChecks([asset]),
      });
      return true;
    }

    fail(400, 'INVALID_API_SPEC', '该材料既不是 OpenAPI/Swagger/Apifox 接口契约，也不是代码差异');
  };
}
