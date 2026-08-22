// AICheatCode · Popup v1.3.16（与面板一致视觉，紧凑单页）
const $ = (id) => document.getElementById(id);

const listEl = $('list');
const statusEl = $('status');
const connEl = $('conn');
const startBtn = $('start');
const stopBtn = $('stop');
const modeInput = $('mode');
const modeNote = $('modeNote');

let items = [];

const MODE_NOTES = {
  text2video: '',
  text2img: '',
  img2img: '图生图：当前版本按提示词生成，上传原图功能即将支持。',
  frame2video: '图生视频需上传图片，当前版本暂未实现上传，将按 Flow 默认处理。',
  ingredients: '成分动画需上传角色/组件图，当前版本暂未实现上传。',
  agent: 'Agent 自动化模式当前版本暂未实现，将按文生视频/图流程尝试。',
};

// 模式 chips
const SOON_MODES = ['frame2video', 'ingredients', 'agent'];
document.querySelectorAll('.mode-chip').forEach((c) => {
  c.addEventListener('click', () => {
    document.querySelectorAll('.mode-chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    modeInput.value = c.dataset.mode;
    modeNote.textContent = MODE_NOTES[c.dataset.mode] || '';
  });
});
modeNote.textContent = MODE_NOTES[modeInput.value] || '';

// 文件导入
const fileInput = $('fileInput');
$('uploadTxt').addEventListener('click', () => { fileInput.accept = '.txt'; fileInput.click(); });
$('uploadCsv').addEventListener('click', () => { fileInput.accept = '.csv,.txt'; fileInput.click(); });
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || '');
    if (f.name.toLowerCase().endsWith('.csv')) {
      text = text.split(/\r?\n/).map((ln) => (ln.split(',')[0] || '').trim()).join('\n');
    }
    const cur = $('prompts').value.trim();
    $('prompts').value = (cur ? cur + '\n' : '') + text.trim();
    setStatus('已从文件导入提示词', 'ok');
  };
  reader.readAsText(f);
  fileInput.value = '';
});

function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}
function setConn(state) {
  if (state === 'ok') { connEl.textContent = '已连接'; connEl.className = 'badge conn ok'; }
  else if (state === 'fail') { connEl.textContent = '后台无响应'; connEl.className = 'badge conn fail'; }
  else { connEl.textContent = '连接中…'; connEl.className = 'badge conn'; }
}
function renderItem(it) {
  const li = document.createElement('li');
  li.className = 'item ' + it.state;
  const dot = document.createElement('span'); dot.className = 'dot';
  const text = document.createElement('span'); text.className = 'text';
  text.textContent = `[${it.index + 1}] ${it.prompt}`;
  const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '✕';
  rm.addEventListener('click', () => {
    li.remove();
    if (!listEl.children.length) listEl.innerHTML = '<li class="empty">暂无任务</li>';
  });
  li.appendChild(dot); li.appendChild(text); li.appendChild(rm);
  listEl.appendChild(li);
  it.li = li; it.textEl = text;
}
function resetUi() {
  items = [];
  listEl.innerHTML = '';
  startBtn.disabled = false;
  stopBtn.disabled = true;
}
function readOptions() {
  return {
    mode: modeInput.value,
    aspectRatio: $('aspectRatio').value,
    videoModel: $('videoModel').value.trim(),
    imageModel: $('imageModel').value.trim(),
    model: $('videoModel').value.trim() || $('imageModel').value.trim(),
    duration: $('duration').value,
    count: parseInt($('count').value, 10) || 1,
    concurrency: parseInt($('concurrency').value, 10) || 1,
    randomDelayMs: (parseInt($('randomDelay').value, 10) || 0) * 1000,
    delayMs: 4000,
    maxRetries: parseInt($('maxRetries').value, 10) || 0,
    timeoutMs: 180000,
    newProject: $('newProject').checked,
    folder: $('folder').value.trim(),
    autoRename: $('autoRename').checked,
    charRef: null,
  };
}
function saveState() {
  try {
    chrome.storage.local.set({ prompts: $('prompts').value, opts: readOptions(), uiMode: modeInput.value });
  } catch (_) {}
}
function restoreState() {
  try {
    chrome.storage.local.get(['prompts', 'opts', 'uiMode'], (s) => {
      try {
        if (s && s.prompts) $('prompts').value = s.prompts;
        if (s && s.uiMode) {
          const chip = document.querySelector('.mode-chip[data-mode="' + s.uiMode + '"]');
          if (chip) chip.click();
        }
        if (s && s.opts) {
          const o = s.opts;
          const set = (id, v) => { const el = $(id); if (el && v !== undefined && v !== null) el.value = v; };
          const setCheck = (id, v) => { const el = $(id); if (el && typeof v === 'boolean') el.checked = v; };
          set('aspectRatio', o.aspectRatio); set('videoModel', o.videoModel); set('imageModel', o.imageModel);
          set('duration', o.duration); set('count', o.count); set('concurrency', o.concurrency);
          set('randomDelay', o.randomDelayMs ? Math.round(o.randomDelayMs / 1000) : undefined);
          set('maxRetries', o.maxRetries); set('newProject', undefined);
          setCheck('newProject', o.newProject); set('folder', o.folder); setCheck('autoRename', o.autoRename);
        }
      } catch (_) {}
    });
  } catch (_) {}
}
restoreState();

