// AICHeatCode · 后台 Service Worker v1.5.0
// 职责：找/开 Flow 标签页 → worker 池把每条提示词派给 content script → 下载（可建文件夹）→ 广播进度（含重试）
// v1.5.0：回归 chrome.debugger/CDP 真实输入引擎。证据：开源 Flow-Auto-Prompter / AutoFlow-Pro 均在
// Google Flow 上用 CDP 稳定驱动；用户也确认「能用时页面有 aicheatcode 正在调用页面 横幅」= 调试横幅，
// 它不会踢出页面。先前 v1.3.21/v1.4.2 误把该横幅当成 Flow 反调试而移除 CDP，是「越升级越不行」的根因。
// 由 background 持有 debugger，内容脚本通过消息请求 Input.insertText / Input.dispatchMouseEvent（硬件级，Slate/React 无法拦截）。
// v1.3.22：恢复 manifest 的 scripting 权限，侧边栏可在内容脚本失效时自动重新注入。
// v1.3.23：配合 content script 的 ping 版本回传，侧边栏自检可直接显示“内容脚本在线 / 版本 / scripting 权限”。
const DOWNLOAD_PREFIX = 'flow_';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// v1.5.6 下载命名修复：全局顺序编号（从 1 开始，补零）+ 保持可读文件名
let _dlSeq = 0;   // 全局下载序号，每批次在 handleBatch 启动时归零
let _dlPad = 3;   // 补零位数（按批次规模自适应，至少 3 位）

let _stopRequested = false;
let _batchEndSent = false; // 防止 stop 时「handler 已发 batchEnd」与「workerLoop 结束再发一次」重复
let _activeRunId = null;   // 只允许当前批次自己的停止指令终止它，避免旧面板/旧任务残留消息误杀新任务
const _cdpTrace = new Map(); // 每个 Flow 标签最近的后端/运行时错误；只保留诊断所需的少量事件

function traceCdp(tabId, line) {
  const list = _cdpTrace.get(tabId) || [];
  list.push('[' + new Date().toLocaleTimeString() + '] ' + line);
  if (list.length > 40) list.splice(0, list.length - 40);
  _cdpTrace.set(tabId, list);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const tabId = source && source.tabId;
  if (!tabId || !_dbgTabs.has(tabId)) return;
  if (method === 'Network.requestWillBeSent') {
    const r = params && params.request;
    if (r && r.method && r.method !== 'GET') {
      try { traceCdp(tabId, '请求 ' + r.method + ' ' + new URL(r.url).origin + new URL(r.url).pathname); } catch (_) {}
    }
  } else if (method === 'Network.responseReceived') {
    const r = params && params.response;
    if (r && r.status >= 400) traceCdp(tabId, 'HTTP ' + r.status + ' ' + (r.url || '').slice(0, 260));
    else if (r && /flow\.google|googleapis\.com/i.test(r.url || '')) {
      try { traceCdp(tabId, '响应 HTTP ' + r.status + ' ' + new URL(r.url).origin + new URL(r.url).pathname); } catch (_) {}
    }
  } else if (method === 'Network.loadingFailed') {
    traceCdp(tabId, '网络失败 ' + ((params && (params.errorText || params.blockedReason)) || '未知'));
  } else if (method === 'Log.entryAdded') {
    const e = params && params.entry;
    if (e && /error|warning/i.test(e.level || '')) traceCdp(tabId, '浏览器 ' + e.level + ': ' + (e.text || '').slice(0, 300));
  } else if (method === 'Runtime.exceptionThrown') {
    const d = params && params.exceptionDetails;
    traceCdp(tabId, '页面异常: ' + ((d && d.text) || '未知异常'));
  }
});

