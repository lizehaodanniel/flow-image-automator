// AICHeatCode · Content Script v1.3.20
// 跑在 https://labs.google/fx/* 上。任务：进入项目页 → 选模式/模型/画幅/时长 → 填词 → 点生成 → 取媒体。
// v1.3.18：兼容「新版 Flow UI」（isVisible 替代 offsetParent；新版入口/生成按钮识别）。
// v1.3.19：① “生成已开始”检测失败不再误中止；② 上传验证改为“任意新增 img”。③ 错误自带完整诊断。
// v1.3.20：修「固定角色参考图上传卡住」——文件注入改用原生 files setter（更兼容 React onChange）；
// 上传成功判定放宽（新 img / 缩略图 div / 已注入 input.files 均视为成功），不再因新版把参考图放进媒体库而误判失败。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const PLACEHOLDER_KEY = 'placeholder';

// 在页面里找“按钮文字/aria-label 包含指定词”的元素。selector 控制搜索范围（避免误点普通 div）。
function findButtonByText(texts, selector) {
  selector = selector || 'button, a, [role="button"], [role="option"], [role="menuitem"]';
  const nodes = document.querySelectorAll(selector);
  for (const b of nodes) {
    const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
    for (const want of texts) {
      if (t.includes(want)) return b;
    }
  }
  return null;
}

function onProjectPage() {
  return /\/fx\/tools\/flow\/project\//.test(location.href);
}

// 判断元素是否真正可见。替代“offsetParent !== null”：
// 新版 Flow UI 的提示词框常包在 position:fixed 容器里，offsetParent 恒为 null，
// 导致“可见的输入框”被误判为不可见 → ensureCanvas 永远超时 → 屏幕“不动”。
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const cs = getComputedStyle(el);
  if (cs.visibility === 'hidden' || cs.display === 'none') return false;
  if (parseFloat(cs.opacity || '1') === 0) return false;
  return true;
}

// 取提示词输入框（新版/旧版都是 contentEditable 的 div[role="textbox"]）
function getPromptBox() {
  return document.querySelector('div[role="textbox"]');
}

// 是否处于“新版 Flow UI”：提示词框占位符是“您希望创作什么内容？”，
// 且输入栏里有「智能体 / Nano Banana 2」这类新芯片（旧版没有）。
function isNewFlowUI() {
  const tb = getPromptBox();
  if (tb) {
    const t = (tb.innerText || '').trim();
    if (t.includes('您希望创作什么内容') || t.includes('创作什么')) return true;
  }
  if (findButtonByText(['智能体', 'Nano Banana'], 'button, [role="button"], div, span')) return true;
  return false;
}

// 等待提示词框真正可见（新版兼容）
async function waitForPromptBox(timeoutMs = 25000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tb = getPromptBox();
    if (tb && isVisible(tb)) return tb;
    await sleep(1200);
  }
  return null;
}

// 点“新建项目”，进入新项目的编辑器画布
// v1.3.18: 兼容新版 Flow UI（无“新建项目”按钮，编辑器就是落地页；
// 且新版输入框包在 position:fixed 里，必须用 isVisible 而非 offsetParent 判断可见性）。
async function ensureNewProject(timeoutMs = 25000) {
  // ===== 新版 Flow UI：编辑器入口就是提示词框，没有“新建项目”按钮 =====
  if (isNewFlowUI()) {
    const tb = getPromptBox();
    if (tb && isVisible(tb)) return true; // 已在编辑器即可，后续由 generateOne 处理全新画布
    // 不在编辑器：尝试点“创建/新建/开始”等入口进入
    const entry = findButtonByText(
      ['创建', '新建', '开始', '新建项目', 'New project', 'Create project', 'Get started', '进入', '打开'],
      'button, a, [role="button"], div'
    );
    if (entry) {
      entry.click();
      if (await waitForPromptBox(20000)) return true;
    }
    const card = document.querySelector('[role="gridcell"], a[href*="/project/"], [class*="card"], [class*="Card"]');
    if (card) {
      card.click();
      if (await waitForPromptBox(20000)) return true;
    }
    return false;
  }

  // ===== 旧版 Flow UI =====
  // 1. 记录点击前的媒体数量，用于验证旧媒体被清空
  const mediaSel = 'img[src^="blob:"], img[src^="data:"], [class*="thumb" i], [class*="Thumb"], [class*="asset" i], [class*="Asset"]';
  const mediaBefore = document.querySelectorAll(mediaSel).length;

  const btn = findButtonByText(
    ['新建项目', '新项目', 'New project', 'Create project', '新建'],
    'button, a, [role="button"], div'
  );
  if (!btn) {
    // 旧版某些灰度变体也可能直接就在编辑器（无“新建项目”按钮）
    const tb = getPromptBox();
    if (tb && isVisible(tb)) return true;
    return false;
  }
  btn.click();

  const t0 = Date.now();
  let inputAppeared = false;
  while (Date.now() - t0 < timeoutMs) {
    const inp = getPromptBox();
    if (inp && isVisible(inp)) {
      inputAppeared = true;
      // 2. 验证旧媒体已清空
      const mediaNow = document.querySelectorAll(mediaSel).length;
      // 3. 验证输入框是空的（没有残留提示词）
      const txt = (inp.innerText || '').trim();
      if ((mediaNow < mediaBefore || mediaNow === 0) && txt.length === 0) return true;
    }
    await sleep(1500);
  }

  // 旧媒体没清空：再点一次"新建项目"（Flow 有时第一次点击只是导航，第二次才真正清空）
  if (inputAppeared) {
    console.warn('[Flow扩展] 新建项目后旧媒体未清空，再次点击');
    const btn2 = findButtonByText(
      ['新建项目', '新项目', 'New project', 'Create project', '新建'],
      'button, a, [role="button"], div'
    );
    if (btn2) {
      btn2.click();
      const t1 = Date.now();
      while (Date.now() - t1 < 10000) {
        const inp = getPromptBox();
        if (inp && isVisible(inp)) {
          const mediaNow = document.querySelectorAll(mediaSel).length;
          const txt = (inp.innerText || '').trim();
          if ((mediaNow < mediaBefore || mediaNow === 0) && txt.length === 0) return true;
        }
        await sleep(1000);
      }
    }
  }
  return false;
}

