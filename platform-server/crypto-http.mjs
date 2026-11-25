import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { dirname, resolve } from 'node:path';
import { ApiError, fail, textField } from './common.mjs';

const MAX_REMOTE_BYTES = 4 * 1024 * 1024;
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

export function createKeyLoader(dbPath, injectedKey) {
  let encryptionKey = injectedKey;
  return function loadKey() {
    if (encryptionKey) {
      if (!Buffer.isBuffer(encryptionKey) || encryptionKey.length !== 32) {
        fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用');
      }
      return encryptionKey;
    }
    if (dbPath === ':memory:') {
      encryptionKey = randomBytes(32);
      return encryptionKey;
    }
    const keyPath = resolve(dirname(dbPath), 'connectors.key');
    mkdirSync(dirname(keyPath), { recursive: true, mode: 0o700 });
    if (!existsSync(keyPath)) {
      try {
        writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
      } catch (error) {
        if (error.code !== 'EEXIST') throw error;
      }
    }
    chmodSync(keyPath, 0o600);
    encryptionKey = readFileSync(keyPath);
    if (encryptionKey.length !== 32) fail(500, 'CONNECTOR_KEY_INVALID', '本机连接密钥不可用');
    return encryptionKey;
  };
}

export function sealSecret(loadKey, aadParts, value) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', loadKey(), iv);
  cipher.setAAD(Buffer.from(JSON.stringify(aadParts)));
  const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
  return JSON.stringify({
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: data.toString('base64'),
  });
}

export function unsealSecret(loadKey, aadParts, sealedText, errorMessage = '配置凭据无法读取，请由负责人重新保存') {
  try {
    const parsed = JSON.parse(sealedText);
    if (parsed?.v !== 1) throw new Error('bad version');
    const cipher = createDecipheriv('aes-256-gcm', loadKey(), Buffer.from(parsed.iv, 'base64'));
    cipher.setAAD(Buffer.from(JSON.stringify(aadParts)));
    cipher.setAuthTag(Buffer.from(parsed.tag, 'base64'));
    return JSON.parse(Buffer.concat([cipher.update(Buffer.from(parsed.data, 'base64')), cipher.final()]).toString('utf8'));
  } catch {
    fail(500, 'CREDENTIAL_UNAVAILABLE', errorMessage);
  }
}

export function validateRemoteUrl(raw, { allowLoopbackHttp = false, allowQuery = false, trimTrailingSlash = true, field = 'baseUrl' } = {}) {
  const text = textField(raw, field, { max: 2000 });
  let url;
  try {
    url = new URL(text);
  } catch {
    fail(400, 'INVALID_URL', '请输入有效的 HTTPS 服务地址');
  }
  const loopback = LOOPBACK_HOSTS.has(url.hostname);
  const protocolOk = url.protocol === 'https:' || (allowLoopbackHttp && url.protocol === 'http:' && loopback);
  if (!protocolOk || url.username || url.password || url.hash || (!allowQuery && url.search) || /[\\\x00-\x20\x7f]/.test(text)) {
    fail(400, 'INVALID_URL', allowQuery ? '服务地址需为 HTTPS 且不含认证信息或片段' : '服务地址需为 HTTPS 且不含认证信息、参数或片段');
  }
  return trimTrailingSlash ? url.href.replace(/\/$/, '') : url.href;
}

export function redactText(input, secrets = []) {
  let out = String(input ?? '');
  for (const secret of secrets) {
    if (!secret || typeof secret !== 'string' || secret.length < 3) continue;
    out = out.split(secret).join('[凭据已隐藏]');
    const encoded = encodeURIComponent(secret);
    if (encoded !== secret) out = out.split(encoded).join('[凭据已隐藏]');
  }
  return out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi, '$1 [凭据已隐藏]').slice(0, 2000);
}

export function maskUrlPreview(rawUrl) {
  try {
    const parsed = new URL(rawUrl);
    const tail = parsed.pathname.length > 16 ? `...${parsed.pathname.slice(-8)}` : parsed.pathname;
    return `${parsed.origin}${tail}${parsed.search ? '?***' : ''}`;
  } catch {
    return '***';
  }
}

export function httpRequestRaw(targetUrl, { method = 'GET', headers = {}, body = undefined, timeoutMs = 30_000, maxBytes = MAX_REMOTE_BYTES, secrets = [] } = {}) {
  const url = typeof targetUrl === 'string' ? new URL(targetUrl) : targetUrl;
  const payload = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
  const finalHeaders = { ...headers };
  if (payload !== undefined && !Object.keys(finalHeaders).some(k => k.toLowerCase() === 'content-length')) {
    finalHeaders['Content-Length'] = Buffer.byteLength(payload);
  }
  return new Promise((resolveResult, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, { method, headers: finalHeaders, agent: false, timeout: timeoutMs }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        reject(new ApiError(502, 'REMOTE_REDIRECT', '远端发生重定向，未向新地址发送凭据'));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on('data', chunk => {
        size += chunk.length;
        if (size > maxBytes) {
          req.destroy();
          reject(new ApiError(502, 'REMOTE_RESPONSE_TOO_LARGE', '远端返回内容超过大小限制'));
        } else {
          chunks.push(chunk);
        }
      });
      res.on('error', () => reject(new ApiError(502, 'REMOTE_CONNECTION_FAILED', '远端连接中断')));
      res.on('end', () => {
        resolveResult({
          status: res.statusCode || 0,
          headers: res.headers,
          bodyBuffer: Buffer.concat(chunks),
          text: Buffer.concat(chunks).toString('utf8'),
        });
      });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(new ApiError(504, 'REMOTE_TIMEOUT', '远端请求超时'));
    });
    req.on('error', err => {
      reject(new ApiError(502, 'REMOTE_CONNECTION_FAILED', redactText(`无法连接远端服务：${err.message || '网络错误'}`, secrets)));
    });
    req.end(payload);
  });
}
