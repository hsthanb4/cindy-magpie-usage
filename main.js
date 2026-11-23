let lastTry = 0;
let snapshot = null; // 最近一次成功/失败的结果，胶囊同步渲染它
const scopes = new Map();
const sessions = new Map();
const pendingSessions = new Set();

async function fetchQuotas(force, extra) {
  try {
    const response = await cindy.node.request(Object.assign({
      method: 'quotas', params: { force: !!force }, timeoutMs: 15000
    }, extra || {}));
    if (!response.ok) throw new Error(response.message || 'Node 请求失败');
    const result = response.result;
    if (!result.ok && !result.entries.length && snapshot) {
      return Object.assign({}, result, {
        entries: snapshot.entries,
        updatedAt: snapshot.updatedAt,
        latestRoute: snapshot.latestRoute
      });
    }
    return result;
  } catch (error) {
    return {
      ok: false,
      error: String(error.message || error),
      entries: snapshot ? snapshot.entries : [],
      updatedAt: snapshot ? snapshot.updatedAt : null,
      latestRoute: snapshot ? snapshot.latestRoute : null
    };
  }
}

// ---- 胶囊文案 ----
const RING = ['○', '◔', '◑', '◕', '●'];
const ring = (pct) => RING[Math.min(4, Math.round(pct / 25))];
const shortName = (e) => String(e.name || e.provider).replace(/\s*Code$/i, '');
const servedAt = (e) => Date.parse(e.lastServedAt || '') || 0;

function usedOf(x) {
  return x.used != null ? x.used : (x.remaining != null ? 100 - x.remaining : null);
}

function worstWindow(entry) {
  let w = null;
  for (const x of (entry && entry.windows) || []) {
    const used = usedOf(x);
    if (used != null && (!w || used > w.used)) w = { used, name: x.name, resetsAt: x.resetsAt };
  }
  return w;
}

function windowUsed(w) {
  const used = usedOf(w);
  return used == null ? null : { used, name: w.name, resetsAt: w.resetsAt };
}

function pickFrom(mine) {
  if (!mine.length) return null;
  const usedOfEntry = (e) => { const w = worstWindow(e); return w ? w.used : -1; };
  return mine.slice().sort((a, b) =>
    Number(b.last) - Number(a.last) ||
    servedAt(b) - servedAt(a) ||
    usedOfEntry(b) - usedOfEntry(a)
  )[0];
}

function pickRouteEntry(entries, provider, route) {
  const mine = entries.filter((e) => String(e.provider).toLowerCase() === String(provider).toLowerCase());
  if (!mine.length) return null;
  if (route && route.account) {
    const hit = mine.find((e) => String(e.user || '').toLowerCase() === String(route.account).toLowerCase());
    return hit || null;
  }
  return pickFrom(mine);
}

function providerRange(entries, provider) {
  const items = (entries || [])
    .filter((e) => String(e.provider).toLowerCase() === String(provider).toLowerCase())
    .map((entry) => ({ entry, w: worstWindow(entry) }))
    .filter((x) => x.w)
    .sort((a, b) => b.w.used - a.w.used);
  if (!items.length) return null;
  return {
    count: items.length,
    min: Math.round(items[items.length - 1].w.used),
    max: Math.round(items[0].w.used),
    top: items[0],
    bottom: items[items.length - 1]
  };
}

function currentEntry(entries, sessionId) {
  const s = sessions.get(sessionId);
  if (!s) return { entry: null, model: null, pending: false, gateway: null, route: null, entries: [] };
  const scoped = s.gatewayId ? entries.filter((e) => e.gatewayId === s.gatewayId) : entries;
  const route = s.route || null;
  const provider = s.provider || (route && route.provider) || null;
  if (provider) {
    return {
      entry: pickRouteEntry(scoped, provider, route),
      model: (route && (route.served || route.model)) || s.model,
      pending: !s.resolved,
      gateway: s,
      route,
      entries: scoped
    };
  }
  return { entry: null, model: s.model, pending: !s.resolved, gateway: s, route, entries: scoped };
}

