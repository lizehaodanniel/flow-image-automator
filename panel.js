// AICheatCode · Side Panel v1.3.17（中英文双语 · 控制/设置 双标签）
const $ = (id) => document.getElementById(id);

const listEl = $('list');
const statusEl = $('status');
const connEl = $('conn');
const startBtn = $('start');
const stopBtn = $('stop');
const modeInput = $('mode');
const modeNote = $('modeNote');

let items = [];
let selectedImages = []; // 图生视频/成分动画的素材图片（{name,dataUrl}），仅内存保存，不写 storage（避免配额超限）

// ===================== 多语言（中文 / English）=====================
// 一个 key 对应两种语言；t(key) 取当前语言，缺失时回退中文，再缺失回退 key 本身。
let lang = 'zh';
const I18N = {
  zh: {
    'app.title': 'AICheatCode',
    'app.subtitle': 'Google Flow 自动化 · 免费自托管版',
    'conn.connecting': '连接中…',
    'conn.ok': '已连接',
    'conn.fail': '后台无响应',
    'diag.btn': '🔍 复制页面诊断',
    'diag.title': '把 Flow 页面结构复制到剪贴板，出问题时贴给开发者排查',
    'plan.tag': '免费版',
    'plan.note': '无需登录 · 本地运行',
    'tab.control': '控制',
    'tab.settings': '设置',
    'sec.mode': '生成模式',
    'mode.text2video': '文生视频',
    'mode.frame2video': '图生视频',
    'mode.ingredients': '成分动画',
    'mode.text2img': '文生图',
    'mode.img2img': '图生图',
    'mode.agent': 'Agent',
    'soon.tag': '即将支持',
    'sec.prompts': '提示词',
    'prompts.ph': '每行一条提示词（可直接粘贴多行，或导入 .txt/.csv）：\n一只戴帽子的猫，水彩风格\n赛博朋克城市夜景，霓虹灯',
    'upload.txt': '上传 .txt',
    'upload.csv': '上传 .csv',
    'hint.import': '支持从文件批量导入提示词',
    'sec.assets': '素材图片',
    'assets.hint': '（图生视频=起始图 1 张；成分动画=角色/组件图 多张）',
    'pick.images': '选择图片…',
    'clear': '清空',
    'asset.empty': '未选择素材（图生视频/成分动画需要）',
    'folder.label': '保存文件夹（留空=默认下载目录）',
    'folder.ph': '例如 my-project',
    'autorename': '自动重命名',
    'run': '运行 ▶',
    'stop': '停止',
    'status.ready': '就绪。先打开并登录 Google Flow 项目页。',
    'sec.queue': '提示词队列',
    'queue.empty': '暂无任务',
    'set.general': '通用',
    'set.model': '模型',
    'set.modeopt': '模式专项',
    'set.download': '下载与高级',
    'opt.mode': '默认模式',
    'opt.aspect': '画幅比例',
    'opt.count': '每条数量',
    'opt.concurrency': '并行标签页',
    'opt.randdelay': '随机延迟(秒)',
    'opt.faildelay': '失败间隔(秒)',
    'opt.vmodel': '视频模型',
    'opt.imodel': '图片模型',
    'opt.duration': '视频时长',
    'opt.imagemode': '图片模式',
    'opt.retries': '最大重试',
    'opt.timeout': '超时(秒)',
    'newproject': '每条提示词新建项目',
    'aspect.default': '不指定（用 Flow 默认）',
    'aspect.169': '16:9（横）',
    'aspect.916': '9:16（竖）',
    'aspect.11': '1:1（方）',
    'aspect.34': '3:4',
    'aspect.43': '4:3',
    'vmodel.default': '不指定（Flow 默认）',
    'imodel.default': '不指定（Flow 默认）',
    'dur.default': '不指定',
    'dur.4s': '4 秒',
    'dur.6s': '6 秒',
    'dur.8s': '8 秒',
    'dur.10s': '10 秒',
    'dur.concat': 'Concat（拼接）',
    'imagemode.new': '新图',
    'imagemode.last': '沿用上一张',
    'dl.warn': '⚠️ Chrome 设置 → 下载 → 关掉「下载前询问每个文件的保存位置」，否则自动下载会卡住。',
    'note.text2video': '',
    'note.text2img': '',
    'note.img2img': '图生图：可配合「角色参考图」固定人物，每张图都以参考图人物为基准生成。',
    'note.frame2video': '图生视频：本扩展会自动把你在「素材图片」里选的起始图上传到 Flow，再生成。每张提示词用同一张起始图。',
    'note.ingredients': '成分动画：本扩展会自动把你在「素材图片」里选的角色/组件图上传到 Flow，再合成视频。可一次选多张。',
    'note.agent': 'Agent 自动化模式当前版本暂未实现，将按文生视频/图流程尝试。',
    'soon.warn': '该模式当前尚未支持，请改用 文生图 / 文生视频 / 图生图。',
    'st.clicked': '已点击，正在启动…',
    'st.noPrompt': '请输入提示词（每行一条，可导入 .txt/.csv）',
    'st.noValid': '没有有效的提示词',
    'st.imported': '已从文件导入提示词',
    'st.cleared': '已清空素材图片',
    'st.assetTooBig': '素材图片总大小超过 ~7MB，可能导致发送失败，建议精简后再试。',
    'st.added': '已添加 {n} 张素材图片',
    'st.connFail': '连不上后台。请到 chrome://extensions 找到「AICheatCode」点 🔄 刷新后再试。',
    'st.startFail': '启动失败：{e}',
    'st.stopReq': '已请求停止…',
    'st.reading': '正在读取 Flow 页面结构…',
    'st.noFlow': '没找到 Flow 标签页（请先打开并登录 Flow 项目页）',
    'st.readFail': '读取失败：{e}',
    'st.diagCopied': '✓ 页面诊断已复制到剪贴板，请直接粘贴给开发者',
    'st.diagNoCopy': '已读取诊断，但无法自动复制，请按 Cmd+Alt+I 打开控制台复制',
    'st.diagFail': '读取失败：{e} 请刷新扩展与 Flow 页面后再试',
    'st.batchStart': '共 {n} 张 · 并行 {c}',
    'st.generating': '生成中 {i}/{n}',
    'st.retry': '第{i}条重试({a})…',
    'st.done': '完成 {i}/{n}',
    'st.failed': '失败 {i}',
    'st.stopped': '已停止',
    'st.allDone': '全部完成 ✓',
    'st.error': '错误：{e}',
    'copyDiag': '复制诊断',
    'copied': '已复制 ✓',
    'copyFail': '复制失败',
    'remove': '移除',
    'sec.charref': '角色参考图',
    'charref.hintshort': '固定人物：所有批量图都以这张图的人物为基准',
    'charref.on': '启用角色固定（视觉一致）',
    'charref.pick': '选择参考图…',
    'charref.clear': '清除',
    'charref.hint': '启用后模式自动切到「图生图」，每张图用此参考图作为基准，人物保持一致。参考图建议用清晰、正面、光照均匀的全身或半身照。',
    'st.charrefCleared': '已清除角色参考图',
    'st.charrefAdded': '已设置角色参考图：{n}',
    'st.charrefFail': '参考图读取失败',
    'st.charrefTooBig': '图片超过 5MB，可能无法长期保存（扩展存储上限）。建议压缩到 2MB 以内。',
  },
  en: {
    'app.title': 'AICheatCode',
    'app.subtitle': 'Google Flow automation · free, self-hosted',
    'conn.connecting': 'Connecting…',
    'conn.ok': 'Connected',
    'conn.fail': 'Background not responding',
    'diag.btn': '🔍 Copy page diagnostic',
    'diag.title': 'Copy Flow page structure to clipboard; paste it to the developer when something breaks',
    'plan.tag': 'Free',
    'plan.note': 'No login · Runs locally',
    'tab.control': 'Control',
    'tab.settings': 'Settings',
    'sec.mode': 'Generation mode',
    'mode.text2video': 'Text to Video',
    'mode.frame2video': 'Frame to Video',
    'mode.ingredients': 'Ingredients',
    'mode.text2img': 'Text to Image',
    'mode.img2img': 'Image to Image',
    'mode.agent': 'Agent',
    'soon.tag': 'Soon',
    'sec.prompts': 'Prompts',
    'prompts.ph': 'One prompt per line (paste multiple lines, or import .txt/.csv):\nA cat wearing a hat, watercolor style\nCyberpunk city night, neon lights',
    'upload.txt': 'Upload .txt',
    'upload.csv': 'Upload .csv',
    'hint.import': 'Batch import prompts from a file',
    'sec.assets': 'Source images',
    'assets.hint': '(Frame-to-video: 1 start image; Ingredients: multiple character/component images)',
    'pick.images': 'Select images…',
    'clear': 'Clear',
    'asset.empty': 'No assets selected (needed for frame-to-video / ingredients)',
    'folder.label': 'Save folder (blank = default download dir)',
    'folder.ph': 'e.g. my-project',
    'autorename': 'Auto-rename',
    'run': 'Run ▶',
    'stop': 'Stop',
    'status.ready': 'Ready. Open and sign in to a Google Flow project page first.',
    'sec.queue': 'Prompt queue',
    'queue.empty': 'No tasks yet',
    'set.general': 'General',
    'set.model': 'Model',
    'set.modeopt': 'Mode options',
    'set.download': 'Download & advanced',
    'opt.mode': 'Default mode',
    'opt.aspect': 'Aspect ratio',
    'opt.count': 'Count per prompt',
    'opt.concurrency': 'Parallel tabs',
    'opt.randdelay': 'Random delay (s)',
    'opt.faildelay': 'Retry interval (s)',
    'opt.vmodel': 'Video model',
    'opt.imodel': 'Image model',
    'opt.duration': 'Video duration',
    'opt.imagemode': 'Image mode',
    'opt.retries': 'Max retries',
    'opt.timeout': 'Timeout (s)',
    'newproject': 'New project per prompt',
    'aspect.default': 'Default (Flow default)',
    'aspect.169': '16:9 (landscape)',
    'aspect.916': '9:16 (portrait)',
    'aspect.11': '1:1 (square)',
    'aspect.34': '3:4',
    'aspect.43': '4:3',
    'vmodel.default': 'Default (Flow default)',
    'imodel.default': 'Default (Flow default)',
    'dur.default': 'None',
    'dur.4s': '4s',
    'dur.6s': '6s',
    'dur.8s': '8s',
    'dur.10s': '10s',
    'dur.concat': 'Concat',
    'imagemode.new': 'New',
    'imagemode.last': 'Last one',
    'dl.warn': '⚠️ Chrome Settings → Downloads → turn OFF "Ask where to save each file", otherwise auto-download stalls.',
    'note.text2video': '',
    'note.text2img': '',
    'note.img2img': 'Image to Image: pair with "Character reference" to lock a person; every image is generated from that reference as the base.',
    'note.frame2video': 'Frame to Video: this extension auto-uploads the start image you picked in "Source images", then generates. Each prompt uses the same start image.',
    'note.ingredients': 'Ingredients: this extension auto-uploads the character/component images you picked in "Source images", then composites them into a video. Pick multiple.',
    'note.agent': 'Agent mode is not implemented yet; falls back to text-to-video/image flow.',
    'soon.warn': 'This mode is not supported yet. Use Text to Image / Text to Video / Image to Image.',
    'st.clicked': 'Clicked, starting…',
    'st.noPrompt': 'Please enter a prompt (one per line; you can import .txt/.csv)',
    'st.noValid': 'No valid prompt',
    'st.imported': 'Imported prompts from file',
    'st.cleared': 'Cleared source images',
    'st.assetTooBig': 'Source images exceed ~7MB total; sending may fail. Please slim them down.',
    'st.added': 'Added {n} source image(s)',
    'st.connFail': 'Cannot reach background. Go to chrome://extensions, find "AICheatCode", click 🔄 to reload, then retry.',
    'st.startFail': 'Start failed: {e}',
    'st.stopReq': 'Stop requested…',
    'st.reading': 'Reading Flow page structure…',
    'st.noFlow': 'No Flow tab found (open and sign in to a Flow project page first)',
    'st.readFail': 'Read failed: {e}',
    'st.diagCopied': '✓ Page diagnostic copied to clipboard; paste it to the developer',
    'st.diagNoCopy': 'Diagnostic read, but auto-copy failed. Press Cmd+Alt+I to open the console and copy',
    'st.diagFail': 'Read failed: {e} please reload the extension and Flow page, then retry',
    'st.batchStart': '{n} items · parallel {c}',
    'st.generating': 'Generating {i}/{n}',
    'st.retry': 'Retry #{a} for item {i}…',
    'st.done': 'Done {i}/{n}',
    'st.failed': 'Failed {i}',
    'st.stopped': 'Stopped',
    'st.allDone': 'All done ✓',
    'st.error': 'Error: {e}',
    'copyDiag': 'Copy diagnostic',
    'copied': 'Copied ✓',
    'copyFail': 'Copy failed',
    'remove': 'Remove',
    'sec.charref': 'Character reference',
    'charref.hintshort': 'Fix the character: every batch image uses this person as the base',
    'charref.on': 'Enable character lock (visual consistency)',
    'charref.pick': 'Select reference…',
    'charref.clear': 'Clear',
    'charref.hint': 'When enabled, mode switches to Image-to-Image automatically; every image uses this reference as the base so the person stays consistent. Use a clear, front-facing, evenly-lit full or half body shot.',
    'st.charrefCleared': 'Cleared character reference',
    'st.charrefAdded': 'Character reference set: {n}',
    'st.charrefFail': 'Failed to read reference image',
    'st.charrefTooBig': 'Image over 5MB may not persist (storage limit). Resize to under 2MB recommended.',
  },
};

