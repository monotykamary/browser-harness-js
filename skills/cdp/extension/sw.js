/**
 * MV3 CDP relay. The daemon speaks the same JSON-RPC as Chrome's browser
 * WebSocket; this worker emulates browser-level Target.* / Browser window
 * bounds with chrome.tabs / chrome.windows / chrome.debugger, exposes extra
 * Chrome.* tab/window/group commands, and pass-throughs every other domain
 * via sendCommand. OOPIF/worker targets come from chrome.debugger.getTargets();
 * Browser.grantPermissions maps through chrome.contentSettings.
 *
 * Connects to ws://127.0.0.1:<port>/extension (default 9876, same as
 * CDP_REPL_PORT) with ?id=<instanceId>&label=<label>&v=<version>. Each
 * Chromium profile (an Ardia space, a Chrome person) runs its own copy of
 * this worker and keeps its own instanceId in chrome.storage.local, so the
 * daemon can hold one socket per profile and the agent picks one by id or
 * label. chrome.tabs / chrome.windows only ever see this profile's tabs.
 */

const DEFAULT_PORT = 9876;
const PROTOCOL = '1.3';
const RECONNECT_MIN_MS = 400;
const RECONNECT_MAX_MS = 5_000;

/** @type {WebSocket | null} */
let ws = null;
let reconnectMs = RECONNECT_MIN_MS;
let reconnectTimer = null;
let connecting = false;
let autoAttach = false;
let discoverTargets = false;
/** @type {Promise<{ id: string, label: string }> | null} */
let identityPromise = null;

/** sessionId -> { debuggee, targetId, tabId? } */
const sessions = new Map();
/** tabId -> sessionId */
const tabToSession = new Map();
/** debugger target id -> sessionId */
const debuggerToSession = new Map();

chrome.runtime.onInstalled.addListener(() => connect());
chrome.runtime.onStartup.addListener(() => connect());
chrome.action.onClicked.addListener(() => {
  disconnect();
  reconnectMs = RECONNECT_MIN_MS;
  connect();
});
chrome.alarms.create('bh-keepalive', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== 'bh-keepalive') return;
  if (!ws || ws.readyState === WebSocket.CLOSING || ws.readyState === WebSocket.CLOSED) connect();
});

chrome.debugger.onEvent.addListener((source, method, params) => {
  const sessionId = sessionIdForDebuggee(source);
  if (!sessionId) return;
  emit({ method, params, sessionId });
});

chrome.debugger.onDetach.addListener((source, reason) => {
  const sess = sessionForDebuggee(source);
  if (!sess) return;
  forgetSession(sess.sessionId);
  emit({
    method: 'Inspector.detached',
    params: { reason: reason || 'target_closed' },
    sessionId: sess.sessionId,
  });
  emit({
    method: 'Target.detachedFromTarget',
    params: { sessionId: sess.sessionId, targetId: sess.targetId },
  });
});

chrome.tabs.onCreated.addListener(async (tab) => {
  if (tab.id == null) return;
  const info = targetInfoFromTab(tab);
  if (discoverTargets) emit({ method: 'Target.targetCreated', params: { targetInfo: info } });
  if (!autoAttach) return;
  try {
    const sessionId = await attachTab(tab.id, String(tab.id));
    emit({
      method: 'Target.attachedToTarget',
      params: { sessionId, waitingForDebugger: false, targetInfo: info },
    });
  } catch {
    /* chrome:// and other restricted pages */
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  const sessionId = tabToSession.get(tabId);
  forgetTab(tabId);
  if (discoverTargets) emit({ method: 'Target.targetDestroyed', params: { targetId: String(tabId) } });
  if (sessionId) emit({ method: 'Target.detachedFromTarget', params: { sessionId, targetId: String(tabId) } });
});

chrome.tabs.onUpdated.addListener(async (_tabId, _change, tab) => {
  if (tab.id == null) return;
  if (discoverTargets) emit({ method: 'Target.targetInfoChanged', params: { targetInfo: targetInfoFromTab(tab) } });
});

chrome.tabs.onMoved.addListener(async (tabId) => {
  if (!discoverTargets) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: targetInfoFromTab(tab) } });
  } catch {
    /* gone */
  }
});

