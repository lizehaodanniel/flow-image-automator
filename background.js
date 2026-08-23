// AICheatCode · 后台 Service Worker v1.3.23
// 职责：找/开 Flow 标签页 → worker 池把每条提示词派给 content script → 下载（可建文件夹）→ 广播进度（含重试）
// v1.3.21：移除 chrome.debugger/CDP 真实输入引擎（其触发 Flow 反调试、页面被踢出）。驱动改由 content script 纯合成事件完成。
// v1.3.22：恢复 manifest 的 scripting 权限，侧边栏可在内容脚本失效时自动重新注入。
// v1.3.23：配合 content script 的 ping 版本回传，侧边栏自检可直接显示“内容脚本在线 / 版本 / scripting 权限”。
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

// v1.3.21: 已彻底移除「真实屏幕输入引擎（Chrome DevTools Protocol / chrome.debugger）」。
// 原因：Flow 有反调试机制，一旦 attach debugger 页面就会闪「已经开始调试此浏览器」并踢出/重载，导致扩展「不动」。
// 现回归 v1.6/v1.7 的纯合成事件驱动方案（内容脚本用 .click() / execCommand / KeyboardEvent），实测可用。

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
  // v1.3.17: 面板侧 20s 心跳，防止 service worker 在长 batch 中被回收
  if (msg.cmd === 'heartbeat') {
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
  // v1.3.21: 已移除 cmd:'cdpType' / cmd:'cdpClick' 处理（CDP 触发 Flow 反调试，导致页面被踢出）。驱动改回纯合成事件。
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