// 取词：t(key) 或 t(key, {n:1}) 做简单 {n} 占位替换
function t(key, vars) {
  let s = (I18N[lang] && I18N[lang][key]) || (I18N.zh && I18N.zh[key]) || key;
  if (vars) s = String(s).replace(/\{(\w+)\}/g, (m, k) => (vars[k] !== undefined ? vars[k] : m));
  return s;
}

// 应用语言：刷新所有带 data-i18n / data-i18n-ph / data-i18n-title 的元素，并持久化
function applyLang(l) {
  lang = l;
  document.documentElement.lang = (l === 'en') ? 'en' : 'zh-CN';
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const k = el.getAttribute('data-i18n');
    if (k) el.textContent = t(k);
  });
  document.querySelectorAll('[data-i18n-ph]').forEach((el) => {
    const k = el.getAttribute('data-i18n-ph');
    if (k) el.placeholder = t(k);
  });
  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const k = el.getAttribute('data-i18n-title');
    if (k) el.title = t(k);
  });
  if (modeNote) modeNote.textContent = t('note.' + modeInput.value) || '';
  try { chrome.storage.local.set({ lang: l }); } catch (_) {}
}

// ---------- 标签切换 ----------
document.querySelectorAll('.tab').forEach((tbtn) => {
  tbtn.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('active'));
    document.querySelectorAll('.tab-pane').forEach((x) => x.classList.remove('active'));
    tbtn.classList.add('active');
    $('tab-' + tbtn.dataset.tab).classList.add('active');
  });
});