chrome.tabs.onAttached.addListener(async (tabId) => {
  if (!discoverTargets) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: targetInfoFromTab(tab) } });
  } catch {
    /* gone */
  }
});

chrome.tabs.onActivated.addListener(async (active) => {
  if (!discoverTargets) return;
  try {
    const tab = await chrome.tabs.get(active.tabId);
    emit({ method: 'Target.targetInfoChanged', params: { targetInfo: targetInfoFromTab(tab) } });
  } catch {
    /* gone */
  }
});

if (chrome.tabGroups) {
  chrome.tabGroups.onCreated.addListener((group) => {
    emit({ method: 'Chrome.tabGroupCreated', params: { group: serializeGroup(group) } });
  });
  chrome.tabGroups.onUpdated.addListener((group) => {
    emit({ method: 'Chrome.tabGroupUpdated', params: { group: serializeGroup(group) } });
  });
  chrome.tabGroups.onRemoved.addListener((group) => {
    emit({ method: 'Chrome.tabGroupRemoved', params: { groupId: group.id } });
  });
  chrome.tabGroups.onMoved.addListener((group) => {
    emit({
      method: 'Chrome.tabGroupMoved',
      params: { groupId: group.id, windowId: group.windowId },
    });
  });
}

connect();

function port() {
  return DEFAULT_PORT;
}

/** Stable per-profile identity; storage.local is per profile, so each space gets its own. */
function loadIdentity() {
  if (!identityPromise) {
    identityPromise = (async () => {
      const got = await chrome.storage.local.get(['bhInstanceId', 'bhLabel']);
      let id = got.bhInstanceId;
      if (typeof id !== 'string' || !id) {
        id = crypto.randomUUID();
        await chrome.storage.local.set({ bhInstanceId: id });
      }
      return { id, label: typeof got.bhLabel === 'string' ? got.bhLabel : '' };
    })();
    identityPromise.catch(() => { identityPromise = null; });
  }
  return identityPromise;
}

function hubUrl(identity) {
  const q = new URLSearchParams({ id: identity.id, v: chrome.runtime.getManifest().version });
  if (identity.label) q.set('label', identity.label);
  return 'ws://127.0.0.1:' + port() + '/extension?' + q.toString();
}

function connect() {
  if (connecting) return;
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  connecting = true;
  loadIdentity().then(
    (identity) => { connecting = false; openSocket(identity); },
    () => { connecting = false; scheduleReconnect(); },
  );
}

function openSocket(identity) {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  disconnect();
  let socket;
  try {
    socket = new WebSocket(hubUrl(identity));
  } catch {
    scheduleReconnect();
    return;
  }
  ws = socket;
  socket.addEventListener('open', () => {
    if (ws !== socket) return;
    reconnectMs = RECONNECT_MIN_MS;
    setBadge(true);
  });
  socket.addEventListener('message', (ev) => {
    if (typeof ev.data === 'string') onMessage(ev.data);
  });
  socket.addEventListener('close', () => {
    if (ws === socket) ws = null;
    setBadge(false);
    scheduleReconnect();
  });
  socket.addEventListener('error', () => {
    try { socket.close(); } catch { /* ignore */ }
  });
}

function disconnect() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  const prev = ws;
  ws = null;
  if (prev) {
    try { prev.close(); } catch { /* ignore */ }
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const wait = reconnectMs;
  reconnectMs = Math.min(reconnectMs * 1.5, RECONNECT_MAX_MS);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, wait);
}

function setBadge(connected) {
  try {
    chrome.action.setBadgeText({ text: connected ? 'on' : '' });
    chrome.action.setBadgeBackgroundColor({ color: connected ? '#0a0' : '#666' });
  } catch {
    /* tests / no action */
  }
}

function emit(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch { /* ignore */ }
}

async function onMessage(raw) {
  let msg;
  try { msg = JSON.parse(raw); } catch { return; }
  if (typeof msg.id !== 'number' || typeof msg.method !== 'string') return;
  try {
    const result = await dispatch(msg.method, msg.params ?? {}, msg.sessionId);
    emit({ id: msg.id, result: result ?? {} });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    const code = /session with given id not found/i.test(message) ? -32001 : -32000;
    emit({ id: msg.id, error: { code, message } });
  }
}

