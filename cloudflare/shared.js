/**
 * 小暖 · 边缘共享层
 * 安全边界只写一次：白名单、限流、同源、令牌、SSRF、响应头。
 * worker.js 与 iterate.js 都从这里取，避免"只改了一边"。
 */

export const ALLOWED_HOSTS = [
  'api.deepseek.com',
  'api.moonshot.cn',
  'api.openai.com',
  'open.bigmodel.cn',
  'api.siliconflow.cn'
];

const HOST_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(\.(?!-)[a-z0-9-]{1,63})+$/i;

export function extraHosts(env) {
  const raw = String((env && env.XN_EXTRA_HOSTS) || '');
  const list = raw.split(',').map((x) => x.trim().toLowerCase()).filter(Boolean);
  if (list.length > 8) return list.slice(0, 8);
  return list.filter((h) => HOST_RE.test(h) && !isPrivateHost(h));
}

export function safeBase(raw, fallback, env) {
  try {
    const u = new URL(String(raw));
    if (u.protocol !== 'https:') return fallback;
    const ok = ALLOWED_HOSTS.concat(extraHosts(env));
    if (ok.indexOf(u.hostname.toLowerCase()) < 0) return fallback;
    return (u.origin + u.pathname).replace(/\/+$/, '');
  } catch (e) {
    return fallback;
  }
}

/* ---------- IP / 主机判定 ---------- */

function ipv4Parts(host) {
  const parts = String(host).split('.');
  if (parts.length < 1 || parts.length > 4) return null;
  const nums = [];
  for (const p of parts) {
    if (!/^(0x[0-9a-f]+|\d+)$/i.test(p)) return null;
    const n = /^0x/i.test(p) ? parseInt(p, 16) : parseInt(p, 10);
    if (!isFinite(n) || n < 0) return null;
    nums.push(n);
  }
  /* 支持 inet_aton 的缩写形式：127.1 / 10.1 / 0x7f000001 */
  if (nums.length === 1) {
    if (nums[0] > 0xffffffff) return null;
    const n = nums[0];
    return [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  }
  if (nums.length === 2) {
    if (nums[0] > 255 || nums[1] > 0xffffff) return null;
    return [nums[0], (nums[1] >>> 16) & 255, (nums[1] >>> 8) & 255, nums[1] & 255];
  }
  if (nums.length === 3) {
    if (nums[0] > 255 || nums[1] > 255 || nums[2] > 0xffff) return null;
    return [nums[0], nums[1], (nums[2] >>> 8) & 255, nums[2] & 255];
  }
  if (nums.some((n) => n > 255)) return null;
  return nums;
}

function isPrivateV4(p) {
  const [a, b] = p;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

export function isPrivateHost(rawHost) {
  let host = String(rawHost || '').trim().toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host.charAt(0) === '[' && host.charAt(host.length - 1) === ']') host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
      host.endsWith('.internal') || host === 'metadata.google.internal' || host === 'metadata') {
    return true;
  }

  /* 纯十进制 / 十六进制整数形式的 IPv4 */
  if (/^\d+$/.test(host)) {
    const n = Number(host);
    if (n >= 0 && n <= 0xffffffff) {
      return isPrivateV4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    }
  }
  if (/^0x[0-9a-f]+$/i.test(host)) {
    const n = parseInt(host, 16);
    if (isFinite(n) && n >= 0 && n <= 0xffffffff) {
      return isPrivateV4([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
    }
  }

  const v4 = ipv4Parts(host);
  if (v4) return isPrivateV4(v4);

  /* IPv6：::1、fc00::/7、fe80::/10、IPv4 映射地址 */
  if (host.indexOf(':') >= 0) {
    const h = host.replace(/%.*$/, '');
    if (h === '::' || h === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(h)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
    const mapped = h.match(/::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
    if (mapped) return isPrivateHost(mapped[1]);
    if (/^64:ff9b::/i.test(h)) return true;
  }
  return false;
}

/* DoH 解析 + 校验，挡住 DNS 重绑定。失败时默认拒绝（fail closed）。 */
const dnsCache = new Map();

async function resolvePublic(host) {
  if (isPrivateHost(host)) return false;
  if (/^[\d.]+$/.test(host) || host.indexOf(':') >= 0) {
    return !isPrivateHost(host);
  }
  const cached = dnsCache.get(host);
  if (cached && Date.now() - cached.at < 300000) return cached.ok;

  let ok = false;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 2500);
    const res = await fetch('https://cloudflare-dns.com/dns-query?name=' + encodeURIComponent(host) + '&type=A', {
      headers: { accept: 'application/dns-json' },
      signal: ctrl.signal,
      redirect: 'error'
    });
    clearTimeout(timer);
    if (res.ok) {
      const j = await res.json();
      const answers = (j.Answer || []).filter((a) => a.type === 1).map((a) => a.data);
      ok = answers.length > 0 && answers.every((ip) => !isPrivateHost(ip));
    }
  } catch (e) {
    ok = false;
  }
  dnsCache.set(host, { ok, at: Date.now() });
  if (dnsCache.size > 500) {
    const first = dnsCache.keys().next().value;
    dnsCache.delete(first);
  }
  return ok;
}

export async function assertPublicUrl(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (e) { throw new Error('url 不对'); }
  if (u.protocol !== 'https:' && u.protocol !== 'http:') throw new Error('只支持 http(s)');
  if (u.username || u.password) throw new Error('不允许带账号密码的 URL');
  if (isPrivateHost(u.hostname)) throw new Error('不给内网地址');
  if (!(await resolvePublic(u.hostname))) throw new Error('这个域名解析到内网或解析失败，已拒绝');
  return u;
}

/* 手动跟随重定向，每一跳都重新校验，避免 302 到 127.0.0.1 */
export async function safeFetch(raw, init = {}) {
  let current = String(raw);
  for (let hop = 0; hop < 4; hop++) {
    const u = await assertPublicUrl(current);
    const res = await fetch(u.toString(), Object.assign({}, init, { redirect: 'manual' }));
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) return { res, url: u.toString() };
      current = new URL(loc, u).toString();
      continue;
    }
    return { res, url: u.toString() };
  }
  throw new Error('重定向次数太多');
}