// ---------- 模式 chips ----------
// 仅 Agent 模式尚未实现（需要自动多步推理，暂未支持）。图生视频 / 成分动画已开放。
const SOON_MODES = ['agent'];
document.querySelectorAll('.mode-chip').forEach((c) => {
  c.addEventListener('click', () => {
    if (SOON_MODES.includes(c.dataset.mode)) {
      setStatus(t('soon.warn'), 'warn');
      return;
    }
    document.querySelectorAll('.mode-chip').forEach((x) => x.classList.remove('active'));
    c.classList.add('active');
    modeInput.value = c.dataset.mode;
    modeNote.textContent = t('note.' + c.dataset.mode) || '';
    if (typeof setModeSel !== 'undefined' && setModeSel) setModeSel.value = modeInput.value;
  });
});
// 初始化提示
modeNote.textContent = t('note.' + modeInput.value) || '';

// 设置页「默认模式」与模式 chips 双向联动
const setModeSel = $('setMode');
if (setModeSel) {
  setModeSel.value = modeInput.value;
  setModeSel.addEventListener('change', () => {
    const chip = document.querySelector('.mode-chip[data-mode="' + setModeSel.value + '"]');
    if (chip) chip.click();
  });
}

// ---------- 文件导入（.txt / .csv） ----------
const fileInput = $('fileInput');
$('uploadTxt').addEventListener('click', () => { fileInput.accept = '.txt'; fileInput.click(); });
$('uploadCsv').addEventListener('click', () => { fileInput.accept = '.csv,.txt'; fileInput.click(); });
fileInput.addEventListener('change', () => {
  const f = fileInput.files && fileInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    let text = String(reader.result || '');
    // csv 取第一列非空内容，按行拆分
    if (f.name.toLowerCase().endsWith('.csv')) {
      text = text.split(/\r?\n/).map((ln) => {
        const col = ln.split(',')[0];
        return col ? col.trim() : '';
      }).join('\n');
    }
    const cur = $('prompts').value.trim();
    $('prompts').value = (cur ? cur + '\n' : '') + text.trim();
    setStatus(t('st.imported'), 'ok');
  };
  reader.readAsText(f);
  fileInput.value = '';
});