async function dispatch(method, params, sessionId) {
  switch (method) {
    case 'Target.getTargets': return getTargets();
    case 'Target.createTarget': return createTarget(params);
    case 'Target.attachToTarget': return attachToTarget(params);
    case 'Target.closeTarget': return closeTarget(params);
    case 'Target.activateTarget': return activateTarget(params);
    case 'Target.detachFromTarget': return detachFromTarget(params);
    case 'Target.getTargetInfo': return getTargetInfo(params);
    case 'Target.setDiscoverTargets':
      discoverTargets = Boolean(params.discover);
      return {};
    case 'Target.setAutoAttach':
      return setAutoAttach(params);
    case 'Browser.getVersion':
      return {
        protocolVersion: PROTOCOL,
        product: 'Chrome/extension',
        revision: '',
        userAgent: navigator.userAgent,
        jsVersion: '',
      };
    case 'Extension.getInfo': return getInfo();
    case 'Extension.setLabel': return setLabel(params);
    case 'Browser.getWindowForTarget': return getWindowForTarget(params);
    case 'Browser.getWindowBounds': return getWindowBounds(params);
    case 'Browser.setWindowBounds': return setWindowBounds(params);
    case 'Browser.grantPermissions': return grantPermissions(params);
    case 'Browser.resetPermissions': return resetPermissions();
    case 'Browser.setPermission': return setPermission(params);
    case 'Chrome.updateTab': return updateTab(params);
    case 'Chrome.moveTabs': return moveTabs(params);
    case 'Chrome.discardTab': return discardTab(params);
    case 'Chrome.reloadTab': return reloadTab(params);
    case 'Chrome.duplicateTab': return duplicateTab(params);
    case 'Chrome.highlight': return highlightTabs(params);
    case 'Chrome.group': return groupTabs(params);
    case 'Chrome.ungroup': return ungroupTabs(params);
    case 'Chrome.getTabGroups': return getTabGroups(params);
    case 'Chrome.updateTabGroup': return updateTabGroup(params);
    case 'Chrome.moveTabGroup': return moveTabGroup(params);
    case 'Chrome.getWindows': return getWindows(params);
    case 'Chrome.createWindow': return createWindow(params);
    case 'Chrome.updateWindow': return updateWindow(params);
    case 'Chrome.removeWindow': return removeWindow(params);
    default:
      break;
  }
  if (method.startsWith('Target.') || method.startsWith('Browser.') || method.startsWith('Chrome.') || method.startsWith('Extension.')) {
    throw new Error(method + ' is not available over the extension transport');
  }
  if (!sessionId) throw new Error('No sessionId for ' + method);
  const sess = sessions.get(sessionId);
  if (!sess) throw new Error('Session with given id not found');
  return await sendCommand(sess.debuggee, method, params);
}

async function getInfo() {
  const identity = await loadIdentity();
  const tabs = (await chrome.tabs.query({})).filter((t) => t.id != null);
  return {
    instanceId: identity.id,
    label: identity.label,
    version: chrome.runtime.getManifest().version,
    tabCount: tabs.length,
    tabs: tabs.slice(0, 50).map((t) => ({
      targetId: String(t.id),
      url: t.url || '',
      title: t.title || '',
      active: Boolean(t.active),
    })),
  };
}

async function setLabel(params) {
  const label = String(params.label ?? '').trim().slice(0, 128);
  const identity = await loadIdentity();
  await chrome.storage.local.set({ bhLabel: label });
  identity.label = label;
  return { instanceId: identity.id, label };
}

async function sendCommand(debuggee, method, params) {
  const result = await chrome.debugger.sendCommand(debuggee, method, params ?? {});
  return result ?? {};
}

function sessionIdForDebuggee(source) {
  if (source.tabId != null && tabToSession.has(source.tabId)) return tabToSession.get(source.tabId);
  if (source.targetId) return debuggerToSession.get(source.targetId);
  return undefined;
}

function sessionForDebuggee(source) {
  const sessionId = sessionIdForDebuggee(source);
  if (!sessionId) return undefined;
  const sess = sessions.get(sessionId);
  return sess ? { sessionId, ...sess } : undefined;
}

