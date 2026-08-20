// AICheatCode · 后台 Service Worker v1.3.14
// 职责：找/开 Flow 标签页 → worker 池把每条提示词派给 content script → 下载（可建文件夹）→ 广播进度（含重试）
const DOWNLOAD_PREFIX = 'flow_';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let _stopRequested = false;
let _batchEndSent = false; // 防止 stop 时「handler 已发 batchEnd」与「workerLoop 结束再发一次」重复

// 取 n 个 Flow 标签页：优先复用已打开的，不够再新建（非激活）
async function getFlowTabs(n) {
  let tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' });
  while (tabs.length < n) {
    const t = await chrome.tabs.create({
      url: 'https://labs.google/fx/tools/flow',
      active: false,
    });
    tabs.push(t);
  }
  await sleep(3000); // 等 content script 注入 + 页面稳定
  return tabs.slice(0, n).map((t) => t.id);
}

// 连接类错误：内容脚本未注入 / 扩展刚被重载导致标签页里的脚本被卸载 / 页面已跳走
const CONNECTION_ERR = /Receiving end|does not exist|context invalidated|message port closed/i;

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

// ===== 真实屏幕输入引擎（Chrome DevTools Protocol）=====
// 之前的版本用 JS 合成的 dispatchEvent / execCommand 写框、点按钮，
// 但 Flow 这类前端框架会忽略“非受信(untrusted)”事件，导致屏幕“不动”。
// CDP 的 Input.insertText / Input.dispatchMouseEvent 发送的是与真人完全一致的“受信”输入，
// React 等框架无法区分，从而真正驱动 Flow。这正是商业插件“控制屏幕”的做法。

let _dbgAttached = new Set(); // 记录已 attach 的 tabId，避免重复 attach

function cdpAttach(tabId) {
  return new Promise((resolve, reject) => {
    if (_dbgAttached.has(tabId)) return resolve();
    chrome.debugger.attach({ tabId }, '1.3', () => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'debugger attach 失败'));
      else { _dbgAttached.add(tabId); resolve(); }
    });
  });
}
function cdpDetach(tabId) {
  return new Promise((resolve) => {
    if (!_dbgAttached.has(tabId)) return resolve();
    chrome.debugger.detach({ tabId }, () => {
      _dbgAttached.delete(tabId);
      resolve();
    });
  });
}
function cdpSend(tabId, method, params) {
  return new Promise((resolve, reject) => {
    chrome.debugger.sendCommand({ tabId }, method, params || {}, (res) => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || (method + ' 失败')));
      else resolve(res);
    });
  });
}

// 把提示词真正“敲”进某个坐标处的输入框：先点一下聚焦 → 全选并清空（兼容 Mac Cmd+A / Win Ctrl+A）→ insertText
async function cdpTypeInto(tabId, rect, text) {
  await cdpAttach(tabId);
  try {
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    // 1) 点进去聚焦
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(150);
    // 2) 全选（Mac 用 Meta/Cmd，Win 用 Ctrl，都发一遍更稳）+ 删除
    for (const mod of [4, 2]) {
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', modifiers: mod });
      await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', modifiers: mod });
    }
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyDown', key: 'Delete' });
    await cdpSend(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', key: 'Delete' });
    await sleep(120);
    // 3) 以受信方式整段插入（React 的 onInput 会触发，state 真正更新）
    await cdpSend(tabId, 'Input.insertText', { text });
    await sleep(200);
  } finally {
    await cdpDetach(tabId);
  }
}

// 在坐标处真正“按”一下按钮（受信鼠标事件，Flow 必响应）
async function cdpClickAt(tabId, rect) {
  await cdpAttach(tabId);
  try {
    const cx = Math.round(rect.x + rect.width / 2);
    const cy = Math.round(rect.y + rect.height / 2);
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
    await cdpSend(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
    await sleep(200);
  } finally {
    await cdpDetach(tabId);
  }
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
      if (attempt < maxRetries) {
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
          await downloadOne(res.items[k], `${DOWNLOAD_PREFIX}${job.index + 1}_${Date.now()}_${k + 1}.png`, options.folder, options.autoRename !== false);
        } catch (_) {}
      }
      notify({ type: 'itemDone', index: job.index, prompt: job.prompt, ok: true, count: res.items.length });
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

async function handleBatch(prompts, options = {}) {
  _stopRequested = false;
  _batchEndSent = false;
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
    notify({ type: 'error', error: '没找到 Flow 标签页。请先打开 https://labs.google/fx/tools/flow 并登录。' });
    return;
  }
  await sleep(1500);

  const queue = prompts.map((p, i) => ({ index: i, prompt: p }));
  const workers = tabIds.map((id) => workerLoop(id, queue, options, delayMs, randomDelayMs));
  await Promise.all(workers);

  notify({ type: 'batchEnd', stopped: _stopRequested });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg) return;

  if (msg.cmd === 'ping') {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  if (msg.cmd === 'startBatch') {
    handleBatch(msg.prompts || [], msg.options || {});
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === 'stopBatch') {
    _stopRequested = true;
    _batchEndSent = true;
    // 立刻恢复 UI：用户点停止后不应该还要等当前那条 generateOne 跑完（可能 20~180s）按钮才能用
    notify({ type: 'batchEnd', stopped: true });
    sendResponse({ ok: true });
    return true;
  }
  if (msg.cmd === 'cdpType') {
    // content script 已定位好输入框坐标，这里用真实输入把提示词敲进去
    const tabId = _sender.tab && _sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: '无标签页上下文' }); return true; }
    cdpTypeInto(tabId, msg.rect, msg.text)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
  if (msg.cmd === 'cdpClick') {
    const tabId = _sender.tab && _sender.tab.id;
    if (!tabId) { sendResponse({ ok: false, error: '无标签页上下文' }); return true; }
    cdpClickAt(tabId, msg.rect)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: false }).catch(() => {});
});