function routeWindow(entry, route) {
  if (!entry) return null;
  const windows = entry.windows || [];
  if (route) {
    if (route.usedWindow) {
      const hit = windows.find((w) => String(w.name || '').toLowerCase().includes(String(route.usedWindow).toLowerCase()));
      if (hit) {
        const w = windowUsed(hit);
        if (w) return w;
      }
    }
    if (route.usedRenews) {
      const t = Date.parse(route.usedRenews);
      if (t) {
        const hit = windows.find((w) => {
          const wt = Date.parse(w.resetsAt || '');
          return wt && Math.abs(wt - t) <= 5 * 60 * 1000;
        });
        if (hit) {
          const w = windowUsed(hit);
          if (w) return w;
        }
      }
    }
    if (typeof route.used === 'number') {
      const hit = windows.find((w) => {
        const used = usedOf(w);
        return used != null && Math.abs(used - route.used) < 0.6;
      });
      if (hit) {
        const w = windowUsed(hit);
        if (w) return w;
      }
    }
  }
  const w = worstWindow(entry);
  if (w) return w;
  if (route && typeof route.used === 'number') {
    return { used: route.used, name: route.usedWindow || '额度', resetsAt: route.usedRenews };
  }
  return null;
}

function shortAccount(who, entries, provider) {
  if (!who) return '';
  const same = (entries || []).filter((e) => String(e.provider).toLowerCase() === String(provider).toLowerCase());
  if (same.length <= 1) return '';
  const m = /^(.)(.*)(.)@(.+)$/.exec(String(who));
  if (m) return '·' + m[1] + '***' + m[3];
  const s = String(who);
  return '·' + (s.length > 8 ? s.slice(0, 8) + '…' : s);
}

function rangeTip(range, lead) {
  const fmt = (x) => `${Math.round(x.w.used)}%：${x.entry.user || x.entry.name}（${x.w.name}）`;
  return [
    lead || ('未找到本会话的 Magpie 路由记录；该 provider 有 ' + range.count + ' 个账号。'),
    '最高 ' + fmt(range.top),
    '最低 ' + fmt(range.bottom)
  ].join('\n');
}