function canAttachUrl(url) {
  return !url.startsWith('chrome://')
    && !url.startsWith('devtools://')
    && !url.startsWith('chrome-extension://');
}

async function getTargets() {
  const tabs = await chrome.tabs.query({});
  const pages = tabs.filter(t => t.id != null).map(targetInfoFromTab);
  const tabIds = new Set(tabs.map(t => t.id).filter(id => id != null));
  let extras = [];
  try {
    const dbg = await chrome.debugger.getTargets();
    extras = dbg
      .filter((t) => !(t.tabId != null && tabIds.has(t.tabId) && (t.type === 'page' || !t.type)))
      .map(targetInfoFromDebugger);
  } catch {
    /* debugger.getTargets unavailable */
  }
  return { targetInfos: pages.concat(extras) };
}

function targetInfoFromTab(tab) {
  const tabId = tab.id;
  const muted = Boolean(tab.mutedInfo && tab.mutedInfo.muted);
  return {
    targetId: String(tabId),
    type: 'page',
    title: tab.title || '',
    url: tab.url || '',
    attached: tabToSession.has(tabId),
    canAccessOpener: tab.openerTabId != null,
    openerId: tab.openerTabId != null ? String(tab.openerTabId) : undefined,
    windowId: tab.windowId,
    index: tab.index,
    groupId: tab.groupId,
    pinned: Boolean(tab.pinned),
    muted,
    discarded: Boolean(tab.discarded),
    audible: Boolean(tab.audible),
    active: Boolean(tab.active),
    status: tab.status || '',
    incognito: Boolean(tab.incognito),
    autoDiscardable: tab.autoDiscardable !== false,
  };
}

function cdpTypeFromDebugger(type) {
  if (type === 'iframe') return 'iframe';
  if (type === 'worker') return 'worker';
  if (type === 'shared_worker') return 'shared_worker';
  if (type === 'service_worker') return 'service_worker';
  if (type === 'background_page') return 'worker';
  if (type === 'page') return 'page';
  return type || 'other';
}

function targetInfoFromDebugger(t) {
  const targetId = String(t.id);
  return {
    targetId,
    type: cdpTypeFromDebugger(t.type),
    title: t.title || '',
    url: t.url || '',
    attached: Boolean(t.attached) || debuggerToSession.has(targetId),
    canAccessOpener: false,
    tabId: t.tabId,
  };
}

function serializeGroup(group) {
  return {
    groupId: group.id,
    windowId: group.windowId,
    title: group.title || '',
    color: group.color,
    collapsed: Boolean(group.collapsed),
  };
}

function serializeWindow(win) {
  return {
    windowId: win.id,
    focused: Boolean(win.focused),
    incognito: Boolean(win.incognito),
    type: win.type,
    state: win.state,
    left: win.left,
    top: win.top,
    width: win.width,
    height: win.height,
    tabIds: (win.tabs || []).filter(t => t.id != null).map(t => String(t.id)),
  };
}

function boundsFromWindow(win) {
  return {
    left: win.left,
    top: win.top,
    width: win.width,
    height: win.height,
    windowState: win.state || 'normal',
  };
}

function tabIdFromTarget(targetId) {
  const tabId = Number(targetId);
  if (!Number.isFinite(tabId)) throw new Error('unknown targetId ' + targetId);
  return tabId;
}

function tabIdsFromTargets(tabIds) {
  if (!Array.isArray(tabIds) || tabIds.length === 0) throw new Error('tabIds required');
  return tabIds.map(tabIdFromTarget);
}

async function createTarget(params) {
  const url = typeof params.url === 'string' && params.url ? params.url : 'about:blank';
  const background = Boolean(params.background);
  if (params.newWindow) {
    const win = await chrome.windows.create({ url, focused: !background });
    const tab = win.tabs && win.tabs[0];
    if (!tab || tab.id == null) throw new Error('Target.createTarget: window opened with no tab');
    return { targetId: String(tab.id) };
  }
  const tab = await chrome.tabs.create({ url, active: !background });
  if (tab.id == null) throw new Error('Target.createTarget: tab has no id');
  return { targetId: String(tab.id) };
}