setConn('pending');
function pingBg(cb) {
  let done = false;
  const t = setTimeout(() => { if (!done) { done = true; cb(false); } }, 2000);
  try {
    chrome.runtime.sendMessage({ cmd: 'ping' }, (resp) => {
      if (done) return;
      done = true; clearTimeout(t);
      cb(!!(resp && resp.ok));
    });
  } catch (e) { if (!done) { done = true; clearTimeout(t); cb(false); } }
}
pingBg((ok) => setConn(ok ? 'ok' : 'fail'));

startBtn.addEventListener('click', () => {
  setStatus('已点击，正在启动…', 'busy');
  try {
    const text = $('prompts').value.trim();
    if (!text) { setStatus('请输入提示词（每行一条，空行分隔多条）', 'err'); return; }
    const prompts = text.split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
    if (!prompts.length) { setStatus('没有有效的提示词', 'err'); return; }

    resetUi();
    prompts.forEach((p, i) => items.push({ index: i, prompt: p, state: 'pending' }));
    items.forEach(renderItem);
    startBtn.disabled = true;
    stopBtn.disabled = false;
    saveState();

    chrome.runtime.sendMessage(
      { cmd: 'startBatch', prompts, options: readOptions() },
      (resp) => {
        if (chrome.runtime.lastError || !resp || !resp.ok) {
          setStatus('连不上后台。请到 chrome://extensions 找到「AICheatCode」点 🔄 刷新后再试。', 'err');
          setConn('fail');
          startBtn.disabled = false;
          stopBtn.disabled = true;
        } else { setConn('ok'); }
      }
    );
  } catch (e) {
    setStatus('启动失败：' + ((e && e.message) || e), 'err');
    startBtn.disabled = false; stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', () => {
  setStatus('已请求停止…');
  try { chrome.runtime.sendMessage({ cmd: 'stopBatch' }); } catch (_) {}
});

$('openPanel').addEventListener('click', async () => {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) await chrome.sidePanel.open({ tabId: tab.id });
  } catch (e) { setStatus('无法打开侧边栏：' + ((e && e.message) || e), 'err'); }
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'batchStart') {
    setStatus(`共 ${msg.total} 张 · 并行 ${msg.concurrency || 1}`, 'busy'); setConn('ok');
  } else if (msg.type === 'itemStart') {
    const it = items[msg.index];
    if (it) { it.state = 'running'; if (it.li) it.li.className = 'item running'; }
    setStatus(`生成中 ${msg.index + 1}/${items.length}`, 'busy');
  } else if (msg.type === 'itemRetry') {
    const it = items[msg.index];
    if (it) { it.state = 'running'; if (it.li) it.li.className = 'item running'; }
    setStatus(`第${msg.index + 1}条重试(${msg.attempt})…`, 'busy');
  } else if (msg.type === 'itemDone') {
    const it = items[msg.index];
    if (it) {
      it.state = msg.ok ? 'done' : 'failed';
      if (it.li) it.li.className = 'item ' + it.state;
      if (it.textEl) {
        const suffix = msg.ok ? `✓ ${msg.count} 张` : `✗ ${msg.error || ''}`;
        it.textEl.textContent = `[${msg.index + 1}] ${it.prompt} — ${suffix}`;
      }
    }
    setStatus(msg.ok ? `完成 ${msg.index + 1}/${items.length}` : `失败 ${msg.index + 1}`, msg.ok ? 'busy' : 'err');
  } else if (msg.type === 'batchEnd') {
    startBtn.disabled = false; stopBtn.disabled = true;
    setStatus(msg.stopped ? '已停止' : '全部完成 ✓', msg.stopped ? '' : 'ok');
  } else if (msg.type === 'error') {
    startBtn.disabled = false; stopBtn.disabled = true;
    setStatus('错误：' + msg.error, 'err'); setConn('fail');
  }
});