// 确保处在编辑器画布（有可输入的 prompt 框）。若停留在落地页，尝试进项目。
async function ensureCanvas(timeoutMs = 30000) {
  const t0 = Date.now();
  let tried = false;
  while (Date.now() - t0 < timeoutMs) {
    const inp = getPromptBox();
    if (inp && isVisible(inp)) return true;
    if (!tried) {
      // 新版入口词（创建/新建/开始创作）+ 旧版入口词
      const btn = findButtonByText(
        ['Get started', 'Create with Google Flow', '开始使用', '打开项目', 'New project', '新建项目', '进入', '进入项目', '创建', '新建', '开始创作'],
        'button, a, [role="button"], div'
      );
      if (btn) { btn.click(); tried = true; await sleep(1500); continue; }
      // 尝试点第一个项目卡片
      const card = document.querySelector('[role="gridcell"], a[href*="/project/"], [class*="card"], [class*="Card"]');
      if (card) { card.click(); tried = true; await sleep(1500); continue; }
      tried = true;
    }
    await sleep(1500);
  }
  return false;
}

async function setPrompt(text) {
  // 依次尝试多种可能的“提示词输入框”选择器，命中第一个可见的
  // 注意：Flow 的真实输入框是 contentEditable 的 div[role="textbox"]（占位符“您希望创作什么内容？”
  // 直接作为该 div 的子文本节点存在），所以必须优先匹配它。
  const sels = [
    'div[role="textbox"]',
    'div[contenteditable="true"]',
    'textarea[role="textbox"]',
    'textarea',
    'input[type="text"]',
    'input:not([type])',
  ];
  let inp = null;
  for (const s of sels) {
    inp = await waitForVisible(s, 3000).catch(() => null);
    if (inp) break;
  }
  if (!inp) throw new Error('未找到提示词输入框（可能页面结构变了）');

  inp.focus();
  await sleep(150);

  const isFormField = inp.tagName === 'INPUT' || inp.tagName === 'TEXTAREA';
  if (isFormField) {
    // input / textarea：React 受控组件必须通过原生 setter 写入，否则 state 不更新
    const proto = Object.getPrototypeOf(inp);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(inp, text); else inp.value = text;
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    inp.dispatchEvent(new Event('change', { bubbles: true }));
    await sleep(300);
    return;
  }

  // contenteditable（Flow 的 role=textbox 就是它）。
  // 关键：execCommand('insertText') 会派发 React 能捕获的 input/beforeinput 事件，
  // 从而真正更新 Flow 的 state；但前提是光标必须在该元素内，且要把占位符/旧内容先清掉。
  const writeViaExec = () => {
    let ok = false;
    try { ok = document.execCommand('insertText', false, text); } catch (_) { ok = false; }
    return ok;
  };
  const placeCaret = () => {
    try {
      const range = document.createRange();
      range.selectNodeContents(inp);
      range.collapse(false); // 移到末尾，确保选区落在可编辑元素内部
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return true;
    } catch (_) { return false; }
  };

  // 1) 把光标放进元素，全选并删除已有内容（含占位符文本节点）
  placeCaret();
  try { document.execCommand('selectAll'); } catch (_) {}
  try { document.execCommand('delete'); } catch (_) {}
  await sleep(60);

  // 2) 写入新文本
  let ok = writeViaExec();
  if (!ok) {
    // 兜底：直接写 DOM 并派发 input 事件（部分自定义编辑器不响应 execCommand 时）
    try {
      inp.textContent = '';
      inp.innerText = text;
      inp.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text }));
      ok = true;
    } catch (_) { ok = false; }
  }
  await sleep(400);

  // 3) 校验：若仍未真正写入（Flow 没收到），再尝试一次 selectAll + insertText
  const got = (inp.innerText || '') + (inp.textContent || '');
  if (!got.includes(text)) {
    placeCaret();
    try { document.execCommand('selectAll'); } catch (_) {}
    try { document.execCommand('delete'); } catch (_) {}
    writeViaExec();
    await sleep(300);
  }
}

// 失败时抓取真实页面状态，便于定位（不再靠猜）
function diagnose(startCount) {
  const tb = document.querySelector('div[role="textbox"]');
  const tbText = tb ? (tb.innerText || '').slice(0, 120) : '(无 textbox)';
  const gBtn = findGenerateButtonAnyState();
  let btnInfo = '(未找到生成按钮)';
  if (gBtn) {
    const lbl = ((gBtn.innerText || '').trim() + ' | aria:' + (gBtn.getAttribute('aria-label') || '')).slice(0, 80);
    btnInfo = `label="${lbl}" disabled=${gBtn.disabled}`;
  }
  let btnHtml = '';
  if (gBtn) {
    btnHtml = (gBtn.outerHTML || '').replace(/\s+/g, ' ').slice(0, 240);
  }
  const spinner = document.querySelector('[role="progressbar"], [aria-busy="true"], .progress, .spinner, .loader');
  // 抓取页面里所有“生成中/排队/Generating/processing”类文案，判断是否已开始
  let busyText = '';
  const all = Array.from(document.querySelectorAll('*')).slice(0, 2000);
  for (const n of all) {
    const t = (n.innerText || '').trim();
    if (/生成中|创建中|处理中|排队中|generating|creating|processing|in progress/i.test(t) && t.length < 40) { busyText = t; break; }
  }
  return {
    textboxHasPrompt: tbText.length > 0,
    textboxText: tbText,
    generateButton: btnInfo,
    generateButtonHtml: btnHtml,
    mediaCountBefore: startCount,
    mediaCountNow: countMedia(),
    spinnerFound: !!spinner,
    busyTextFound: busyText,
  };
}