async function attachToTarget(params) {
  const targetId = String(params.targetId ?? '');
  if (!targetId) throw new Error('Target.attachToTarget requires targetId');
  if (/^\d+$/.test(targetId)) {
    const sessionId = await attachTab(Number(targetId), targetId);
    return { sessionId };
  }
  const sessionId = await attachDebuggerTarget(targetId);
  return { sessionId };
}

async function attachTab(tabId, targetId) {
  const existing = tabToSession.get(tabId);
  if (existing) return existing;
  let tab;
  try {
    tab = await chrome.tabs.get(tabId);
  } catch {
    throw new Error('No target with given id found');
  }
  const url = tab.url || '';
  if (!canAttachUrl(url)) {
    throw new Error('Cannot attach to ' + url + ' over the extension transport');
  }
  const debuggee = { tabId };
  await chrome.debugger.attach(debuggee, PROTOCOL);
  return rememberSession(debuggee, targetId || String(tabId), tabId);
}

async function attachDebuggerTarget(targetId) {
  const existing = debuggerToSession.get(targetId);
  if (existing) return existing;
  let info;
  try {
    const dbg = await chrome.debugger.getTargets();
    info = dbg.find((t) => String(t.id) === targetId);
  } catch {
    info = undefined;
  }
  if (!info) throw new Error('No target with given id found');
  if (!canAttachUrl(info.url || '')) {
    throw new Error('Cannot attach to ' + (info.url || targetId) + ' over the extension transport');
  }
  const debuggee = { targetId };
  await chrome.debugger.attach(debuggee, PROTOCOL);
  return rememberSession(debuggee, targetId, info.tabId);
}

function rememberSession(debuggee, targetId, tabId) {
  const sessionId = crypto.randomUUID();
  sessions.set(sessionId, { sessionId, debuggee, targetId, tabId });
  if (tabId != null) tabToSession.set(tabId, sessionId);
  if (debuggee.targetId) debuggerToSession.set(String(debuggee.targetId), sessionId);
  return sessionId;
}

async function setAutoAttach(params) {
  autoAttach = Boolean(params.autoAttach);
  if (!autoAttach) return {};
  const { targetInfos } = await getTargets();
  for (const info of targetInfos) {
    if (!canAttachUrl(info.url || '')) continue;
    try {
      const attached = await attachToTarget({ targetId: info.targetId });
      emit({
        method: 'Target.attachedToTarget',
        params: { sessionId: attached.sessionId, waitingForDebugger: false, targetInfo: info },
      });
    } catch {
      /* restricted page or already attached elsewhere */
    }
  }
  return {};
}

async function closeTarget(params) {
  const targetId = String(params.targetId ?? '');
  if (/^\d+$/.test(targetId)) {
    const tabId = Number(targetId);
    try { await chrome.debugger.detach({ tabId }); } catch { /* not attached */ }
    forgetTab(tabId);
    try { await chrome.tabs.remove(tabId); } catch { /* already gone */ }
    return { success: true };
  }
  try { await chrome.debugger.detach({ targetId }); } catch { /* not attached */ }
  const sessionId = debuggerToSession.get(targetId);
  if (sessionId) forgetSession(sessionId);
  return { success: true };
}

async function activateTarget(params) {
  const tabId = tabIdFromTarget(params.targetId);
  const tab = await chrome.tabs.update(tabId, { active: true });
  if (tab.windowId != null) {
    try { await chrome.windows.update(tab.windowId, { focused: true }); } catch { /* ignore */ }
  }
  return {};
}

async function detachFromTarget(params) {
  let sess;
  if (params.sessionId) {
    sess = sessions.get(params.sessionId);
  } else if (params.targetId != null) {
    const targetId = String(params.targetId);
    const sessionId = /^\d+$/.test(targetId)
      ? tabToSession.get(Number(targetId))
      : debuggerToSession.get(targetId);
    sess = sessionId ? sessions.get(sessionId) : undefined;
    if (!sess && /^\d+$/.test(targetId)) {
      try { await chrome.debugger.detach({ tabId: Number(targetId) }); } catch { /* ignore */ }
      forgetTab(Number(targetId));
      return {};
    }
  }
  if (!sess) return {};
  try { await chrome.debugger.detach(sess.debuggee); } catch { /* ignore */ }
  if (sess.sessionId) forgetSession(sess.sessionId);
  return {};
}