// 取 n 个 Flow 标签页：优先复用已打开的，不够再新建（非激活）
async function getFlowTabs(n) {
  const allTabs = await chrome.tabs.query({ url: ['https://labs.google/fx/*', 'https://flow.google/*', 'https://flow.google.com/*'] });
  // 不复用 /project/... 标签页：它可能正处在“编辑已有图片”模式，提示词框
  // 虽存在但并非文生图画布。批量文生图使用专门的 Flow 首页标签页。
  // v1.4.2：同时兼容新版入口 flow.google 与旧版 labs.google/fx/tools/flow（Google 已把 Flow 主入口迁到 flow.google）。
  let tabs = allTabs.filter((t) => /(^|\.)flow\.google(\/|$)|flow\.google\.com|\/tools\/flow/.test(t.url || ''));
  while (tabs.length < n) {
    const t = await chrome.tabs.create({
      url: 'https://flow.google',
      active: false,
    });
    tabs.push(t);
  }
  await sleep(3000); // 等 content script 注入 + 页面稳定
  return tabs.slice(0, n).map((t) => t.id);
}

// 连接类错误：内容脚本未注入 / 扩展刚被重载导致标签页里的脚本被卸载 / 页面已跳走
const CONNECTION_ERR = /Receiving end|does not exist|context invalidated|message port closed/i;

// ===== v1.5.0：回归 CDP（chrome.debugger）真实输入桥 =====
// 内容脚本没有 chrome.debugger 权限，故由后台持有 debugger 会话，内容脚本通过消息请求真实输入。
// CDP 的 Input.insertText / Input.dispatchMouseEvent 是「硬件级」输入，React/Slate 的
// 合成事件拦截与 trusted-events-only 防护都对它无效——这是唯一稳定写进 Slate React state 的方式。
// 参考：开源 Flow-Auto-Prompter（novri-ra）/ AutoFlow-Pro（lyquangthien）均如此驱动 Google Flow。
const _dbgTabs = new Set();
function dbgSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    try {
      chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'debugger error'));
        else resolve(res);
      });
    } catch (e) { reject(e); }
  });
}
async function dbgAttach(tabId) {
  if (_dbgTabs.has(tabId)) {
    try { await dbgSend(tabId, 'Runtime.evaluate', { expression: '1' }); return true; }
    catch (_) { try { await chrome.debugger.detach({ tabId }); } catch (e) {} _dbgTabs.delete(tabId); }
  }
  await chrome.debugger.attach({ tabId }, '1.3');
  _dbgTabs.add(tabId);
  _cdpTrace.set(tabId, []);
  // 不影响输入驱动；仅用于在“提示词消失却没出图”时给出 Google 的真实响应线索。
  await dbgSend(tabId, 'Network.enable', {}).catch(() => {});
  await dbgSend(tabId, 'Log.enable', {}).catch(() => {});
  await dbgSend(tabId, 'Runtime.enable', {}).catch(() => {});
  return true;
}
async function dbgDetach(tabId) {
  if (!_dbgTabs.has(tabId)) return;
  try { await chrome.debugger.detach({ tabId }); } catch (_) {}
  _dbgTabs.delete(tabId);
}
async function dbgDetachAll() { for (const id of Array.from(_dbgTabs)) await dbgDetach(id); }
async function dbgKey(tabId, key, code, modifiers) {
  await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key, code, modifiers: modifiers || 0 });
  await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key, code, modifiers: modifiers || 0 });
}
async function dbgClick(tabId, x, y) {
  // v1.5.9 修「点了没反应 / 回车也点了但什么都不发生」的真根因：
  // Flow 新版 React/ProseMirror handler 要求 mouseMoved 建立 hover 状态，否则会直接丢弃 click。
  // 该修复在第 2 轮加过、第 3 轮全量回滚时被误删，导致后续所有版本按钮点击都落空。
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'left', modifiers: 0 });
  await sleep(40);
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, modifiers: 0 });
  await sleep(60);
  await dbgSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, modifiers: 0 });
}
// 在指定坐标聚焦 Slate 编辑器，清空，再用 CDP 真实键入整段文本（Slate 视作真实用户输入）
async function cdpTypeInto(tabId, text, x, y) {
  await dbgAttach(tabId);
  await dbgClick(tabId, x, y);            // 聚焦编辑器
  await sleep(200);
  await dbgKey(tabId, 'a', 'KeyA', 2);    // Ctrl+A 全选
  await sleep(60);
  await dbgKey(tabId, 'Delete', 'Delete', 0);
  await sleep(60);
  await dbgSend(tabId, 'Input.insertText', { text }); // 硬件级键入
  await sleep(150);
}