// ---------- 素材图片（图生视频 / 成分动画 需要）----------
const imageInput = $('imageInput');
$('pickImages').addEventListener('click', () => { imageInput.click(); });
$('clearImages').addEventListener('click', () => { selectedImages = []; renderAssetList(); setStatus(t('st.cleared'), 'ok'); });
imageInput.addEventListener('change', () => {
  const files = Array.from(imageInput.files || []);
  if (!files.length) return;
  let totalBytes = selectedImages.reduce((s, x) => s + (x.bytes || 0), 0);
  const readers = files.map((f) => new Promise((res) => {
    const r = new FileReader();
    r.onload = () => res({ name: f.name, dataUrl: String(r.result || ''), bytes: f.size });
    r.onerror = () => res(null);
    r.readAsDataURL(f);
  }));
  Promise.all(readers).then((arr) => {
    const ok = arr.filter(Boolean);
    for (const x of ok) {
      totalBytes += x.bytes;
      if (totalBytes > 7 * 1024 * 1024) { setStatus(t('st.assetTooBig'), 'warn'); break; }
      selectedImages.push(x);
    }
    renderAssetList();
    setStatus(t('st.added', { n: selectedImages.length }), 'ok');
  });
  imageInput.value = '';
});
function renderAssetList() {
  const el = $('assetList');
  if (!el) return;
  if (!selectedImages.length) { el.innerHTML = '<div class="asset-empty">' + t('asset.empty') + '</div>'; return; }
  el.innerHTML = '';
  selectedImages.forEach((im, i) => {
    const wrap = document.createElement('div'); wrap.className = 'asset-thumb';
    const img = document.createElement('img'); img.src = im.dataUrl; img.title = im.name;
    const name = document.createElement('span'); name.className = 'asset-name'; name.textContent = im.name;
    const rm = document.createElement('button'); rm.className = 'asset-rm'; rm.textContent = '✕'; rm.title = t('remove');
    rm.addEventListener('click', () => { selectedImages.splice(i, 1); renderAssetList(); });
    wrap.appendChild(img); wrap.appendChild(name); wrap.appendChild(rm);
    el.appendChild(wrap);
  });
}
renderAssetList();