async function getTargetInfo(params) {
  const targetId = String(params.targetId ?? '');
  if (/^\d+$/.test(targetId)) {
    const tab = await chrome.tabs.get(Number(targetId));
    return { targetInfo: targetInfoFromTab(tab) };
  }
  const dbg = await chrome.debugger.getTargets();
  const info = dbg.find((t) => String(t.id) === targetId);
  if (!info) throw new Error('No target with given id found');
  return { targetInfo: targetInfoFromDebugger(info) };
}

async function getWindowForTarget(params) {
  const targetId = String(params.targetId ?? '');
  let tabId;
  if (/^\d+$/.test(targetId)) {
    tabId = Number(targetId);
  } else {
    const dbg = await chrome.debugger.getTargets();
    const info = dbg.find((t) => String(t.id) === targetId);
    tabId = info && info.tabId;
  }
  if (tabId == null) throw new Error('Browser.getWindowForTarget: target has no tab');
  const tab = await chrome.tabs.get(tabId);
  const win = await chrome.windows.get(tab.windowId);
  return { windowId: win.id, bounds: boundsFromWindow(win) };
}

async function getWindowBounds(params) {
  const windowId = Number(params.windowId);
  if (!Number.isFinite(windowId)) throw new Error('Browser.getWindowBounds requires windowId');
  const win = await chrome.windows.get(windowId);
  return { bounds: boundsFromWindow(win) };
}

async function setWindowBounds(params) {
  const windowId = Number(params.windowId);
  if (!Number.isFinite(windowId)) throw new Error('Browser.setWindowBounds requires windowId');
  const bounds = params.bounds || {};
  const update = {};
  const state = bounds.windowState;
  if (state && state !== 'normal') {
    update.state = state;
  } else {
    if (typeof bounds.left === 'number') update.left = bounds.left;
    if (typeof bounds.top === 'number') update.top = bounds.top;
    if (typeof bounds.width === 'number') update.width = bounds.width;
    if (typeof bounds.height === 'number') update.height = bounds.height;
    if (state === 'normal') update.state = 'normal';
  }
  await chrome.windows.update(windowId, update);
  return {};
}

async function updateTab(params) {
  const tabId = tabIdFromTarget(params.targetId);
  const patch = {};
  if (typeof params.pinned === 'boolean') patch.pinned = params.pinned;
  if (typeof params.muted === 'boolean') patch.muted = params.muted;
  if (typeof params.active === 'boolean') patch.active = params.active;
  if (typeof params.autoDiscardable === 'boolean') patch.autoDiscardable = params.autoDiscardable;
  if (typeof params.url === 'string') patch.url = params.url;
  const tab = await chrome.tabs.update(tabId, patch);
  return { targetInfo: targetInfoFromTab(tab) };
}

async function moveTabs(params) {
  const ids = tabIdsFromTargets(params.tabIds || (params.targetId != null ? [params.targetId] : []));
  const move = { index: Number(params.index) };
  if (!Number.isFinite(move.index)) throw new Error('Chrome.moveTabs requires index');
  if (params.windowId != null) move.windowId = Number(params.windowId);
  const moved = await chrome.tabs.move(ids, move);
  const tabs = Array.isArray(moved) ? moved : [moved];
  return { targetInfos: tabs.filter(t => t.id != null).map(targetInfoFromTab) };
}

async function discardTab(params) {
  const tabId = tabIdFromTarget(params.targetId);
  const tab = await chrome.tabs.discard(tabId);
  return { targetInfo: tab && tab.id != null ? targetInfoFromTab(tab) : undefined };
}

async function reloadTab(params) {
  const tabId = tabIdFromTarget(params.targetId);
  await chrome.tabs.reload(tabId, { bypassCache: Boolean(params.bypassCache) });
  return {};
}