function routeTip(cur, route, w, scoped) {
  const lines = [];
  if (route) {
    const chain = [];
    if (route.group && route.group.name) chain.push(route.group.name);
    if (route.rule && route.rule.use) chain.push(String(route.rule.use).replace(/^group\//, ''));
    if (route.served || route.model) chain.push(route.served || route.model);
    lines.push('本会话路由：' + (chain.length ? chain.join(' → ') : (route.model || '未知')));
    if (route.account) {
      lines.push('实际账号：' + route.account + (route.plan ? '（' + route.plan + '）' : ''));
    } else if (route.provider && scoped &&
        scoped.filter((e) => String(e.provider).toLowerCase() === String(route.provider).toLowerCase()).length > 1) {
      lines.push('实际账号：日志未记录（该 provider 有多个账号）');
    }
    if (route.fallbackCount) lines.push('回退：' + route.fallbackCount + ' 次');
    if (route.time) {
      lines.push('请求时间：' + new Date(route.time).toLocaleString());
    }
  } else {
    lines.push('未找到本会话的 Magpie 路由记录，以下按 provider 最近使用账号显示。');
  }
  if (w) {
    lines.push(`${cur.name}${cur.user ? '（' + cur.user + '）' : ''}：${Math.round(w.used)}% 已用 · ${w.name}` +
      (w.resetsAt ? ' · ' + new Date(w.resetsAt).toLocaleString() + ' 重置' : ''));
  }
  return lines.join('\n');
}

function pillText(sessionId) {
  if (!snapshot) return { label: 'Magpie …', tip: 'Magpie：加载中' };
  if (!snapshot.ok && snapshot.entries.length === 0) return { label: '⚠ Magpie 未连接', tip: snapshot.error };
  const found = currentEntry(snapshot.entries, sessionId);
  const route = found && found.route;
  const scoped = (found && found.entries) || snapshot.entries;
  if (found && found.pending) return { label: 'Magpie …', tip: '正在匹配当前会话的 Magpie 路由' };
  if (found && found.entry) {
    const cur = found.entry;
    const name = shortName(cur);
    const shown = name + shortAccount(route && route.account, scoped, cur.provider);
    if (route && !route.account &&
        scoped.filter((e) => String(e.provider).toLowerCase() === String(cur.provider).toLowerCase()).length > 1) {
      const range = providerRange(scoped, cur.provider);
      if (range && range.count > 1) {
        const routed = route.rule ? 'auto→' : '';
        const suffix = range.min === range.max ? range.min + '%' : range.min + '–' + range.max + '%';
        const label = !snapshot.ok
          ? '⚠ ' + routed + name + ' ' + suffix + ' · 缓存'
          : ring(range.max) + ' ' + routed + name + ' ' + suffix + (range.min >= 90 ? ' ⚠' : '');
        return {
          label,
          tip: routeTip(cur, route, null, scoped) + '\n' +
            rangeTip(range, '账号范围：')
        };
      }
    }
    if (!route) {
      const range = providerRange(scoped, cur.provider);
      if (range && range.count > 1 && range.min !== range.max) {
        const label = !snapshot.ok
          ? '⚠ ' + name + ' ' + range.min + '–' + range.max + '% · 缓存'
          : ring(range.max) + ' ' + name + ' ' + range.min + '–' + range.max + '%' + (range.min >= 90 ? ' ⚠' : '');
        return { label, tip: rangeTip(range) };
      }
    }
    if (cur.error) return { label: '⚠ ' + shown + ' · 错误', tip: routeTip(cur, route, null, scoped) + '\n' + cur.error };
    const w = routeWindow(cur, route);
    if (!w) return { label: shown + ' · 无数据', tip: routeTip(cur, route, null, scoped) };
    const pct = Math.round(w.used);
    const multiWindow = (cur.windows || []).length > 1;
    const routed = route && route.rule ? 'auto→' : '';
    const remote = cur.gatewayLabel && cur.gatewayLabel !== '本机 Magpie' ? ' · ' + cur.gatewayLabel : '';
    let label;
    if (!snapshot.ok) label = '⚠ ' + routed + shown + ' ' + pct + '% · 缓存';
    else if (pct >= 100) label = '⚠ ' + routed + shown + (multiWindow ? ' ' + w.name + ' 已满' : ' 已用尽');
    else label = ring(pct) + ' ' + routed + shown + ' ' + pct + '%' + (pct >= 90 ? ' ⚠' : '');
    label += remote;
    return { label, tip: routeTip(cur, route, w, scoped) };
  }
  if (found && route) {
    const name = route.providerName || route.provider || route.served || found.model || '未知';
    if (typeof route.used === 'number') {
      const pct = Math.round(route.used);
      const w = { used: route.used, name: route.usedWindow || '额度', resetsAt: route.usedRenews };
      const routed = route.rule ? 'auto→' : '';
      const label = pct >= 100
        ? '⚠ ' + routed + name + (route.usedWindow ? ' ' + route.usedWindow + ' 已满' : ' 已用尽')
        : ring(pct) + ' ' + routed + name + ' ' + pct + '%';
      return {
        label,
        tip: routeTip({ name, user: route.account }, route, w, scoped) + '\n该 provider 未出现在当前额度读取结果，显示最近请求时的用量。'
      };
    }
    return { label: '⚠ ' + name + ' 无额度', tip: routeTip({}, route, null, scoped) };
  }
  if (found && found.gateway &&
      found.gateway.gatewayLabel && found.gateway.gatewayLabel !== '本机 Magpie') {
    return { label: '⚠ ' + found.gateway.gatewayLabel + ' 无数据', tip: '该会话的远程 Magpie 网关没有返回额度' };
  }
  // 缺省展示最高用量账号
  let worst = null;
  for (const e of snapshot.entries || []) {
    const w = worstWindow(e);
    if (w && (!worst || w.used > worst.w.used)) worst = { e, w };
  }
  if (worst) {
    const pct = Math.round(worst.w.used);
    const name = shortName(worst.e);
    const label = !snapshot.ok ? '⚠ ' + name + ' ' + pct + '%'
      : ring(pct) + ' ' + name + ' ' + pct + '%';
    return { label, tip: `最高用量：${worst.e.name} (${pct}%) · 点击查看详情` };
  }
  return { label: 'Magpie 就绪', tip: '点击打开用量卡片' };
}

async function resolveSession(sessionId, clientId) {
  const prev = sessions.get(sessionId) || {};
  if (clientId) prev.clientId = String(clientId);
  if (pendingSessions.has(sessionId)) { sessions.set(sessionId, prev); return; }
  pendingSessions.add(sessionId);
  let info = {
    provider: null, model: null, kind: '', gatewayId: 'local', gatewayLabel: '本机 Magpie',
    providerId: '', agentDeviceId: '', route: null, resolved: false
  };
  try {
    const response = await cindy.node.request({ method: 'session', params: { sessionId }, timeoutMs: 8000 });
    const r = response && response.ok ? response.result : null;
    info = {
      provider: r && r.provider ? String(r.provider) : null,
      model: r && r.model ? String(r.model) : null,
      kind: r && r.kind ? String(r.kind) : '',
      gatewayId: r && r.gatewayId ? String(r.gatewayId) : 'local',
      gatewayLabel: r && r.gatewayLabel ? String(r.gatewayLabel) : '本机 Magpie',
      providerId: r && r.providerId ? String(r.providerId) : '',
      agentDeviceId: r && r.agentDeviceId ? String(r.agentDeviceId) : '',
      route: r && r.route ? r.route : null,
      resolved: !!r
    };
  } catch {
    info.resolved = true;
  } finally {
    pendingSessions.delete(sessionId);
  }
  sessions.set(sessionId, Object.assign({}, prev, info));
  publish(sessionId, sessions.get(sessionId).clientId);
}

function publish(sessionId, clientId) {
  if (!cindy.ui || typeof cindy.ui.updateContribution !== 'function') return;
  const { label } = pillText(sessionId);
  const target = sessionId ? Object.assign({ sessionId }, clientId ? { clientId } : {}) : undefined;
  cindy.ui.updateContribution('usage-pill', () => ({
    title: label,
    disabled: false,
    visible: true
  }), target);
}

async function refresh(force, reResolve) {
  try {
    const r = await fetchQuotas(force);
    snapshot = r;
    if (sessions.size) {
      for (const [sid, info] of sessions) publish(sid, info.clientId);
      if (reResolve) for (const sid of sessions.keys()) void resolveSession(sid);
    } else {
      publish();
    }
    return r;
  } catch (e) {
    publish();
  }
}

// ---- 宿主消息监听 ----
cindy.onHostMessage(async function (msg) {
  if (msg.type === 'ui-consumers') {
    const consumers = Array.isArray(msg.consumers) ? msg.consumers : [];
    for (const c of consumers) {
      if (!c) continue;
      const sid = String(c.sessionId || c.session_id || '');
      if (sid) void resolveSession(sid, c.clientId ? String(c.clientId) : null);
    }
    void refresh(false);
    return;
  }
  if (msg.type === 'tool-call' && msg.tool === 'magpie_usage') {
    const result = await fetchQuotas(true, { callId: msg.callId });
    if (!result.ok && result.entries.length === 0) {
      await cindy.send({ type: 'tool-result', callId: msg.callId, ok: false, errorCode: 'MAGPIE_UNREACHABLE', message: result.error });
      return;
    }
    const provider = String((msg.args && msg.args.provider) || '').toLowerCase();
    const entries = provider ? result.entries.filter((e) => e.provider.toLowerCase() === provider) : result.entries;
    const latestRoute = result.latestRoute &&
      (!provider || String(result.latestRoute.provider || '').toLowerCase() === provider)
      ? result.latestRoute : null;
    await cindy.send({
      type: 'tool-result',
      callId: msg.callId,
      ok: true,
      result: {
        updatedAt: result.updatedAt, stale: !result.ok, accounts: entries,
        gateways: result.gateways || [], gatewayErrors: result.gatewayErrors || [],
        latestRoute
      }
    });
    return;
  }
});

// 初始化握手与定时刷新
if (typeof cindy.ping === 'function') {
  cindy.ping().then((hello) => {
    const list = hello && Array.isArray(hello.nativeUiConsumers) ? hello.nativeUiConsumers : [];
    for (const c of list) {
      if (!c) continue;
      const sid = String(c.sessionId || c.session_id || '');
      if (sid) void resolveSession(sid, c.clientId ? String(c.clientId) : null);
    }
    publish();
    refresh(false);
  }).catch(() => {});
} else {
  refresh(false);
}
setInterval(() => refresh(false, true), 30000);