// ---------- 角色参考图（固定人物 / 视觉一致）----------
const charRefInput = $('charRefInput');
const charRefOn = $('charRefOn');
let charRef = null; // {name, dataUrl, bytes}

function renderCharRefPreview() {
  const el = $('charRefPreview');
  if (!el) return;
  if (!charRef) { el.innerHTML = ''; return; }
  el.innerHTML = '';
  const wrap = document.createElement('div'); wrap.className = 'asset-thumb';
  const img = document.createElement('img'); img.src = charRef.dataUrl; img.title = charRef.name;
  const name = document.createElement('span'); name.className = 'asset-name'; name.textContent = charRef.name;
  wrap.appendChild(img); wrap.appendChild(name);
  el.appendChild(wrap);
}

$('pickCharRef').addEventListener('click', () => { charRefInput.click(); });
$('clearCharRef').addEventListener('click', () => { charRef = null; charRefInput.value = ''; renderCharRefPreview(); setStatus(t('st.charrefCleared'), 'ok'); });
charRefInput.addEventListener('change', () => {
  const f = charRefInput.files && charRefInput.files[0];
  if (!f) return;
  const reader = new FileReader();
  reader.onload = () => {
    charRef = { name: f.name, dataUrl: String(reader.result || ''), bytes: f.size };
    renderCharRefPreview();
    if (f.size > 5 * 1024 * 1024) {
      setStatus(t('st.charrefAdded', { n: f.name }) + ' ⚠️ ' + t('st.charrefTooBig'), 'warn');
    } else {
      setStatus(t('st.charrefAdded', { n: f.name }), 'ok');
    }
  };
  reader.onerror = () => setStatus(t('st.charrefFail'), 'err');
  reader.readAsDataURL(f);
  charRefInput.value = '';
});