async function duplicateTab(params) {
  const tabId = tabIdFromTarget(params.targetId);
  const tab = await chrome.tabs.duplicate(tabId);
  if (!tab || tab.id == null) throw new Error('Chrome.duplicateTab produced no tab');
  return { targetId: String(tab.id), targetInfo: targetInfoFromTab(tab) };
}

async function highlightTabs(params) {
  const ids = tabIdsFromTargets(params.tabIds);
  const tabs = await Promise.all(ids.map(id => chrome.tabs.get(id)));
  const windowId = params.windowId != null ? Number(params.windowId) : tabs[0].windowId;
  const windowTabs = await chrome.tabs.query({ windowId });
  const indexById = new Map(windowTabs.filter(t => t.id != null).map(t => [t.id, t.index]));
  const tabsIndexes = ids.map(id => indexById.get(id)).filter(n => n != null);
  await chrome.tabs.highlight({ windowId, tabs: tabsIndexes });
  return {};
}

async function groupTabs(params) {
  if (!chrome.tabs.group) throw new Error('Chrome.group requires the tabGroups permission');
  const ids = tabIdsFromTargets(params.tabIds);
  const opts = { tabIds: ids };
  if (params.groupId != null && params.groupId !== -1) opts.groupId = Number(params.groupId);
  else if (params.createProperties) opts.createProperties = params.createProperties;
  const groupId = await chrome.tabs.group(opts);
  return { groupId };
}

async function ungroupTabs(params) {
  if (!chrome.tabs.ungroup) throw new Error('Chrome.ungroup requires the tabGroups permission');
  const ids = tabIdsFromTargets(params.tabIds);
  await chrome.tabs.ungroup(ids);
  return {};
}

async function getTabGroups(params) {
  if (!chrome.tabGroups) throw new Error('Chrome.getTabGroups requires the tabGroups permission');
  const query = {};
  if (params.windowId != null) query.windowId = Number(params.windowId);
  const groups = await chrome.tabGroups.query(query);
  return { groups: groups.map(serializeGroup) };
}

async function updateTabGroup(params) {
  if (!chrome.tabGroups) throw new Error('Chrome.updateTabGroup requires the tabGroups permission');
  const groupId = Number(params.groupId);
  if (!Number.isFinite(groupId)) throw new Error('Chrome.updateTabGroup requires groupId');
  const patch = {};
  if (typeof params.title === 'string') patch.title = params.title;
  if (typeof params.color === 'string') patch.color = params.color;
  if (typeof params.collapsed === 'boolean') patch.collapsed = params.collapsed;
  const group = await chrome.tabGroups.update(groupId, patch);
  return { group: serializeGroup(group) };
}

async function moveTabGroup(params) {
  if (!chrome.tabGroups) throw new Error('Chrome.moveTabGroup requires the tabGroups permission');
  const groupId = Number(params.groupId);
  if (!Number.isFinite(groupId)) throw new Error('Chrome.moveTabGroup requires groupId');
  const move = { index: Number(params.index) };
  if (!Number.isFinite(move.index)) throw new Error('Chrome.moveTabGroup requires index');
  if (params.windowId != null) move.windowId = Number(params.windowId);
  const group = await chrome.tabGroups.move(groupId, move);
  return { group: serializeGroup(group) };
}

async function getWindows(params) {
  const populate = params.populate !== false;
  const wins = await chrome.windows.getAll({ populate, windowTypes: params.windowTypes });
  return { windows: wins.map(serializeWindow) };
}

async function createWindow(params) {
  const create = {};
  if (typeof params.url === 'string') create.url = params.url;
  else if (Array.isArray(params.url)) create.url = params.url;
  if (typeof params.focused === 'boolean') create.focused = params.focused;
  if (typeof params.incognito === 'boolean') create.incognito = params.incognito;
  if (typeof params.type === 'string') create.type = params.type;
  if (typeof params.state === 'string') create.state = params.state;
  if (typeof params.left === 'number') create.left = params.left;
  if (typeof params.top === 'number') create.top = params.top;
  if (typeof params.width === 'number') create.width = params.width;
  if (typeof params.height === 'number') create.height = params.height;
  if (params.tabId != null) create.tabId = tabIdFromTarget(params.tabId);
  const win = await chrome.windows.create(create);
  return { window: serializeWindow(win) };
}

