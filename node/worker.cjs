const readline = require('node:readline');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');
const zlib = require('node:zlib');
const { execFileSync } = require('node:child_process');

const DEFAULT_BASE = (process.env.MAGPIE_BASE_URL || 'http://127.0.0.1:3425').replace(/\/+$/, '');
const GATEWAYS_FILE = process.env.MAGPIE_GATEWAYS_FILE ||
  path.join(os.homedir(), '.config', 'magpie', 'gateways.json');
const APP_DIR = process.env.CINDY_APP_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'CindyGlobal');
const TTL_MS = 10_000;
const ROUTING_DIR = process.env.MAGPIE_ROUTING_DIR ||
  path.join(os.homedir(), '.config', 'magpie', 'routing');
const ROUTING_FILE = process.env.MAGPIE_ROUTING_FILE || null;
const ROUTE_TTL_MS = 10_000;
let cache = null;
let inflight = null;
let gatewaysCache = null;
let routeCache = null;
let owners = null;

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function normalizeBase(v) {
  try {
    const u = new URL(String(v));
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return u.toString().replace(/\/+$/, '');
  } catch { return null; }
}

/** 多网关配置：~/.config/magpie/gateways.json（不存在或损坏时退回单机本机）。 */
function loadGateways() {
  if (gatewaysCache && Date.now() - gatewaysCache.at < 30_000) return gatewaysCache.list;
  let list = [{ id: 'local', label: '本机 Magpie', base: DEFAULT_BASE, providerIds: [], deviceIds: [], headers: {} }];
  try {
    const raw = JSON.parse(fs.readFileSync(GATEWAYS_FILE, 'utf8'));
    const parsed = (Array.isArray(raw.gateways) ? raw.gateways : []).map((g) => {
      const base = g && normalizeBase(g.base);
      if (!base) return null;
      return {
        id: String(g.id || base),
        label: String(g.label || g.id || base),
        base,
        providerIds: (Array.isArray(g.providerIds) ? g.providerIds : []).map(String),
        deviceIds: (Array.isArray(g.deviceIds) ? g.deviceIds : []).map(String),
        headers: (g.headers && typeof g.headers === 'object' && !Array.isArray(g.headers)) ? g.headers : {}
      };
    }).filter(Boolean);
    if (parsed.length) list = parsed;
  } catch { /* 无配置：保持单机 */ }
  gatewaysCache = { at: Date.now(), list };
  return list;
}

function getJson(base, pathname, headers) {
  return new Promise((resolve, reject) => {
    const url = new URL(base + pathname);
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.get(url, {
      headers: Object.assign({ Accept: 'application/json' }, headers || {}),
      timeout: 5000
    }, (res) => {
      if (res.statusCode < 200 || res.statusCode >= 300) {
        res.resume();
        return reject(new Error('HTTP ' + res.statusCode));
      }
      let raw = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { raw += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (e) { reject(e); }
      });
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('请求超时')); });
    req.on('error', reject);
  });
}

function localDateKey(date) {
  const d = date || new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function todayRoutingFile() {
  if (ROUTING_FILE) return ROUTING_FILE;
  return path.join(ROUTING_DIR, localDateKey() + '.jsonl');
}

function yesterdayRoutingFile() {
  if (ROUTING_FILE) return null;
  const d = new Date();
  d.setDate(d.getDate() - 1);
  return path.join(ROUTING_DIR, localDateKey(d) + '.jsonl.gz');
}

function readRoutingText(file) {
  const raw = fs.readFileSync(file);
  return /\.gz$/i.test(file) ? zlib.gunzipSync(raw).toString('utf8') : raw.toString('utf8');
}

function parseRoutingLines(text) {
  const out = [];
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === 'object') out.push(value);
    } catch { /* 写入中的最后一行可能不完整 */ }
  }
  return out;
}

function routeTry(entry) {
  const tries = Array.isArray(entry.tries) ? entry.tries : [];
  return tries.find((t) => t && t.done && t.status >= 200 && t.status < 300) ||
    tries.find((t) => t && t.status >= 200 && t.status < 300) ||
    tries[tries.length - 1] || null;
}

function routeOrder(entry, attempt) {
  const order = Array.isArray(entry.order) ? entry.order : [];
  if (!attempt) return null;
  const id = String(attempt.id || '');
  let hit = order.find((o) => o && String(o.id) === id);
  if (!hit && id.includes('@')) {
    const at = id.indexOf('@');
    const provider = id.slice(0, at);
    const who = id.slice(at + 1);
    hit = order.find((o) => o && String(o.provider) === provider && String(o.who) === who);
  }
  if (!hit && !id.includes('@')) {
    const provider = String(entry.provider || id);
    const same = order.filter((o) => o && String(o.provider) === provider);
    if (same.length === 1) hit = same[0];
  }
  return hit || null;
}