// 勾选「启用角色固定」时，自动把模式切到图生图，让用户直观看到生效
function syncCharRefMode() {
  if (charRefOn.checked && charRef) {
    const chip = document.querySelector('.mode-chip[data-mode="img2img"]');
    if (chip && modeInput.value !== 'img2img') chip.click();
    modeNote.textContent = t('note.img2img');
  }
}
charRefOn.addEventListener('change', syncCharRefMode);

// ---------- 状态 / 队列 ----------
function setStatus(text, cls) {
  statusEl.textContent = text;
  statusEl.className = 'status ' + (cls || '');
}
function setConn(state) {
  if (state === 'ok') { connEl.textContent = t('conn.ok'); connEl.className = 'badge conn ok'; }
  else if (state === 'fail') { connEl.textContent = t('conn.fail'); connEl.className = 'badge conn fail'; }
  else { connEl.textContent = t('conn.connecting'); connEl.className = 'badge conn'; }
}
function renderItem(it) {
  const li = document.createElement('li');
  li.className = 'item ' + it.state;
  const dot = document.createElement('span'); dot.className = 'dot';
  const text = document.createElement('span'); text.className = 'text';
  text.textContent = `[${it.index + 1}] ${it.prompt}`;
  const rm = document.createElement('button'); rm.className = 'rm'; rm.textContent = '✕'; rm.title = t('remove');
  rm.addEventListener('click', () => {
    li.remove();
    if (!listEl.children.length) listEl.innerHTML = '<li class="empty">' + t('queue.empty') + '</li>';
  });
  li.appendChild(dot); li.appendChild(text); li.appendChild(rm);
  // 失败诊断区：可折叠、可复制
  const diag = document.createElement('pre'); diag.className = 'diag'; diag.hidden = true;
  const copyDiag = document.createElement('button'); copyDiag.className = 'copy-diag'; copyDiag.textContent = t('copyDiag');
  copyDiag.addEventListener('click', () => {
    const tx = diag.textContent || '';
    try { navigator.clipboard.writeText(tx); copyDiag.textContent = t('copied'); setTimeout(() => { copyDiag.textContent = t('copyDiag'); }, 1500); }
    catch (_) { copyDiag.textContent = t('copyFail'); }
  });
  const diagWrap = document.createElement('div'); diagWrap.className = 'diag-wrap'; diagWrap.hidden = true;
  diagWrap.appendChild(copyDiag); diagWrap.appendChild(diag);
  li.appendChild(diagWrap);
  listEl.appendChild(li);
  it.li = li; it.textEl = text; it.diagEl = diag; it.diagWrapEl = diagWrap;
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
    imageMode: $('imageMode').value,
    count: parseInt($('count').value, 10) || 1,
    concurrency: parseInt($('concurrency').value, 10) || 1,
    randomDelayMs: (parseInt($('randomDelay').value, 10) || 0) * 1000,
    delayMs: (parseInt($('delay').value, 10) || 4) * 1000,
    maxRetries: parseInt($('maxRetries').value, 10) || 0,
    timeoutMs: (parseInt($('timeout').value, 10) || 180) * 1000,
    newProject: $('newProject').checked,
    folder: $('folder').value.trim(),
    autoRename: $('autoRename').checked,
    images: selectedImages.map((x) => x.dataUrl), // 图生视频/成分动画的素材（仅本次运行使用，不持久化）
    charRef: (charRefOn.checked && charRef) ? charRef.dataUrl : null, // 角色参考图（仅本次运行使用，base64 体积大不进 opts）
  };
}
function saveState() {
  try {
    const opts = readOptions();
    delete opts.images; // 素材图片（base64）体积大，不写入 storage，避免超出配额
    chrome.storage.local.set({
      prompts: $('prompts').value,
      opts: opts,
      uiMode: modeInput.value,
      charRef: (charRefOn.checked && charRef) ? charRef : null,
      charRefOn: charRefOn.checked,
    });
  } catch (_) {}
}
function restoreState() {
  try {
    chrome.storage.local.get(['prompts', 'opts', 'uiMode', 'charRef', 'charRefOn'], (s) => {
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
          set('aspectRatio', o.aspectRatio);
          set('videoModel', o.videoModel); set('imageModel', o.imageModel);
          set('duration', o.duration); set('imageMode', o.imageMode);
          set('count', o.count); set('concurrency', o.concurrency);
          set('randomDelay', o.randomDelayMs ? Math.round(o.randomDelayMs / 1000) : undefined);
          set('delay', o.delayMs ? Math.round(o.delayMs / 1000) : undefined);
          set('maxRetries', o.maxRetries); set('timeout', o.timeoutMs ? Math.round(o.timeoutMs / 1000) : undefined);
          setCheck('newProject', o.newProject); set('folder', o.folder); setCheck('autoRename', o.autoRename);
          if (s && s.charRef) { charRef = s.charRef; renderCharRefPreview(); }
          if (s && typeof s.charRefOn === 'boolean') { charRefOn.checked = s.charRefOn; }
        }
      } catch (_) {}
    });
  } catch (_) {}
}
restoreState();