// 通过 CDP 真实点击页面里第一个文本匹配的元素（先把元素滚到视口中央，再让后台用 Input.dispatchMouseEvent 真按一下）。
// 解决“合成点击被 Flow 框架忽略 → 模式/模型切不动”的根因。
async function cdpClickByText(texts, selector) {
  const btn = findButtonByText(texts, selector);
  if (!btn) return false;
  try { btn.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(200);
  // 取不到有效坐标（节点未挂载/被遮挡）就立刻回退到合成点击，不至于阻塞
  let rect = null;
  try {
    const r = btn.getBoundingClientRect && btn.getBoundingClientRect();
    if (r && r.width > 0 && r.height > 0) rect = { x: r.x, y: r.y, width: r.width, height: r.height };
  } catch (_) {}
  if (!rect) { btn.click(); await sleep(300); return true; }
  const resp = await chrome.runtime.sendMessage({ cmd: 'cdpClick', rect });
  if (!resp || !resp.ok) {
    // CDP 失败时回退到合成点击（不至于完全无效）
    btn.click();
    await sleep(300);
  }
  return true;
}

// 选模式：必须用 CDP 真实点击，否则 Flow 一直留在用户上次选的「智能体」模式 → 报“必须提供参考”
async function setMode(mode) {
  const map = {
    text2img: ['图片', '图像', 'Image', 'Images', '文生图', 'Text to image'],
    text2video: ['视频', 'Video', 'Videos', '文生视频', 'Text to video'],
    img2img: ['图生图', 'Image to image', '图生图像'],
  };
  const texts = map[mode];
  if (!texts) return;
  // 模式芯片通常不是 button，多是 div；把候选范围放宽
  await cdpClickByText(texts, 'button, [role="button"], [role="tab"], [role="option"], [role="radio"], div, span, a');
  await sleep(600);
}

// 设画幅（CDP 真实点击）
async function setAspectRatio(ratio) {
  if (!ratio) return false;
  const wanted = String(ratio).trim();
  const ok = await cdpClickByText([wanted], 'button, [role="button"], [role="radio"], [role="option"], label, div');
  return ok;
}

// 选模型（CDP 真实点击）
async function setModel(model) {
  if (!model) return;
  const trigger = findButtonByText([model, '模型', 'Model', 'Veo', 'Nano', 'Imagen', 'Gemini'], 'button, [role="button"], div, span, a');
  if (!trigger) return;
  try { trigger.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(150);
  const r = trigger.getBoundingClientRect();
  if (r && r.width) {
    await chrome.runtime.sendMessage({ cmd: 'cdpClick', rect: { x: r.x, y: r.y, width: r.width, height: r.height } });
  } else {
    trigger.click();
  }
  await sleep(600);
  // 再点一次匹配项（部分设计需要先展开下拉）
  const opt = findButtonByText([model], 'button, [role="button"], [role="option"], div, span, a');
  if (opt && opt !== trigger) {
    try { opt.scrollIntoView({ block: 'center' }); } catch (_) {}
    await sleep(150);
    const r2 = opt.getBoundingClientRect();
    if (r2 && r2.width) {
      await chrome.runtime.sendMessage({ cmd: 'cdpClick', rect: { x: r2.x, y: r2.y, width: r2.width, height: r2.height } });
    } else {
      opt.click();
    }
    await sleep(400);
  }
}

// 设视频时长（CDP 真实点击）
async function setDuration(duration) {
  if (!duration) return;
  await cdpClickByText([duration], 'button, [role="button"], [role="option"], div, span');
  await sleep(400);
}

// 从一组候选按钮里挑出真正的「提交生成」按钮。
// 判定优先级（必须一眼锁定真实按钮，避免点错）：
//   ① 文本/aria 含 arrow_forward（真正的提交箭头图标，Material Symbols 连字名，绝不会是 add_2 等素材按钮）
//   ② 含 svg 图标且几乎无文字的图标按钮（就是提交箭头）
//   ③ aria-label 含 创建/生成/send/submit
//   ④ 该组里最靠右的按钮（提交箭头一定在输入栏最右侧）
// 同时明确【排除】“add_2 / add media / 添加素材”这类素材按钮（它们文本也含“创建”，但不是提交）。
function pickSubmit(btns) {
  const decoy = (b) => /add_2|add media|添加素材|upload|上载/i.test(
    (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')
  );
  const clean = btns.filter((b) => !decoy(b));
  const cand = clean.length ? clean : btns;

  // ① arrow_forward 提交箭头（最可靠的唯一信号）
  let b = cand.find((x) => /arrow_forward/i.test((x.innerText || '') + ' ' + (x.getAttribute('aria-label') || '')));
  if (b) return b;
  // ② 图标按钮（svg）且文字极少
  b = cand.find((x) => x.querySelector('svg, [class*="icon"], [class*="Icon"]') && ((x.innerText || '').trim().length < 3));
  if (b) return b;
  // ③ aria-label 明确是创建/生成/发送
  b = cand.find((x) => /创建|生成|create|generate|send|submit/i.test(x.getAttribute('aria-label') || ''));
  if (b) return b;
  // ④ 最靠右
  if (cand.length) {
    let rightmost = cand[0];
    for (const x of cand) {
      const ra = x.getBoundingClientRect();
      const rr = rightmost.getBoundingClientRect();
      if (ra.right > rr.right) rightmost = x;
    }
    return rightmost;
  }
  return null;
}

// 找底部的「提交生成」按钮：优先从提示词输入框所在的那一条输入栏里挑（最可靠），
// 避免被页面其它位置含「创建/生成」字样的按钮（比如素材面板、菜单）误导。
// skipDisabled=true 时跳过 disabled 按钮（用于真正点击前等待按钮可点）；
// skipDisabled=false 时不跳过（用于 confirmGenerationStarted 判断“已开始”——
// 此时提交按钮通常已变 disabled，若跳过就永远检测不到“已开始”）。
function findGenerateButton(skipDisabled) {
  if (skipDisabled === undefined) skipDisabled = true;
  // 1) 从 textbox 上升找包含它的「输入栏」，在栏内挑提交按钮
  const tb = getPromptBox();
  if (tb) {
    let bar = tb.parentElement;
    for (let i = 0; i < 8 && bar; i++) {
      let btns = Array.from(bar.querySelectorAll('button')).filter((b) => !b.contains(tb));
      btns = btns.filter((b) => isVisible(b)); // 排除隐藏/固定定位导致不可见的按钮
      if (skipDisabled) btns = btns.filter((b) => !b.disabled);
      if (btns.length) {
        const s = pickSubmit(btns);
        if (s) return s;
      }
      bar = bar.parentElement;
    }
  }
  // 2) 兜底：全局找 arrow_forward 提交按钮（必须可见）
  for (const b of document.querySelectorAll('button')) {
    if (!isVisible(b)) continue;
    if (skipDisabled && b.disabled) continue;
    const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
    if (/arrow_forward/i.test(t)) return b;
  }
  return null;
}

// 与 findGenerateButton 完全相同，但【不跳过 disabled 按钮】。
// 仅用于 confirmGenerationStarted：生成开始后提交按钮通常会变 disabled/busy，
// 此时若用 findGenerateButton（会跳过 disabled）就会永远找不到 → 误判“未进入生成状态”。
function findGenerateButtonAnyState() {
  return findGenerateButton(false);
}

async function clickGenerate() {
  let btn = null;
  for (let i = 0; i < 60; i++) {
    btn = findGenerateButton();
    if (btn && !btn.disabled) break;
    await sleep(500);
  }
  if (!btn) throw new Error('未找到生成按钮（按钮可能改版）。' + fullDiagnosticDump());
  try { btn.scrollIntoView({ block: 'center' }); } catch (_) {}

  // 方式 1（首选）：在提示词输入框上模拟按回车键 — 这是 Flow 最直接的提交方式，
  // 很多情况下「点击 → 箭头」因事件冒泡或框架拦截而不触发，按 Enter 反而更稳。
  const tb = document.querySelector('div[role="textbox"]');
  if (tb) {
    try { tb.focus(); } catch (_) {}
    const mk = (type) => new KeyboardEvent(type, {
      key: 'Enter', code: 'Enter', keyCode: 13, which: 13,
      bubbles: true, cancelable: true,
    });
    tb.dispatchEvent(mk('keydown'));
    tb.dispatchEvent(mk('keypress'));
    tb.dispatchEvent(mk('keyup'));
    await sleep(300);
  }
  // 方式 2（兜底）：点击提交箭头按钮（若 Enter 已让按钮变 disabled，则跳过避免重复提交）
  btn = findGenerateButton();
  if (btn && !btn.disabled) btn.click();
}

// ===== 真实屏幕输入（CDP）封装 =====
// 定位输入框与提交按钮的视口坐标，交给后台用 Chrome 原生输入引擎驱动。
// 为什么绕一圈走后台：chrome.debugger（CDP）只能在后台 service worker 里调用，
// 内容脚本没有 debugger 权限，所以这里负责“定位 + 校验”，后台负责“真实输入”。
function locateControls() {
  const tb = document.querySelector('div[role="textbox"]');
  if (!tb) return { ok: false, error: '未找到提示词输入框（可能页面结构变了或不在项目页）' };
  try { tb.scrollIntoView({ block: 'center' }); } catch (_) {}
  const r = tb.getBoundingClientRect();
  const textboxRect = { x: r.x, y: r.y, width: r.width, height: r.height };

  const btn = findGenerateButton(false) || findGenerateButton(true);
  let submitRect = null;
  if (btn) {
    try { btn.scrollIntoView({ block: 'center' }); } catch (_) {}
    const br = btn.getBoundingClientRect();
    submitRect = { x: br.x, y: br.y, width: br.width, height: br.height };
  }
  return { ok: true, textboxRect, submitRect };
}

// 用真实输入把提示词敲进输入框（后台走 CDP 的 Input.insertText）
async function cdpType(prompt) {
  const loc = locateControls();
  if (!loc.ok) throw new Error(loc.error);
  const resp = await chrome.runtime.sendMessage({ cmd: 'cdpType', rect: loc.textboxRect, text: prompt });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'CDP 打字失败');
  // 校验：框里是否真的出现提示词（CDP 是受信事件，Flow 的 React 一旦收到，innerText 必然更新）
  const tb = document.querySelector('div[role="textbox"]');
  const got = tb ? (tb.innerText || '').trim() : '';
  if (!got.includes(prompt.slice(0, 4))) throw new Error('CDP 写入未被 Flow 接受（框内未见提示词）');
  return true;
}

// 用真实鼠标点击按下提交箭头（后台走 CDP 的 Input.dispatchMouseEvent）
async function cdpClickSubmit() {
  const loc = locateControls();
  if (!loc.ok) throw new Error(loc.error);
  if (!loc.submitRect) throw new Error('未定位到提交按钮坐标');
  const resp = await chrome.runtime.sendMessage({ cmd: 'cdpClick', rect: loc.submitRect });
  if (!resp || !resp.ok) throw new Error((resp && resp.error) || 'CDP 点击失败');
  return true;
}

async function waitForVisible(sel, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const el = document.querySelector(sel);
    if (el && isVisible(el)) return el;
    await sleep(300);
  }
  throw new Error('选择器超时：' + sel);
}

// 快照当前页面所有 img/video 的 URL（用于区分“旧图”和“新生成的图”）
function snapshotMediaUrls() {
  return new Set(
    Array.from(document.querySelectorAll('img, video'))
      .map((m) => m.src || m.currentSrc || '')
      .filter(Boolean)
  );
}

function countMedia() {
  return document.querySelectorAll('img, video').length;
}

// 确认页面真的开始生成了：生成按钮进入 loading/禁用，或出现进度条/生成中提示，
// 或媒体总数比点击前增加了，或输入框里的提示词被清空（Flow 提交后会清掉输入框）。
// 任一成立即视为已开始。等不到就返回 false。
async function confirmGenerationStarted(startCount, timeoutMs = 20000, promptText = '') {
  const t0 = Date.now();
  // 新版 Flow UI 的“生成中”文案更杂（正在生成 / 渲染中 / 排队 / 创建中 / generating / rendering ...），放宽匹配。
  const busyRe = /\b(generating|creating|loading|rendering|processing|queued|working|生成中|创建中|处理中|渲染中|排队中|正在生成|正在创建)\b|生成|创建|渲染|排队/i;
  while (Date.now() - t0 < timeoutMs) {
    // 按钮禁用 / 文案变为生成中（注意：必须用 AnyState 版本，因为生成中按钮是 disabled 的，
    // 普通 findGenerateButton 会跳过它，导致永远检测不到“已开始”，最终被误判为失败而中止）
    const btn = findGenerateButtonAnyState();
    if (btn) {
      const label = ((btn.innerText || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim();
      if (btn.disabled || btn.getAttribute('aria-busy') === 'true' || busyRe.test(label)) {
        return true;
      }
    }
    // 进度条 / 忙碌标记
    if (document.querySelector('[role="progressbar"], [aria-busy="true"], .progress, .spinner, .loader, [class*="loading"], [class*="Loading"], [class*="spinner"], [class*="Spinner"]')) {
      return true;
    }
    // 输入框提示词被清空 = 已提交（Flow 提交后会把输入框清空）。这是最可靠的“已开始”信号。
    if (promptText && promptText.trim().length > 0) {
      const tb = document.querySelector('div[role="textbox"]');
      const now = tb ? (tb.innerText || '').trim() : '';
      if (now.length === 0) return true;
    }
    // 媒体总数增加（说明有新内容产生，作为上面按钮检测的兜底）
    if (countMedia() > startCount) return true;
    await sleep(400);
  }
  return false;
}

// 收集 click 之后“新出现”的 img 与 video（排除占位图、排除已知 URL）
async function collectNewMedia(knownKeys, timeoutMs = 180000) {
  const t0 = Date.now();
  const pick = (el) => {
    const s = (el.src || el.currentSrc || '');
    if (!s) return false;
    if (s.includes(PLACEHOLDER_KEY)) return false;
    if (!(s.startsWith('blob:') || s.startsWith('http'))) return false;
    return !knownKeys.has(s);
  };
  while (Date.now() - t0 < timeoutMs) {
    const imgs = Array.from(document.querySelectorAll('img')).filter(pick);
    const vids = Array.from(document.querySelectorAll('video')).filter(pick);
    if (imgs.length || vids.length) return { imgs, vids };
    await sleep(2000);
  }
  return { imgs: [], vids: [] };
}

async function mediaToPayload(el, tag) {
  const src = el.src || el.currentSrc || '';
  if (src.startsWith('blob:')) {
    try {
      const r = await fetch(src);
      const blob = await r.blob();
      const dataUrl = await new Promise((res, rej) => {
        const reader = new FileReader();
        reader.onload = () => res(reader.result);
        reader.onerror = () => rej(reader.error);
        reader.readAsDataURL(blob);
      });
      return { dataUrl, tag };
    } catch (_) {
      return { url: src, tag };
    }
  }
  return { url: src, tag };
}

// ============ 图片素材上传（图生视频 / 成分动画 需要）============
// 多策略把图片注入 Flow：① 已存在的 <input type="file">；② 点“上传/添加”按钮触发隐藏 input；③ 拖拽区 drop。
// 注入用 DataTransfer + 派发 change/input，是 React 受控 file input 唯一可靠写法；点按钮走 CDP 保证是真实点击。
async function dataUrlToBlob(dataUrl) {
  try {
    const res = await fetch(dataUrl);
    return await res.blob();
  } catch (_) {
    const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl);
    if (!m) throw new Error('图片 dataURL 解析失败');
    const bin = atob(m[2]);
    const arr = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
    return new Blob([arr], { type: m[1] || 'image/png' });
  }
}
async function buildAssetFile(dataUrl, name) {
  const blob = await dataUrlToBlob(dataUrl);
  const ext = (blob.type && blob.type.split('/')[1]) || 'png';
  return new File([blob], name || ('asset_' + Date.now() + '.' + ext), { type: blob.type || 'image/png' });
}
function findFileInput() {
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  for (const inp of inputs) {
    if (inp.disabled) continue;
    const accept = (inp.getAttribute('accept') || '').toLowerCase();
    if (!accept || accept.includes('image')) return inp;
  }
  return null;
}
async function injectFileIntoInput(input, file) {
  const dt = new DataTransfer();
  dt.items.add(file);
  // 用原型上的原生 files setter 写入，比直接赋值 input.files 更能被 React 的 onChange 捕获
  try {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'files');
    if (desc && desc.set) desc.set.call(input, dt.files);
    else input.files = dt.files;
  } catch (_) {
    try { input.files = dt.files; } catch (_) {}
  }
  input.dispatchEvent(new Event('change', { bubbles: true }));
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(500);
}
async function clickUploadTrigger() {
  const trigger = findButtonByText(
    ['上传', '添加', '导入', '选择文件', '选择图片', '选择图像', 'add media', 'upload', 'import', 'choose', '选择', '图片', '照片', '从设备', '上传图片', '上传图像', '添加媒体', '查看已上传的媒体内容', '媒体内容'],
    'button, [role="button"], div, span, a'
  );
  if (!trigger) return false;
  try { trigger.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(200);
  let rect = null;
  try { const r = trigger.getBoundingClientRect && trigger.getBoundingClientRect(); if (r && r.width > 0 && r.height > 0) rect = { x: r.x, y: r.y, width: r.width, height: r.height }; } catch (_) {}
  if (!rect) { trigger.click(); await sleep(600); return true; }
  const resp = await chrome.runtime.sendMessage({ cmd: 'cdpClick', rect });
  if (!resp || !resp.ok) { trigger.click(); }
  await sleep(600);
  return true;
}
async function uploadViaDropZone(zone, files) {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  const fire = (type) => { try { zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt })); } catch (_) {} };
  fire('dragenter'); fire('dragover'); fire('drop');
  await sleep(500);
}
// v1.3.17: 记录上传前的 blob/data URL 集合，只把"新增的"算作成功上传。
// 旧实现只看"页面上有没有图"——只要之前残留了旧图就直接返回 ok=true，根本没上传新参考图。
async function waitForUploadDone(expected, timeoutMs, input) {
  // 新版 Flow UI 上传后参考图可能渲染成：新增 img（blob:/https/...）、或缩略图 div（class 含 thumb/asset/media/reference）、
  // 或进入“媒体库”（查看已上传的媒体内容）而不在当前画布显示新 img。所以成功判定放宽：
  // ① 出现任何新的 img/缩略图 div 即视为成功；② 兜底：只要文件确实被注入进 input（files 达标），
  //    认为 Flow 已收到并开始上传，放行（新版常把参考图放进媒体库，当前画布数不到新 img）。
  const snapMarkers = () => {
    const set = new Set();
    for (const i of document.querySelectorAll('img')) {
      const s = i.src || '';
      if (s.startsWith('blob:') || s.startsWith('http') || s.startsWith('data:')) set.add('img:' + s);
    }
    for (const d of document.querySelectorAll('div[class*="thumb" i], div[class*="asset" i], div[class*="media" i], div[class*="reference" i], div[class*="ref" i]')) {
      set.add('div:' + (d.className || '') + ':' + ((d.getAttribute('style') || '').slice(0, 120)));
    }
    return set;
  };
  const before = snapMarkers();
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 30000)) {
    const now = snapMarkers();
    let newCount = 0;
    for (const s of now) if (!before.has(s)) newCount++;
    if (newCount >= expected) return { ok: true, newCount };
    await sleep(800);
  }
  // 兜底①：注入确实把文件放进 input 了（files 达标）→ 视为上传已触发，放行
  if (input && input.files && input.files.length >= expected) {
    console.warn('[Flow扩展] 未检测到新缩略图，但文件已注入 input（files=' + input.files.length + '），视为上传已触发，放行');
    return { ok: true, newCount: input.files.length, note: 'injected-but-no-thumbnail' };
  }
  // 兜底②：再算一次有没有新增 img/缩略图
  const now2 = snapMarkers();
  let newCount = 0;
  for (const s of now2) if (!before.has(s)) newCount++;
  if (newCount > 0) return { ok: true, newCount };
  return { ok: false, error: '上传后未在页面检测到新缩略图（Flow 的上传 UI 可能与预期不同，或上次残留的旧图未清空）。请点「🔍 复制页面诊断」把上传区 DOM 发我，我据此精修选择器。', diagnostic: dumpUploadArea() };
}
function dumpUploadArea() {
  const lines = ['=== Flow 上传区诊断 ==='];
  const inputs = Array.from(document.querySelectorAll('input[type="file"]'));
  lines.push('file inputs: ' + inputs.length);
  inputs.forEach((i, idx) => lines.push('  [' + idx + '] accept="' + (i.getAttribute('accept') || '') + '" multiple=' + i.multiple + ' disabled=' + i.disabled + ' hidden=' + (i.hidden || i.offsetParent === null) + ' class="' + (i.className || '') + '"'));
  const btns = Array.from(document.querySelectorAll('button, [role="button"], a, div')).filter(b => /上传|添加|导入|选择|upload|import|add media|add_2|图片|照片/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')));
  lines.push('上传相关按钮: ' + btns.length);
  btns.slice(0, 15).forEach((b, idx) => lines.push('  [' + idx + '] tag=' + b.tagName + ' text="' + (b.innerText || '').trim().slice(0, 40) + '" aria="' + (b.getAttribute('aria-label') || '') + '" class="' + (b.className || '') + '"'));
  lines.push('img 总数: ' + document.querySelectorAll('img').length);
  return lines.join('\n');
}
async function uploadImagesToFlow(dataUrls, mode) {
  if (!dataUrls || !dataUrls.length) {
    return { ok: false, error: '未提供图片素材。图生视频/成分动画需要图片：请在侧边栏「素材图片」添加（图生视频 1 张起始图；成分动画多张角色/组件图）。' };
  }
  const files = [];
  for (const du of dataUrls) {
    try { files.push(await buildAssetFile(du, (mode === 'ingredients' ? 'ingredient_' : 'frame_') + files.length + '.png')); }
    catch (e) { return { ok: false, error: '图片解码失败：' + ((e && e.message) || e) }; }
  }

  // 策略1：已存在的 file input（含隐藏）
  let input = findFileInput();
  if (input) {
    for (const f of files) await injectFileIntoInput(input, f);
    const r1 = await waitForUploadDone(files.length, 30000, input);
    if (r1.ok) return r1;
    // 隐藏 input 未与 React 绑定 → 退回策略2（点“添加媒体”触发真正的上传入口）
    console.warn('[Flow扩展] 直接注入隐藏 input 未检测到上传，改走按钮触发');
  }

  // 策略2：点“上传/添加”按钮触发隐藏 file input，再注入
  await clickUploadTrigger();
  await sleep(900);
  input = findFileInput();
  if (input) {
    for (const f of files) await injectFileIntoInput(input, f);
    return await waitForUploadDone(files.length, 30000, input);
  }

  // 策略3：拖拽区
  const zone = document.querySelector('[class*="drop"], [class*="Drop"], [data-test*="drop"], [class*="upload"], [class*="Upload"]');
  if (zone && zone.tagName !== 'INPUT') {
    await uploadViaDropZone(zone, files);
    return await waitForUploadDone(files.length, 30000, input);
  }

  return { ok: false, error: '未能定位 Flow 的上传入口（file input / 上传按钮 / 拖拽区）。请点「🔍 复制页面诊断」把上传区 DOM 发我。', diagnostic: dumpUploadArea() };
}

async function generateOne(prompt, options = {}) {
  const count = Math.max(1, Math.min(8, options.count || 1));
  const aspectRatio = options.aspectRatio || '';
  const mode = options.mode || 'text2img';

  // ===== 角色参考图：固定人物（视觉一致）=====
  // 启用后把参考图作为图生图(img2img)的基准图，每张批量图都基于同一人物生成。
  const charRef = options.charRef || null;
  const charRefImages = charRef ? [charRef] : [];
  const effectiveMode = charRef ? 'img2img' : mode;

  // 仅 Agent 模式尚未实现（需要自动多步推理）。图生视频 / 成分动画已开放：
  // 它们需要先手动上传图片素材，本扩展负责驱动后续生成但不自动上传。
  const UNSUPPORTED_MODES = ['agent'];
  if (UNSUPPORTED_MODES.includes(mode)) {
    return {
      ok: false,
      error: '当前模式「' + mode + '」(Agent 自动推理) 尚未实现。请改用 文生图(text2img) / 文生视频(text2video) / 图生视频(frame2video) / 成分动画(ingredients) / 图生图(img2img) 模式。'
    };
  }

  // 图生视频 / 成分动画：现已支持自动上传图片素材，因此 newProject 遵循用户设置（默认每条新建项目，素材会在新项目里上传）。
  // 缺少图片素材时提前报错，避免无谓进入流程。
  if (['frame2video', 'ingredients'].includes(effectiveMode) && (!options.images || !options.images.length)) {
    return { ok: false, error: '图生视频/成分动画需要先选图片素材：请在侧边栏「素材图片」里添加（图生视频 1 张起始图；成分动画多张角色/组件图）后再运行。' };
  }

  const newProject = charRef ? true : (options.newProject !== false); // 固定人物时每条新建项目并重新注入参考图，避免「图生图链式漂移」(后一张基于前一张而非原始参考图)

  // 按模式选用对应模型：视频类模式用 videoModel，图片类用 imageModel，否则退回通用 model
  const isVideoMode = ['text2video', 'frame2video', 'ingredients'].includes(effectiveMode);
  const model = (isVideoMode ? (options.videoModel || options.model) : (options.imageModel || options.model)) || '';
  const duration = options.duration || '';
  const timeoutMs = options.timeoutMs || 180000;

  if (newProject) {
    const ok = await ensureNewProject();
    if (!ok) {
      const ok2 = await ensureCanvas();
      if (!ok2) return { ok: false, error: '未能进入编辑器画布（超时）。请确认已在 Flow 项目页并登录。', diagnostic: fullDiagnosticDump() };
    }
  } else {
    const ok = await ensureCanvas();
    if (!ok) return { ok: false, error: '未能进入编辑器画布（超时）。' };
  }

  // 选模式/模型/画幅（best-effort：这些合成点击即便被框架忽略也只是沿用默认，不致命）
  try { if (effectiveMode) await setMode(effectiveMode); } catch (_) {}
  try { if (model) await setModel(model); } catch (_) {}
  try { if (aspectRatio) await setAspectRatio(aspectRatio); } catch (_) {}
  try { if (duration) await setDuration(duration); } catch (_) {}

  // 图生视频 / 成分动画：先上传图片素材，再生成。上传后再快照“已有图”，把刚上传的素材一并视为输入、不误下载。
  if (effectiveMode === 'img2img' && charRefImages.length) {
    // 角色固定：把参考图作为图生图基准上传，每张批量图都基于同一人物
    const up = await uploadImagesToFlow(charRefImages, 'img2img');
    if (!up.ok) return { ok: false, error: up.error, diagnostic: up.diagnostic || '' };
  } else if (['frame2video', 'ingredients'].includes(effectiveMode)) {
    const up = await uploadImagesToFlow(options.images || [], effectiveMode);
    if (!up.ok) return { ok: false, error: up.error, diagnostic: up.diagnostic || '' };
  }

  // 先记录“点击前已有的图”URL（这些都属于旧图，绝不能误下载）
  const knownKeys = snapshotMediaUrls();
  const startCount = countMedia();

  // 真正把提示词敲进框 + 点下提交：优先用 Chrome 原生输入引擎（CDP，受信事件，Flow 必响应），
  // 失败再回退到合成事件。这是修复“屏幕不动 / 点了不生成”的关键。
  async function typePrompt() {
    try {
      await cdpType(prompt);
    } catch (e) {
      console.log('[Flow扩展] CDP 打字失败，回退合成事件: ' + ((e && e.message) || e));
      try { await setPrompt(prompt); } catch (e2) { throw new Error('填词失败：' + ((e2 && e2.message) || e2)); }
    }
  }
  async function clickSubmit() {
    try {
      await cdpClickSubmit();
    } catch (e) {
      console.log('[Flow扩展] CDP 点击失败，回退合成事件: ' + ((e && e.message) || e));
      try { await clickGenerate(); } catch (e2) { throw new Error('点击生成失败：' + ((e2 && e2.message) || e2)); }
    }
  }

  const items = [];
  // v1.3.17: 提示词读回验证——避免"输入框还残留上一条提示词"导致连续生成同一张图
  function readPromptInBox() {
    const tb = document.querySelector('div[role="textbox"]');
    return tb ? (tb.innerText || '').trim() : '';
  }
  function verifyPromptInBox(expected, got) {
    if (!expected) return true;
    if (!got) return false;
    const head = expected.slice(0, Math.min(24, expected.length)).trim();
    if (head && got.includes(head)) return true;
    // 回退：尾部匹配（应对 Flow 把头几个字符截断的情况）
    const tail = expected.slice(-24).trim();
    if (tail && got.includes(tail)) return true;
    return false;
  }
  for (let n = 0; n < count; n++) {
    // 每次都确保提示词在框里（Flow 一次生成后可能清空输入框）
    let promptInBox = '';
    for (let vretry = 0; vretry < 3; vretry++) {
      try { await typePrompt(); } catch (e) {
        return { ok: false, error: (e && e.message) || String(e) };
      }
      promptInBox = readPromptInBox();
      if (verifyPromptInBox(prompt, promptInBox)) break;
      console.log('[Flow扩展] 提示词读回不匹配（重试 ' + (vretry + 1) + '/3），输入框="' + promptInBox.slice(0, 60) + '"');
      await sleep(500);
    }
    if (!verifyPromptInBox(prompt, promptInBox)) {
      return { ok: false, error: '提示词写入后读回不匹配：预期="' + prompt.slice(0, 40) + '..."，实际="' + promptInBox.slice(0, 60) + '"。Flow 可能改了输入框行为，请把「🔍 复制页面诊断」发我。', diagnostic: fullDiagnosticDump() };
    }
    try { await clickSubmit(); } catch (e) {
      return { ok: false, error: (e && e.message) || String(e) };
    }

    // 1) 确认页面确实进入了生成状态。新 UI 的“生成中”信号可能与旧版不同，
    //    即便没检测到明确信号也【不中止】——直接继续等结果，MEDIA 真正出现才算数。
    //    这避免了“其实已经在生成、只是信号没识别到”时误中止（这正是“点了不生成”的常见根因）。
    const started = await confirmGenerationStarted(startCount, 25000, promptInBox);
    if (!started) {
      try {
        const d = diagnose(startCount);
        console.warn('[Flow扩展] 未检测到明确“生成开始”信号，仍继续等待结果（避免误中止）。' +
          ' 输入框含提示词=' + d.textboxHasPrompt + ' 生成按钮=' + d.generateButton +
          ' 媒体数=' + d.mediaCountBefore + '/' + d.mediaCountNow + ' 转圈=' + d.spinnerFound);
      } catch (_) {}
    }

    // 2) 等约 2 秒，让 Flow 把“旧图”的 blob 地址重渲染稳定（这是误下载旧图的根因）
    await sleep(2000);

    // 3) 把此刻页面上所有媒体（含旧图的新地址）并入已知集合——从此只有“真正新增”的才会被抓取
    for (const m of document.querySelectorAll('img, video')) {
      const s = m.src || m.currentSrc || '';
      if (s) knownKeys.add(s);
    }

    // 4) 只收集“不在已知集合里”的媒体（即本次新生成的）
    const { imgs, vids } = await collectNewMedia(knownKeys, timeoutMs);
    for (const im of imgs.slice(0, 8)) items.push(await mediaToPayload(im, 'img'));
    for (const v of vids.slice(0, 8)) items.push(await mediaToPayload(v, 'video'));
    for (const m of [...imgs, ...vids]) {
      const s = m.src || m.currentSrc || '';
      if (s) knownKeys.add(s);
    }
  }

  if (!items.length) {
    return { ok: false, error: '出图完成但未捕获到结果（可能渲染方式变了，需核对选择器）' };
  }
  // 去重：Flow 在生成过程中会反复把图片的 blob URL 重新生成一遍（URL 变了，但图片内容/dataUrl 不变），
  // 仅按 URL 判重会把同一张图当成新图抓多次。按 dataUrl 去重，保证每张唯一图片只下 1 次。
  const seenKeys = new Set();
  const uniqueItems = [];
  for (const it of items) {
    const key = it.dataUrl || it.url || '';
    if (key && seenKeys.has(key)) continue;
    if (key) seenKeys.add(key);
    uniqueItems.push(it);
  }
  // 新版 Flow UI + 需要“每条全新画布”的场景（图生图/成分动画/图生视频等）：
  // 请求后台在 item 之间重载标签页，拿到干净的画布，避免「图生图链式漂移」（角色变形）。
  // 纯文生图(text2img) 每条互相独立，不需要重载，保持速度。
  const needFreshCanvas = isNewFlowUI() && newProject && effectiveMode !== 'text2img';
  return { ok: true, items: uniqueItems, count: uniqueItems.length, needFreshCanvas };
}

// 把 Flow 页面的真实结构 dump 出来（输入框候选 / 全部按钮 / 输入框所在输入栏的按钮），
// 供用户在不打开 DevTools 的情况下，点一下按钮就能把结构发给我精准定位。
function fullDiagnosticDump() {
  try {
    return '【页面诊断】\n' + dumpPageStructure() + '\n\n' + dumpUploadArea();
  } catch (_) {
    return '(诊断生成失败)';
  }
}
function dumpPageStructure() {
  const L = [];
  const log = (s) => L.push(s);
  log('=== 提示词输入框候选 ===');
  const ins = Array.from(document.querySelectorAll('div[role="textbox"], textarea, input, [contenteditable="true"]'));
  log('找到 ' + ins.length + ' 个');
  ins.slice(0, 6).forEach((el, i) => {
    log(`#${i} tag=${el.tagName} ce=${el.isContentEditable} role=${el.getAttribute('role') || ''} ph="${el.getAttribute('placeholder') || ''}" cls="${typeof el.className === 'string' ? el.className : ''}" val="${(el.value || el.innerText || '').toString().slice(0, 40)}"`);
  });
  log('=== 全部按钮（最多 30）===');
  const btns = Array.from(document.querySelectorAll('button'));
  log('共 ' + btns.length + ' 个');
  btns.slice(0, 30).forEach((b, i) => {
    log(`B#${i} txt="${(b.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}" aria="${b.getAttribute('aria-label') || ''}" dis=${b.disabled} ${b.querySelector('svg') ? 'svg' : ''}`);
  });
  log('=== 输入框所在输入栏内的按钮 ===');
  const box = document.querySelector('div[role="textbox"], textarea, input[role="textbox"]');
  if (box) {
    let p = box.parentElement, d = 0;
    while (p && d < 8) {
      const bs = Array.from(p.querySelectorAll('button'));
      if (bs.length) {
        log(`depth${d} cls="${p.className || ''}" 按钮${bs.length}个:`);
        bs.slice(0, 10).forEach((b, j) => log(`  b#${j} txt="${(b.innerText || '').replace(/\s+/g, ' ').slice(0, 20)}" aria="${b.getAttribute('aria-label') || ''}" dis=${b.disabled}`));
      }
      p = p.parentElement; d++;
    }
  } else {
    log('未找到输入框');
  }
  return L.join('\n');
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.cmd === 'ping') {
    sendResponse({ ok: true, ts: Date.now() });
    return true;
  }
  if (msg && msg.cmd === 'diagnose') {
    try { sendResponse({ ok: true, text: dumpPageStructure() }); }
    catch (e) { sendResponse({ ok: false, error: String((e && e.message) || e) }); }
    return true;
  }
  if (msg && msg.cmd === 'generate') {
    generateOne(msg.prompt, msg.options || {})
      .then((r) => sendResponse(r))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true; // 异步响应
  }
});