function summarizeRoute(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const tries = Array.isArray(entry.tries) ? entry.tries : [];
  const attempt = routeTry(entry);
  const order = routeOrder(entry, attempt);
  const group = entry.group && typeof entry.group === 'object' ? {
    name: entry.group.name ? String(entry.group.name) : null
  } : null;
  const rule = entry.rule && typeof entry.rule === 'object' ? {
    use: entry.rule.use ? String(entry.rule.use) : null
  } : null;
  return {
    time: entry.time ? String(entry.time) : null,
    session: entry.session ? String(entry.session) : null,
    model: entry.model ? String(entry.model) : null,
    provider: entry.provider ? String(entry.provider) : (attempt && attempt.id ? String(attempt.id).split('@')[0] : null),
    group,
    rule,
    account: order && order.who ? String(order.who) : null,
    providerName: order && order.name ? String(order.name) : null,
    plan: order && order.plan ? String(order.plan) : null,
    used: order && typeof order.used === 'number' ? order.used : null,
    usedRenews: order && (order.usedRenews || order.due) ? String(order.usedRenews || order.due) : null,
    usedWindow: order && order.usedWindow ? String(order.usedWindow) : null,
    served: attempt && attempt.served ? String(attempt.served) : (entry.served ? String(entry.served) : null),
    status: typeof entry.status === 'number' ? entry.status : null,
    fallbackCount: Math.max(0, tries.length - 1)
  };
}

/** Magpie 路由日志：今天写 JSONL，昨天起是 gzip；按 session（Cindy 的 sdk_session_id）取最后一条。 */
function loadRouteIndex() {
  const file = todayRoutingFile();
  let stat = null;
  try { stat = fs.statSync(file); } catch { /* 今天还没有请求 */ }
  const hasToday = stat && stat.size > 0;
  const target = hasToday ? file : yesterdayRoutingFile();
  if (!target) {
    return { entries: new Map(), latest: null };
  }
  let targetStat = hasToday ? stat : null;
  if (!hasToday) {
    try { targetStat = fs.statSync(target); } catch { targetStat = null; }
  }
  if (routeCache && routeCache.file === target && routeCache.mtimeMs === (targetStat && targetStat.mtimeMs) &&
      routeCache.size === (targetStat && targetStat.size) &&
      Date.now() - routeCache.at < ROUTE_TTL_MS) {
    return routeCache.value;
  }
  const value = { entries: new Map(), latest: null };
  try {
    for (const entry of parseRoutingLines(readRoutingText(target))) {
      const summary = summarizeRoute(entry);
      if (!summary) continue;
      if (!entry.agent || String(entry.agent) === 'cindy') value.latest = summary;
      if (summary.session) value.entries.set(summary.session, summary);
    }
  } catch { /* 读取失败时按没有路由处理，胶囊回退到 provider 最近账号 */ }
  routeCache = {
    file: target,
    mtimeMs: targetStat && targetStat.mtimeMs,
    size: targetStat && targetStat.size,
    at: Date.now(),
    value
  };
  return value;
}