// 打开即探测后台存活
setConn('pending');
function pingBg(cb) {
  let done = false;
  const tt = setTimeout(() => { if (!done) { done = true; cb(false); } }, 2000);
  try {
    chrome.runtime.sendMessage({ cmd: 'ping' }, (resp) => {
      if (done) return;
      done = true; clearTimeout(tt);
      cb(!!(resp && resp.ok));
    });
  } catch (e) {
    if (!done) { done = true; clearTimeout(tt); cb(false); }
  }
}
pingBg((ok) => setConn(ok ? 'ok' : 'fail'));

// v1.3.17: 批量运行期间每 20s 给后台发一次心跳，防止 MV3 service worker 30s 不活动被回收
let heartbeatTimer = null;
function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    try { chrome.runtime.sendMessage({ cmd: 'heartbeat' }, () => { void chrome.runtime.lastError; }); } catch (_) {}
  }, 20000);
}
function stopHeartbeat() {
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
}

startBtn.addEventListener('click', () => {
  setStatus(t('st.clicked'), 'busy');
  try {
    const text = $('prompts').value.trim();
    if (!text) { setStatus(t('st.noPrompt'), 'err'); return; }
    // 每行 = 一条提示词（空行自动忽略）。这样粘贴多行、或导入多行 .txt/.csv 都能正确拆成多条。
    const prompts = text.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
    if (!prompts.length) { setStatus(t('st.noValid'), 'err'); return; }

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
          setStatus(t('st.connFail'), 'err');
          setConn('fail');
          startBtn.disabled = false;
          stopBtn.disabled = true;
          stopHeartbeat();
        } else {
          setConn('ok');
          startHeartbeat();
        }
      }
    );
  } catch (e) {
    setStatus(t('st.startFail', { e: ((e && e.message) || e) }), 'err');
    startBtn.disabled = false;
    stopBtn.disabled = true;
  }
});

stopBtn.addEventListener('click', () => {
  setStatus(t('st.stopReq'));
  try { chrome.runtime.sendMessage({ cmd: 'stopBatch' }); } catch (_) {}
});