/* ---------- 令牌 ---------- */

function bytesToB64url(bytes) {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
function strToB64url(str) {
  return bytesToB64url(new TextEncoder().encode(str));
}
function b64urlToStr(s) {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4);
  const bin = atob(pad);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

async function hmac(secret, data) {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(data));
  return bytesToB64url(new Uint8Array(sig));
}

export function constantTimeEqual(a, b) {
  const x = String(a == null ? '' : a);
  const y = String(b == null ? '' : b);
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) {
    diff |= (x.charCodeAt(i) || 0) ^ (y.charCodeAt(i) || 0);
  }
  return diff === 0;
}

export async function issueToken(env, ttlSec = 43200) {
  const secret = env.XN_ADMIN_SECRET || env.XN_ADMIN_PASSWORD;
  if (!secret) throw new Error('no secret');
  const payload = strToB64url(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + ttlSec,
    iat: Math.floor(Date.now() / 1000),
    scope: 'admin'
  }));
  return payload + '.' + await hmac(secret, payload);
}

export async function verifyToken(env, token) {
  const secret = env.XN_ADMIN_SECRET || env.XN_ADMIN_PASSWORD;
  if (!secret || !token) return false;
  const parts = String(token).split('.');
  if (parts.length !== 2) return false;
  const expect = await hmac(secret, parts[0]);
  if (!constantTimeEqual(expect, parts[1])) return false;
  try {
    const payload = JSON.parse(b64urlToStr(parts[0]));
    return payload.scope === 'admin' && payload.exp * 1000 > Date.now();
  } catch (e) {
    return false;
  }
}

export function bearer(request) {
  const h = request.headers.get('Authorization') || '';
  if (h) return h.replace(/^Bearer\s+/i, '').trim();
  return request.headers.get('X-Admin-Token') || '';
}

/* ---------- 请求辅助 ---------- */

export function clientIp(request) {
  return request.headers.get('CF-Connecting-IP') || '0.0.0.0';
}

export function sameOrigin(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return true; /* curl / 原生客户端；管理接口还有令牌 */
  const url = new URL(request.url);
  if (origin === url.origin) return true;
  const allowed = String((env && env.XN_ALLOWED_ORIGINS) || '')
    .split(',').map((x) => x.trim()).filter(Boolean);
  return allowed.indexOf(origin) >= 0;
}

export function corsHeaders(request, env) {
  const origin = request.headers.get('Origin');
  if (!origin) return {};
  if (!sameOrigin(request, env)) return {};
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Admin-Token',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    'Vary': 'Origin'
  };
}

export const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' https: http://127.0.0.1:* http://localhost:*; frame-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'"
};

const memRate = new Map();

/* useKv=true 时用 KV 计数，适合迭代这种低频高价值接口；聊天走内存，省 KV 写。 */
export async function rateLimit(env, bucket, id, limit, windowSec, useKv) {
  const win = Math.floor(Date.now() / 1000 / windowSec);
  const key = bucket + ':' + id + ':' + win;

  if (useKv && env.XN_KV) {
    try {
      const n = Number(await env.XN_KV.get('rl:' + key)) || 0;
      const next = n + 1;
      await env.XN_KV.put('rl:' + key, String(next), { expirationTtl: Math.max(60, windowSec + 30) });
      return { ok: next <= limit, remaining: Math.max(0, limit - next) };
    } catch (e) { /* KV 出错就退回内存 */ }
  }

  const next = (memRate.get(key) || 0) + 1;
  memRate.set(key, next);
  if (memRate.size > 4000) {
    for (const k of memRate.keys()) {
      if (!k.endsWith(':' + win)) memRate.delete(k);
    }
  }
  return { ok: next <= limit, remaining: Math.max(0, limit - next) };
}

export async function readJson(request, maxBytes = 262144) {
  const len = Number(request.headers.get('content-length') || 0);
  if (len > maxBytes) throw Object.assign(new Error('请求体太大'), { status: 413 });
  let text;
  try { text = await request.text(); } catch (e) { throw Object.assign(new Error('读不到请求体'), { status: 400 }); }
  if (text.length > maxBytes) throw Object.assign(new Error('请求体太大'), { status: 413 });
  try { return JSON.parse(text || '{}'); }
  catch (e) { throw Object.assign(new Error('请求体不是 JSON'), { status: 400 }); }
}

/* ---------- 版本 ---------- */

export function parseVersion(v) {
  const m = String(v || '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

export function cmpVersion(a, b) {
  const A = parseVersion(a) || [0, 0, 0];
  const B = parseVersion(b) || [0, 0, 0];
  for (let i = 0; i < 3; i++) if (A[i] !== B[i]) return A[i] - B[i];
  return 0;
}

export function bumpVersion(cur, type) {
  const p = parseVersion(cur) || [1, 0, 0];
  if (type === 'major') return (p[0] + 1) + '.0.0';
  if (type === 'minor') return p[0] + '.' + (p[1] + 1) + '.0';
  return p[0] + '.' + p[1] + '.' + (p[2] + 1);
}

/* ---------- base64（GitHub 内容 API） ---------- */

export function b64encode(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function b64decode(b64) {
  const bin = atob(String(b64 || '').replace(/\s/g, ''));
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}