function rawSend(tabId, msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.tabs.sendMessage(tabId, msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
        else resolve(resp);
      });
    } catch (e) {
      reject(e);
    }
  });
}

// 当发现内容脚本失效时，用 scripting API 把脚本重新注入到该标签页（自愈）。
async function injectContent(tabId) {
  try {
    await chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] });
    await sleep(800); // 等脚本注册好消息监听
    return true;
  } catch (_) {
    return false;
  }
}

// 发送消息；若因“接收端不存在”而失败，先尝试把内容脚本重新注入，再发一次。
async function sendToContent(tabId, msg, allowInject = true) {
  try {
    return await rawSend(tabId, msg);
  } catch (e) {
    if (allowInject && CONNECTION_ERR.test(String(e && e.message || e))) {
      const ok = await injectContent(tabId);
      if (ok) return await rawSend(tabId, msg, false);
    }
    throw e;
  }
}

function notify(msg) {
  chrome.runtime.sendMessage(msg).catch(() => {});
}

// v1.5.0：回归 CDP（chrome.debugger）真实输入。先前 v1.3.21/v1.4.2 误判 Flow 反调试而移除 CDP，
// 实际 CDP 横幅不会踢出页面（开源 Flow-Auto-Prompter 实证），且是唯一能写进 Slate React state 的输入方式。

// 在 item 之间重载 Flow 标签页，拿到全新画布（新版 Flow UI 无"新建项目"按钮，
// 重载是拿到干净画布、避免图生图链式漂移最稳妥的方式）。重载后 content script 会重新注入。
async function reloadTabForFresh(tabId) {
  try {
    await chrome.tabs.reload(tabId);
    await sleep(4000); // 等页面重载 + content script 重新注入并注册消息监听
  } catch (_) {}
}

async function downloadOne(item, filename, folder, autoRename) {
  let fname = filename;
  if (!autoRename) {
    // 关闭自动重命名：用更简洁的可读文件名（保留扩展名推断）
    fname = (folder ? folder.replace(/[\\/]+$/, '') + '/' : '') + filename.replace(/^\w+_/, '');
  } else if (folder) {
    fname = folder.replace(/[\\/]+$/, '') + '/' + filename;
  }
  const opts = { filename: fname, conflictAction: 'uniquify', saveAs: false };
  if (item.dataUrl) await chrome.downloads.download({ ...opts, url: item.dataUrl });
  else if (item.url) await chrome.downloads.download({ ...opts, url: item.url });
}

async function workerLoop(tabId, queue, options, delayMs, randomDelayMs) {
  const maxRetries = Math.max(0, options.maxRetries || 0);
  // 先做连通性自检：若内容脚本因“扩展被重载”而失效，这里会自动重新注入，免去用户手动刷新 Flow 页面
  await sendToContent(tabId, { cmd: 'ping' }).catch(() => {});
  while (queue.length && !_stopRequested) {
    const job = queue.shift();
    if (!job) break;
    notify({ type: 'itemStart', index: job.index, prompt: job.prompt, tabId });

    let res = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (_stopRequested) break;
      try {
        res = await sendToContent(tabId, { cmd: 'generate', prompt: job.prompt, options });
      } catch (e) {
        res = { ok: false, error: String((e && e.message) || e) };
      }
      if (res && res.ok) break;
      // 只有明确标记为可重试的短暂连接故障才重试；Flow 未启动生成、权限/额度/参数错误
      // 不能靠重复提交修好，盲重试既浪费时间也可能重复消耗点数。
      if (attempt < maxRetries && res && res.retryable === true) {
        notify({ type: 'itemRetry', index: job.index, attempt: attempt + 1, error: (res && res.error) || '' });
        await sleep(3000);
      }
    }

    // 把底层连接错误翻译成用户能直接照做的提示
    if (res && !res.ok && CONNECTION_ERR.test(res.error || '')) {
      res.error = '无法连接 Flow 页面：请刷新 Flow 标签页（F5 / Cmd+R），确认停在 /project/ 项目页并已登录，然后重新运行。';
    }

    if (res && res.ok && res.items && res.items.length) {
      for (let k = 0; k < res.items.length; k++) {
        try {
          const seq = ++_dlSeq; // 同步自增：并行多标签页也唯一、单调、不跳号
          const dlExt = (res.items[k].tag === 'video') ? 'mp4' : 'png'; // 图片按你选的统一 .png；视频用 .mp4 以免打不开
          const fname = String(seq).padStart(_dlPad, '0') + '.' + dlExt;
          await downloadOne(res.items[k], fname, options.folder, options.autoRename !== false);
        } catch (_) {}
      }
      notify({ type: 'itemDone', index: job.index, prompt: job.prompt, ok: true, count: res.items.length });
      // 新版 Flow UI + 需要全新画布的场景：在 item 之间重载，避免链式漂移
      if (res.needFreshCanvas && queue.length && !_stopRequested) {
        await reloadTabForFresh(tabId);
      }
    } else {
      notify({ type: 'itemDone', index: job.index, prompt: job.prompt, ok: false, error: (res && res.error) || '未捕获到结果', diagnostic: (res && res.diagnostic) || '' });
    }

    if (queue.length && !_stopRequested) {
      const extra = randomDelayMs ? Math.floor(Math.random() * randomDelayMs) : 0;
      await sleep(delayMs + extra);
    }
  }
  // 只有当 stopBatch 没抢先发过 batchEnd 时才发，避免重复（重复会让 UI 状态被覆盖成「全部完成」）
  if (!_batchEndSent) notify({ type: 'batchEnd', stopped: _stopRequested });
}