// 「复制页面诊断」按钮：把 Flow 页面真实结构复制到剪贴板，无需打开 DevTools
const copyPageDiag = $('copyPageDiag');
if (copyPageDiag) {
  copyPageDiag.addEventListener('click', async () => {
    setStatus(t('st.reading'), 'busy');
    try {
      const tabs = await chrome.tabs.query({ url: 'https://labs.google/fx/*' });
      if (!tabs.length) { setStatus(t('st.noFlow'), 'err'); return; }
      const tabId = tabs[0].id;
      const ask = (cb) => chrome.tabs.sendMessage(tabId, { cmd: 'diagnose' }, cb);
      ask((resp) => {
        const connErr = chrome.runtime.lastError || !resp || !resp.ok;
        if (connErr && /Receiving end|does not exist|context invalidated/i.test((resp && resp.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || '')) {
          // 内容脚本可能因扩展刚被重载而失效 → 自动重新注入再试
          try {
            chrome.scripting.executeScript({ target: { tabId }, files: ['content_script.js'] }).then(() => {
              setTimeout(() => ask((r2) => finishDiag(r2)), 800);
            }).catch(() => finishDiag(null));
          } catch (_) { finishDiag(null); }
          return;
        }
        finishDiag(resp);
      });
    } catch (e) {
      setStatus(t('st.readFail', { e: ((e && e.message) || e) }), 'err');
    }
  });
}

function finishDiag(resp) {
  if (!resp || !resp.ok) {
    setStatus(t('st.diagFail', { e: ((resp && resp.error) || '请刷新扩展与 Flow 页面后再试') }), 'err');
    return;
  }
  const text = resp.text || '';
  try {
    navigator.clipboard.writeText(text);
    setStatus(t('st.diagCopied'), 'ok');
  } catch (_) {
    console.log('[Flow页面诊断]\n' + text);
    setStatus(t('st.diagNoCopy'), 'warn');
  }
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || !msg.type) return;
  if (msg.type === 'batchStart') {
    setStatus(t('st.batchStart', { n: msg.total, c: msg.concurrency || 1 }), 'busy');
    setConn('ok');
  } else if (msg.type === 'itemStart') {
    const it = items[msg.index];
    if (it) { it.state = 'running'; if (it.li) it.li.className = 'item running'; }
    setStatus(t('st.generating', { i: msg.index + 1, n: items.length }), 'busy');
  } else if (msg.type === 'itemRetry') {
    const it = items[msg.index];
    if (it) { it.state = 'running'; if (it.li) it.li.className = 'item running'; }
    setStatus(t('st.retry', { i: msg.index + 1, a: msg.attempt }), 'busy');
  } else if (msg.type === 'itemDone') {
    const it = items[msg.index];
    if (it) {
      it.state = msg.ok ? 'done' : 'failed';
      if (it.li) it.li.className = 'item ' + it.state;
      if (it.textEl) {
        const suffix = msg.ok ? `✓ ${msg.count} 张` : `✗ ${msg.error || ''}`;
        it.textEl.textContent = `[${msg.index + 1}] ${it.prompt} — ${suffix}`;
      }
      if (!msg.ok && it.diagEl && msg.diagnostic) {
        it.diagEl.textContent = msg.diagnostic;
        if (it.diagWrapEl) it.diagWrapEl.hidden = false;
      }
    }
    setStatus(msg.ok ? t('st.done', { i: msg.index + 1, n: items.length }) : t('st.failed', { i: msg.index + 1 }), msg.ok ? 'busy' : 'err');
  } else if (msg.type === 'batchEnd') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus(msg.stopped ? t('st.stopped') : t('st.allDone'), msg.stopped ? '' : 'ok');
    stopHeartbeat();
  } else if (msg.type === 'error') {
    startBtn.disabled = false;
    stopBtn.disabled = true;
    setStatus(t('st.error', { e: msg.error }), 'err');
    setConn('fail');
    stopHeartbeat();
  }
});

// ---------- 语言切换 ----------
const langSel = $('langSel');
if (langSel) {
  langSel.addEventListener('change', () => applyLang(langSel.value));
}
(function initLang() {
  try {
    chrome.storage.local.get(['lang'], (s) => {
      const saved = (s && s.lang) || 'zh';
      if (langSel) langSel.value = saved;
      applyLang(saved);
    });
  } catch (_) {
    applyLang('zh');
  }
})();