async function updateWindow(params) {
  const windowId = Number(params.windowId);
  if (!Number.isFinite(windowId)) throw new Error('Chrome.updateWindow requires windowId');
  const patch = {};
  if (typeof params.focused === 'boolean') patch.focused = params.focused;
  if (typeof params.drawAttention === 'boolean') patch.drawAttention = params.drawAttention;
  if (typeof params.state === 'string') patch.state = params.state;
  if (typeof params.left === 'number') patch.left = params.left;
  if (typeof params.top === 'number') patch.top = params.top;
  if (typeof params.width === 'number') patch.width = params.width;
  if (typeof params.height === 'number') patch.height = params.height;
  const win = await chrome.windows.update(windowId, patch);
  return { window: serializeWindow(win) };
}

async function removeWindow(params) {
  const windowId = Number(params.windowId);
  if (!Number.isFinite(windowId)) throw new Error('Chrome.removeWindow requires windowId');
  await chrome.windows.remove(windowId);
  return {};
}

function forgetTab(tabId) {
  const sessionId = tabToSession.get(tabId);
  if (sessionId) forgetSession(sessionId);
  else tabToSession.delete(tabId);
}

function forgetSession(sessionId) {
  const sess = sessions.get(sessionId);
  sessions.delete(sessionId);
  if (!sess) return;
  if (sess.tabId != null && tabToSession.get(sess.tabId) === sessionId) {
    tabToSession.delete(sess.tabId);
  }
  if (sess.debuggee && sess.debuggee.targetId && debuggerToSession.get(sess.debuggee.targetId) === sessionId) {
    debuggerToSession.delete(sess.debuggee.targetId);
  }
}

const CONTENT_SETTING_BY_PERMISSION = {
  geolocation: 'location',
  notifications: 'notifications',
  audioCapture: 'microphone',
  videoCapture: 'camera',
  automaticDownloads: 'automaticDownloads',
};

function originPattern(origin) {
  if (!origin || typeof origin !== 'string') throw new Error('origin required');
  return origin.endsWith('*') ? origin : origin.replace(/\/?$/, '/') + '*';
}

function contentSettingName(permission) {
  const name = typeof permission === 'string' ? permission : permission && permission.name;
  return CONTENT_SETTING_BY_PERMISSION[name];
}

function settingFromCdp(setting) {
  if (setting === 'granted' || setting === 'allow') return 'allow';
  if (setting === 'denied' || setting === 'block') return 'block';
  if (setting === 'prompt' || setting === 'ask') return 'ask';
  throw new Error('unknown permission setting ' + setting);
}

async function grantPermissions(params) {
  if (!chrome.contentSettings) {
    throw new Error('Browser.grantPermissions requires the contentSettings permission');
  }
  const types = params.permissionTypes || [];
  const pattern = originPattern(params.origin);
  const unknown = types.filter((type) => {
    const cs = contentSettingName(type);
    return !cs || !chrome.contentSettings[cs];
  });
  if (unknown.length) {
    throw new Error('unsupported permission types over the extension: ' + unknown.join(', '));
  }
  for (const type of types) {
    const cs = contentSettingName(type);
    await chrome.contentSettings[cs].set({ primaryPattern: pattern, setting: 'allow' });
  }
  return {};
}

async function setPermission(params) {
  if (!chrome.contentSettings) {
    throw new Error('Browser.setPermission requires the contentSettings permission');
  }
  const cs = contentSettingName(params.permission);
  if (!cs || !chrome.contentSettings[cs]) {
    throw new Error('unsupported permission over the extension: ' + JSON.stringify(params.permission));
  }
  const pattern = originPattern(params.origin);
  await chrome.contentSettings[cs].set({
    primaryPattern: pattern,
    setting: settingFromCdp(params.setting),
  });
  return {};
}

async function resetPermissions() {
  if (!chrome.contentSettings) {
    throw new Error('Browser.resetPermissions requires the contentSettings permission');
  }
  for (const cs of Object.values(CONTENT_SETTING_BY_PERMISSION)) {
    if (!chrome.contentSettings[cs]) continue;
    try { await chrome.contentSettings[cs].clear({}); } catch { /* ignore */ }
  }
  return {};
}