async function handleBatch(prompts, options = {}, runId = null) {
  _stopRequested = false;
  _batchEndSent = false;
  _activeRunId = runId;
  _dlSeq = 0; // 每批次归零，保证编号从 1 开始
  // 补零位数：按批次规模估算最大张数（每条提示词最多约 4 张变体），至少 3 位
  _dlPad = Math.max(3, String(Math.max(1, prompts.length) * 4).length);
  const concurrency = Math.max(1, Math.min(4, options.concurrency || 1));
  const delayMs = options.delayMs ?? 4000;
  const randomDelayMs = options.randomDelayMs ?? 0;

  // 立即给前端反馈：批量已开始
  notify({ type: 'batchStart', total: prompts.length, concurrency });

  let tabIds = [];
  try {
    tabIds = await getFlowTabs(concurrency);
  } catch (e) {
    notify({ type: 'error', error: '无法打开 Flow 标签页：' + ((e && e.message) || e) });
    return;
  }
  if (!tabIds.length) {
    notify({ type: 'error', error: '没找到 Flow 标签页。请先打开 https://flow.google（或 https://labs.google/fx/tools/flow）并登录。' });
    return;
  }
  await sleep(1500);
  // v1.5.0：批量开始即 attach CDP（调试横幅会出现，属正常；请勿点「取消」）
  const _attachErrors = [];
  for (const id of tabIds) {
    try { await dbgAttach(id); }
    catch (e) {
      const m = String((e && e.message) || e);
      _attachErrors.push(m);
      console.warn('[BG] CDP attach 失败，将退化为合成事件: ' + m);
    }
  }
  // v1.5.8 加固：若全部标签页都未能附加调试器，面板明确报错并给出可操作原因。
  // 否则用户只会看到“提示词进了框但不生成”的静默失败，无从下手。
  if (_attachErrors.length === tabIds.length) {
    notify({ type: 'error', error: '⚠️ CDP 调试器未能附加到任何 Flow 标签页（原因：' + _attachErrors[0] +
      '）。\n本扩展依赖 CDP 硬件级输入才能驱动新版 Flow；若未附加，新版 Flow 会静默拒绝合成事件 → 提示词进框但不生成。\n请检查：① Flow 标签页没有打开 DevTools(F12)（调试器冲突）② 扩展的「调试程序」权限已授予（chrome://extensions 里本扩展的“站点访问/权限”里允许）③ 扩展未被禁用。修复后重新运行。' });
    // 不要在 CDP 已明确不可用时继续让内容脚本走合成事件兜底：新版 Flow 会出现
    // “提示词可见却没有真正提交”的假成功，且用户无法从界面辨别。
    return;
  }

  const queue = prompts.map((p, i) => ({ index: i, prompt: p }));
  const workers = tabIds.map((id) => workerLoop(id, queue, options, delayMs, randomDelayMs));
  try {
    await Promise.all(workers);
  } finally {
    await dbgDetachAll().catch(() => {});
    _activeRunId = null;
  }

  notify({ type: 'batchEnd', stopped: _stopRequested });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.cmd === 'ping') {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  // v1.3.17: 面板侧 20s 心跳，防止 service worker 在长 batch 中被回收
  if (msg.cmd === 'heartbeat') {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  // v1.5.0：CDP 真实输入桥——内容脚本请求后台用 chrome.debugger 键入/点击
  if (msg.cmd === 'cdpAttach') {
    (async () => {
      const tabId = msg.tabId != null ? msg.tabId : (_sender && _sender.tab && _sender.tab.id);
      try { await dbgAttach(tabId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.cmd === 'cdpDetach') {
    (async () => {
      const tabId = msg.tabId != null ? msg.tabId : (_sender && _sender.tab && _sender.tab.id);
      try { await dbgDetach(tabId); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.cmd === 'cdpType') {
    (async () => {
      const tabId = _sender && _sender.tab && _sender.tab.id;
      if (!tabId) return sendResponse({ ok: false, error: 'no tab' });
      try { await cdpTypeInto(tabId, msg.text, msg.x, msg.y); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.cmd === 'cdpClick') {
    (async () => {
      const tabId = _sender && _sender.tab && _sender.tab.id;
      if (!tabId) return sendResponse({ ok: false, error: 'no tab' });
      try { await dbgAttach(tabId); await dbgClick(tabId, msg.x, msg.y); sendResponse({ ok: true }); }
      catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.cmd === 'cdpEnter') {
    (async () => {
      const tabId = _sender && _sender.tab && _sender.tab.id;
      if (!tabId) return sendResponse({ ok: false, error: 'no tab' });
      try {
        await dbgAttach(tabId);
        // 真实 Enter 键（焦点已在调用前通过 cdpClick 置于文本框）
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        await dbgSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
        sendResponse({ ok: true });
      } catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    })();
    return true;
  }
  if (msg.cmd === 'cdpDiagnostics') {
    const tabId = _sender && _sender.tab && _sender.tab.id;
    sendResponse({ ok: true, trace: tabId ? (_cdpTrace.get(tabId) || []) : [] });
    return true;
  }
  if (msg.cmd === 'startBatch') {
    handleBatch(msg.prompts || [], msg.options || {}, msg.runId || null);
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === 'stopBatch') {
    // 扩展重载、侧边栏重连或旧 popup 可能留下异步 stopBatch。没有匹配本次运行 ID 的
    // 指令一律忽略，不能再让一个旧任务把当前已经提交给 Flow 的任务中途终止。
    if (!msg.runId || !_activeRunId || msg.runId !== _activeRunId) {
      sendResponse({ ok: false, ignored: true, error: '已忽略不属于当前批次的停止指令' });
      return true;
    }
    _stopRequested = true;
    _batchEndSent = true;
    // 立刻恢复 UI：用户点停止后不应该还要等当前那条 generateOne 跑完（可能 20~180s）按钮才能用
    dbgDetachAll().catch(() => {});
    notify({ type: 'batchEnd', stopped: true });
    sendResponse({ ok: true });
    return true;
  }
  // v1.5.0：cdpType/cdpClick/cdpAttach/cdpDetach 已在上方处理（chrome.debugger 真实输入桥）。
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
  setupKeepalive();
});

// v1.3.17: MV3 service worker 30s 不活动会被回收 → 长间隔下消息链路断（第 4 张之后卡死）。
// 用 chrome.alarms 定时触发事件保持 worker 活跃；periodInMinutes 最小 0.5（30s），生产环境可能被节流到 1 分钟，仍比 30s 不活动超时安全得多。
function setupKeepalive() {
  try {
    chrome.alarms.create('aicheatcode-keepalive', { periodInMinutes: 0.5 });
  } catch (_) {}
}
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm && alarm.name === 'aicheatcode-keepalive') {
    // 只触发事件，不做任何事——目的就是让 service worker 保持活跃
  }
});
// 启动时也建一次闹钟（onInstalled 不一定每次都触发）
setupKeepalive();