const LINK_ROWS = new Set(['代理出口', '管理页', '代理', '管理', '出口']);
function isQuotaWindow(w) {
  return !!w && !w.text && typeof w.name === 'string' && !LINK_ROWS.has(w.name.trim()) &&
    !(typeof w.display === 'string' && /^https?:\/\//i.test(w.display.trim()));
}

function mapQuotaBody(body, gateway) {
  return (Array.isArray(body.data) ? body.data : [])
    .filter((e) => e && typeof e.provider === 'string')
    .map((e) => ({
      provider: e.provider,
      name: e.name || e.provider,
      plan: e.plan || null,
      user: e.user || '',
      error: e.error || null,
      balance: e.balance || null,
      readAt: e.readAt || null,
      last: !!e.last,
      lastServedAt: e.lastServedAt || null,
      until: e.until || null,
      gatewayId: gateway.id,
      gatewayLabel: gateway.label,
      // 代理/管理页链接行不是额度
      windows: (e.windows || [])
        .filter(isQuotaWindow)
        .map((w) => ({
          name: w.name,
          used: typeof w.used === 'number' ? w.used : null,
          remaining: typeof w.remaining === 'number' ? w.remaining : null,
          resetsAt: w.resetsAt || null,
          display: w.display || null
        }))
    }));
}

async function queryGateway(gateway, pathname) {
  try {
    return { ok: true, gateway, body: await getJson(gateway.base, pathname, gateway.headers) };
  } catch (err) {
    return { ok: false, gateway, error: String((err && err.message) || err) };
  }
}

async function loadQuotas(force) {
  if (!force && cache && Date.now() - cache.at < TTL_MS) return cache.value;
  if (inflight) return inflight;
  inflight = (async () => {
    const gateways = loadGateways();
    const results = await Promise.all(gateways.map((g) => queryGateway(g, '/v1/magpie/quotas')));
    const entries = results.flatMap((r) => r.ok ? mapQuotaBody(r.body, r.gateway) : []);
    const gatewayErrors = results.filter((r) => !r.ok).map((r) => ({
      gatewayId: r.gateway.id, label: r.gateway.label, error: r.error
    }));
    const ok = results.some((r) => r.ok);
    const routes = loadRouteIndex();
    const value = {
      ok,
      error: ok ? null : '无法连接任何 Magpie 网关',
      entries,
      gateways: gateways.map((g) => ({ id: g.id, label: g.label })),
      gatewayErrors,
      latestRoute: routes.latest,
      updatedAt: new Date().toISOString()
    };
    if (ok) cache = { at: Date.now(), value };
    return value;
  })().finally(() => { inflight = null; });
  return inflight;
}

// ---- 会话 → 模型 → provider → 网关 ----
async function loadOwners() {
  if (owners && Date.now() - owners.at < 5 * 60_000) return owners.map;
  const map = {};
  const results = await Promise.all(loadGateways().map((g) => queryGateway(g, '/v1/models')));
  for (const r of results) {
    if (!r.ok) continue;
    for (const m of (r.body && Array.isArray(r.body.data) ? r.body.data : [])) {
      if (m && m.id && m.owned_by) map[m.id] = m.owned_by;
    }
  }
  owners = { at: Date.now(), map };
  return map;
}

/** Cindy 本机数据库 sessions 表（只读）：会话当前的模型、引擎、连接与执行设备。 */
function lookupSession(id) {
  if (!id || !/^[0-9a-zA-Z-]{8,64}$/.test(id)) return null;
  let files = [];
  try {
    files = fs.readdirSync(APP_DIR).filter((f) => /^cindy-.*\.db$/.test(f));
  } catch { return null; }
  for (const f of files) {
    try {
      const out = execFileSync('/usr/bin/sqlite3', ['-readonly', '-json', path.join(APP_DIR, f),
        `select model, agent_kind as kind, provider_id, agent_device_id, sdk_session_id
           from sessions where id='${id}'`],
      { timeout: 3000, encoding: 'utf8' });
      const rows = out.trim() ? JSON.parse(out) : [];
      if (rows[0]) return rows[0];
    } catch { /* 下一个库 */ }
  }
  return null;
}

/** Cindy 会话模型 ID → Magpie provider。兼容 magpie-<连接>/<provider>/<model> 与 <provider>/<model>。 */
function resolveProvider(model, known, map) {
  const raw = String(model || '').trim();
  if (!raw) return null;
  const parts = raw.split('/').filter(Boolean);
  if (/^magpie(?:[-_].+)?$/i.test(parts[0] || '')) parts.shift();
  const ownerOf = (id) => {
    const o = map[id];
    return o && known.has(String(o).toLowerCase()) ? String(o).toLowerCase() : null;
  };
  const first = (parts[0] || '').toLowerCase();
  if (known.has(first)) return first;
  const exact = ownerOf(raw) || ownerOf(parts.join('/'));
  if (exact) return exact;
  const name = parts[parts.length - 1];
  if (name) {
    const found = new Set(Object.keys(map)
      .filter((id) => id === name || id.endsWith('/' + name))
      .map(ownerOf)
      .filter(Boolean));
    if (found.size === 1) return [...found][0];
  }
  return null;
}

/** 会话的 provider_id / agent_device_id 决定该会话的额度来自哪个网关。 */
function resolveGateway(row) {
  const gateways = loadGateways();
  const pid = String((row && row.provider_id) || '');
  const did = String((row && row.agent_device_id) || '');
  const hit = gateways.find((g) =>
    (pid && g.providerIds.includes(pid)) || (did && g.deviceIds.includes(did)));
  return hit || gateways[0];
}

async function resolveSession(params) {
  const id = String((params && params.sessionId) || '');
  const quotas = await loadQuotas(false);
  const known = new Set(quotas.entries.map((e) => e.provider));
  const row = lookupSession(id);
  const kind = row && row.kind ? String(row.kind).toLowerCase() : '';
  const model = row ? row.model : null;
  const routeIndex = loadRouteIndex();
  const route = row && row.sdk_session_id ? routeIndex.entries.get(String(row.sdk_session_id)) || null : null;
  let provider = null;
  if (route && route.provider) provider = String(route.provider).toLowerCase();
  if (!provider && model) provider = resolveProvider(model, known, await loadOwners());
  const gateway = resolveGateway(row);
  return {
    provider, model, kind, found: !!row,
    route,
    gatewayId: gateway.id, gatewayLabel: gateway.label,
    providerId: String((row && row.provider_id) || ''),
    agentDeviceId: String((row && row.agent_device_id) || '')
  };
}

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    reply({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  if (request.method === 'quotas') {
    const result = await loadQuotas(!!(request.params && request.params.force));
    reply({ jsonrpc: '2.0', id: request.id, result });
    return;
  }
  if (request.method === 'session') {
    try {
      reply({ jsonrpc: '2.0', id: request.id, result: await resolveSession(request.params) });
    } catch (err) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32000, message: String((err && err.message) || err) } });
    }
    return;
  }
  reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
});
