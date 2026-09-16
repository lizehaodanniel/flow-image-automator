// AICHeatCode · Content Script v1.4.8
// 跑在 https://labs.google/fx/* 上。任务：进入项目页 → 选模式/模型/画幅/时长 → 填词 → 点生成 → 取媒体。
// v1.3.18：兼容「新版 Flow UI」（isVisible 替代 offsetParent；新版入口/生成按钮识别）。
// v1.3.19：① "生成已开始"检测失败不再误中止；② 上传验证改为"任意新增 img"。③ 错误自带完整诊断。
// v1.3.20：修「固定角色参考图上传卡住」——文件注入改用原生 files setter（更兼容 React onChange）；
// 上传成功判定放宽（新 img / 缩略图 div / 已注入 input.files 均视为成功），不再因新版把参考图放进媒体库而误判失败。
// v1.3.21：彻底移除 chrome.debugger / CDP 真实输入；其触发 Flow 反调试导致页面被踢出、扩展不动。回归 v1.6/v1.7 纯合成事件驱动。
// v1.3.22：恢复 manifest 的 scripting 权限，使侧边栏能在内容脚本失效时自动重新注入（自我修复），避免“读取失败”需手动刷新 Flow。
// v1.3.23：ping 回传内容脚本版本；配合侧边栏自检，一眼看出“未注入 / 版本不匹配 / 旧版残留”。
// v1.3.24：彻底重构图片上传（修复“多文件逐个注入互相覆盖、只剩最后一张”的真根因；三种策略 + 逐步日志诊断；
//          明确指出 Flow 新版上传入口可能依赖原生文件框、扩展无法自动填充，引导改用「文生图」或手动上传参考图）。
// v1.3.25：文生图也“完全不动” → 真根因在【共享驱动链路】，不在上传。① generateOne 全程加执行轨迹日志（[Flow] 前缀，
//          每步打 console + 失败时随诊断返回，一眼看出卡在 进画布/填词/提交/等结果 哪一步）；② setPrompt 增 beforeinput 事件兜底 +
//          写后检测“提交按钮是否真的变可用”（若 DOM 有字但按钮仍 disabled，即合成事件没进 Flow 的 React state 的实锤）；
//          ③ 自检卡片新增「内容脚本版本 vs 扩展版本」不一致告警（多为加载了旧版/多份扩展）。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const SELF_VERSION = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest && chrome.runtime.getManifest().version) || '1.5.22';
const PLACEHOLDER_KEY = 'placeholder';

// ============ v1.5.0 回归 CDP（chrome.debugger）真实输入 ============
// 证据（来自 GitHub 开源参考）：Flow-Auto-Prompter / AutoFlow-Pro 均在 Google Flow 上用
// chrome.debugger 的 Input.insertText / Input.dispatchMouseEvent 稳定驱动；用户也确认
// 「能用时页面顶部有『aicheatcode 正在调用页面』横幅」= 正是 chrome.debugger 调试横幅
// （它不会踢出页面，反而说明 CDP 在工作）。之前的版本误把该横幅当成 Flow 反调试而移除 CDP，
// 是「越升级越不行」的真正根因。
// 关键：Slate 编辑器只接受真实/hardware-level 输入，合成事件（粘贴/execCommand/字符键盘）全被拒。
// CDP 的 Input.* 是硬件级、React/Slate 无法拦截——这是唯一能真正写进 Slate React state 的方式。
// 内容脚本没有 chrome.debugger 权限，故由 background.js 持有 debugger，内容脚本通过 bgRpc 请求真实输入。

// 拿 DOM 节点上的 React fiber（React 16+ 把 fiber 挂到 DOM 节点的 __reactFiber$KEY 属性上）
function getReactFiber(el) {
  const key = Object.keys(el).find((k) => k.startsWith('__reactFiber') || k.startsWith('__reactInternalInstance'));
  return key ? el[key] : null;
}

// 在 fiber 树里向上找带 editor 实例的节点（Slate 的 <Slate> 组件把 editor 放在 memoizedProps.editor）
function findSlateEditor(el) {
  let fiber = getReactFiber(el);
  while (fiber) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props && props.editor && typeof props.editor.insertText === 'function' && Array.isArray(props.editor.children)) {
      return props.editor;
    }
    // 某些版本 editor 直接挂在 stateNode 上
    if (fiber.stateNode && fiber.stateNode.editor && typeof fiber.stateNode.editor.insertText === 'function') {
      return fiber.stateNode.editor;
    }
    fiber = fiber.return;
  }
  return null;
}

// 在 fiber 树里向上找真正的 onClick 处理函数（React 合成的 onClick 挂在 memoizedProps.onClick）
function findReactOnClick(el) {
  let fiber = getReactFiber(el);
  while (fiber) {
    const props = fiber.memoizedProps || fiber.pendingProps;
    if (props && typeof props.onClick === 'function') return props.onClick;
    fiber = fiber.return;
  }
  return null;
}

// Slate editor 的末尾 Point：遍历 children 找最后一个叶子文本节点
function slateEndPoint(editor) {
  const children = editor.children || [];
  if (!children.length) return { path: [0], offset: 0 };
  const walk = (node, path) => {
    if (node.children && node.children.length) {
      const i = node.children.length - 1;
      return walk(node.children[i], path.concat(i));
    }
    return { path, offset: (node.text || '').length };
  };
  const last = children.length - 1;
  return walk(children[last], [last]);
}

// 清空 Slate editor（优先 selectAll + deleteFragment，否则逐字符删除）
function clearSlateEditor(editor) {
  try {
    if (typeof editor.selectAll === 'function') {
      editor.selectAll();
      if (typeof editor.deleteFragment === 'function') { editor.deleteFragment(); return; }
    }
  } catch (_) {}
  // 兜底：逐字符回删（最多 5000 次）
  try {
    if (typeof editor.deleteBackward === 'function') {
      for (let i = 0; i < 5000; i++) {
        const before = (editor.children && JSON.stringify(editor.children)).length;
        editor.deleteBackward('character');
        const after = (editor.children && JSON.stringify(editor.children)).length;
        if (after >= before && i > 0) break;
      }
    }
  } catch (_) {}
}


// content script → background 的 RPC（请求后台用 CDP 真实输入；内容脚本无 chrome.debugger 权限）
function bgRpc(msg) {
  return new Promise((resolve, reject) => {
    try {
      chrome.runtime.sendMessage(msg, (resp) => {
        if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message || 'rpc error'));
        else resolve(resp);
      });
    } catch (e) { reject(e); }
  });
}

// 在页面里找"按钮文字/aria-label 包含指定词"的元素。selector 控制搜索范围（避免误点普通 div）。
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

// 取提示词输入框。
// v1.5.6+ 兼容修复：新版 Flow UI 把提示词编辑器换成了 ProseMirror，
// 它只有 contenteditable="true"，【没有 role="textbox" 属性】——旧的单选择器恒为 null：
//   → ensureNewProject / ensureCanvas 误判"不在编辑器" → 触发兜底盲点（点第一个 class 含 card 的元素）
//   → 正好点到 Google 账号头像 → 弹出账号面板；再等 30s 超时报"未能进入编辑器画布"。
// 这里改为多级兜底，并保留 isVisible 过滤（页面里存在 0x0 的隐藏 contenteditable 干扰项）。
// 注意：两个 Google 账号现在都是新版 UI，缺 role 是全局改版，不是账号差异。
function getPromptBox() {
  const sels = [
    'div[role="textbox"]',                      // 旧版 Flow（优先，行为与修复前一致）
    'div[contenteditable="true"].ProseMirror',  // 新版 Flow：ProseMirror 编辑器，无 role 属性
    'div[contenteditable="true"]',              // 最后兜底
  ];
  for (const s of sels) {
    let el = null;
    try { el = document.querySelector(s); } catch (_) { continue; }
    if (el && isVisible(el)) return el;
  }
  return null;
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
    // v1.5.8 加固：进入编辑器【绝不点 a[href] 链接 / 卡片】——点了会整页跳转（用户看到的“页面闪一下”），
    // 且可能落到错误页面。只点“真正的按钮”，找不到就明确失败，绝不做危险盲点。
    const entry = findButtonByText(
      ['创建', '新建', '开始', '新建项目', 'New project', 'Create project', 'Get started', '进入', '打开', 'Try', '体验', '立即体验'],
      'button, [role="button"]'
    );
    if (entry) {
      try { entry.click(); } catch (_) {}
      if (await waitForPromptBox(20000)) return true;
    }
    // 兜底：点第一个可见的“创建/新建/开始”类按钮（仍是 button，不会跳转）
    const anyBtn = Array.from(document.querySelectorAll('button, [role="button"]')).find((b) => {
      if (!isVisible(b)) return false;
      const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).trim();
      return /创建|新建|开始|create|new project|get started|try|体验/i.test(t);
    });
    if (anyBtn) {
      try { anyBtn.click(); } catch (_) {}
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
  // v1.4.2：纯合成点击「新建项目」（移除 CDP 受信任点击，避免反调试踢页）；下面 while 循环会验证输入框是否出现
  try { btn.click(); } catch (_) {}

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
      // v1.4.2：纯合成点击（移除 CDP）
      try { btn2.click(); } catch (_) {}
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
      // v1.5.8 加固：只点真正的按钮进入项目/编辑器，绝不点 a[href] 链接或卡片（会整页跳转 = “闪一下”）
      const btn = findButtonByText(
        ['Get started', 'Create with Google Flow', '开始使用', '打开项目', 'New project', '新建项目', '进入', '进入项目', '创建', '新建', '开始创作'],
        'button, [role="button"]'
      );
      if (btn) { try { btn.click(); } catch (_) {} tried = true; await sleep(1500); continue; }
      tried = true;
    }
    await sleep(1500);
  }
  return false;
}

async function setPrompt(text) {
  // v1.5.0：填词走 CDP 真实输入（见下方 策略0）。只有 CDP 不可用时才退化为合成事件。
  // CDP = chrome.debugger 的 Input.insertText，是硬件级输入，Slate/React 无法拦截，
  // 能真正写进 Flow 的 React state（合成事件只能改 DOM，Flow 提交时读到空 state → 无反应）。
  // 依次尝试多种可能的"提示词输入框"选择器，命中第一个可见的
  // 注意：Flow 的真实输入框是 contentEditable 的 div[role="textbox"]（占位符"您希望创作什么内容？"
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

  // ========== contenteditable（Flow 的 role=textbox，底层是 Slate 编辑器）==========
  // v1.4.6 真正修好「DOM 有字但 Flow 说没提示词、按钮 aria-disabled=true 一直挂」：
  // 之前的兜底（inp.innerText = text）会破坏 Slate DOM 结构，Slate 内部 state 没收到输入。
  // v1.4.4 三策略（paste / slate-string + beforeinput / execCommand）在 Flow 新版 Slate 上仍全部失败——
  // 用户实测"手动打字'身上'两个字符按钮就亮，扩展写完整段按钮就是灰"，说明 Slate 只接受
  // 与真实键盘事件序列一致的输入（包括 keydown/beforeinput/input/keyup + isTrusted 链路）。
  // 现在的策略顺序：
  //   A) 清空编辑器（直接移除所有子节点，加一个空文本节点，放置 caret 到起点）
  //   B) 派发完整的 IME 组合输入事件（compositionstart→compositionupdate→input:insertCompositionText→compositionend）
  //      —— Slate 对 IME 输入有专用通路，比单纯 insertText 更稳
  //   C) Range API 直接插入文本节点 + beforeinput(inputType=insertText) + input —— 保留 DOM 结构
  //   D) 字符级键盘模拟（keydown→beforeinput→input→keyup，每字符 ≤3ms）
  //      —— 最贴近真实用户输入，但慢
  //   E) execCommand('insertText') 兜底
  // 成功判定：DOM 含提示词 且 提交按钮不是 aria-disabled（Flow 真正的 disabled 信号）。

  const placeCaretAt = (node, offset) => {
    try {
      const range = document.createRange();
      range.setStart(node, offset);
      range.collapse(true);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    } catch (_) {}
  };

  // 直接 DOM 操作清空（不依赖 execCommand，更可靠）
  const clearEditor = () => {
    try {
      while (inp.firstChild) inp.removeChild(inp.firstChild);
      const empty = document.createTextNode('');
      inp.appendChild(empty);
      placeCaretAt(empty, 0);
    } catch (e) {
      console.warn('[Flow] setPrompt clearEditor 异常: ' + (e && e.message || e));
    }
  };

  const isBtnEnabled = () => {
    const b = (typeof findGenerateButtonAnyState === 'function') ? findGenerateButtonAnyState() : null;
    if (!b) return false;
    if (b.disabled) return false;
    if (b.getAttribute && b.getAttribute('aria-disabled') === 'true') return false;
    return true;
  };

  let wrote = false;

  // ===== 策略0（v1.5.0 回归 CDP 真实输入）：硬件级键入，React/Slate 无法拦截 =====
  // 后台用 chrome.debugger 在编辑器中心点击聚焦 → Ctrl+A 全选删除 → Input.insertText 键入整段。
  // 这是唯一能真正写进 Slate React state 的方式（参考开源 Flow-Auto-Prompter / AutoFlow-Pro）。
  // ===== 策略0（v1.5.0 回归 CDP 真实输入；参考 novri-ra/Flow-Auto-Prompter 的 verify+retry）=====
  // 硬件级键入（CDP Input.insertText），最多重试 3 次。每次都校验
  // 「DOM 含文本 且 提交按钮真的亮起（aria-disabled≠true）」——只有按钮亮了才算真正写进 Flow 的 state。
  // 单点 CDP 偶发不生效时，重试能显著提高一次成功率（novri-ra 同样用重试解决 Slate/ProseMirror 偶发拒收）。
  for (let attempt = 0; attempt < 3 && !wrote; attempt++) {
    try {
      const r0 = inp.getBoundingClientRect();
      const cx0 = Math.round(r0.left + r0.width / 2);
      const cy0 = Math.round(r0.top + r0.height / 2);
      const resp = await bgRpc({ cmd: 'cdpType', x: cx0, y: cy0, text });
      // v1.5.22：必须是「整段严格相等」，不能用 includes ——
      // 上一条残留 + 本条追加时 includes 也为 true，会把上一条又提交一遍（重复生成）。
      const domHas = promptEquals(text, inp.innerText);
      const btnOk = isBtnEnabled();
      console.log('[Flow] setPrompt 策略0(CDP) 尝试' + (attempt + 1) + ' ok=' + (resp && resp.ok) + ' DOM=' + domHas + ' btn=' + btnOk);
      if (domHas && btnOk) { wrote = true; break; }
      if (domHas && !btnOk) { await sleep(400); if (isBtnEnabled()) { wrote = true; break; } }
    } catch (e) {
      console.warn('[Flow] setPrompt 策略0(CDP) 异常: ' + (e && e.message || e));
    }
    await sleep(300);
  }

  // ===== 退化：CDP 不可用（如已开 DevTools / 未授权 debugger）时退化为合成事件 =====
  if (!wrote) {
    clearEditor();
    await sleep(80);
  }


  // ===== 策略A: IME 组合输入（Slate 对 composition 有专用通路，比单纯 insertText 更易被接受） =====
  if (!wrote) {
    try {
      // 清空后再 insert（用 Range 放到 caret 处）
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const tn = document.createTextNode(text);
        range.insertNode(tn);
        placeCaretAt(tn, text.length);
      }
      inp.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, cancelable: true, data: '' }));
      inp.dispatchEvent(new CompositionEvent('compositionupdate', { bubbles: true, cancelable: true, data: text }));
      inp.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertCompositionText', data: text,
        bubbles: true, cancelable: true, composed: true
      }));
      inp.dispatchEvent(new InputEvent('input', {
        inputType: 'insertCompositionText', data: text,
        bubbles: true, composed: true
      }));
      inp.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, cancelable: true, data: text }));
      await sleep(250);
      // v1.5.22：必须是「整段严格相等」，不能用 includes ——
      // 上一条残留 + 本条追加时 includes 也为 true，会把上一条又提交一遍（重复生成）。
      const domHas = promptEquals(text, inp.innerText);
      const btnOk = isBtnEnabled();
      console.log('[Flow] setPrompt 策略A(IME组合) DOM=' + domHas + ' btn=' + btnOk);
      if (domHas && btnOk) wrote = true;
    } catch (e) {
      console.warn('[Flow] setPrompt 策略A 异常: ' + (e && e.message || e));
    }
  }

  // ===== 策略B: Range 直写文本节点 + beforeinput(insertText) =====
  if (!wrote) {
    try {
      clearEditor();
      const sel = window.getSelection();
      if (sel && sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        range.deleteContents();
        const tn = document.createTextNode(text);
        range.insertNode(tn);
        placeCaretAt(tn, text.length);
      }
      inp.dispatchEvent(new InputEvent('beforeinput', {
        inputType: 'insertText', data: text,
        bubbles: true, cancelable: true, composed: true
      }));
      inp.dispatchEvent(new InputEvent('input', {
        inputType: 'insertText', data: text,
        bubbles: true, composed: true
      }));
      await sleep(250);
      // v1.5.22：必须是「整段严格相等」，不能用 includes ——
      // 上一条残留 + 本条追加时 includes 也为 true，会把上一条又提交一遍（重复生成）。
      const domHas = promptEquals(text, inp.innerText);
      const btnOk = isBtnEnabled();
      console.log('[Flow] setPrompt 策略B(Range+insertText) DOM=' + domHas + ' btn=' + btnOk);
      if (domHas && btnOk) wrote = true;
    } catch (e) {
      console.warn('[Flow] setPrompt 策略B 异常: ' + (e && e.message || e));
    }
  }

  // ===== 策略C: 字符级键盘模拟（最贴近真实用户输入，慢但最稳） =====
  if (!wrote) {
    try {
      clearEditor();
      const len = text.length;
      for (let i = 0; i < len; i++) {
        const ch = text[i];
        const kc = ch.charCodeAt(0);
        const code = (ch >= 'a' && ch <= 'z') ? 'Key' + ch.toUpperCase()
                   : (ch >= 'A' && ch <= 'Z') ? 'Key' + ch.toUpperCase()
                   : (ch >= '0' && ch <= '9') ? 'Digit' + ch
                   : 'Unidentified';
        inp.dispatchEvent(new KeyboardEvent('keydown', {
          key: ch, code: code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true
        }));
        // 让 Slate/React 实际把字符插入 DOM（用 Range 在当前 caret 处插入文本节点）
        const sel = window.getSelection();
        if (sel && sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          range.deleteContents();
          const tn = document.createTextNode(ch);
          range.insertNode(tn);
          placeCaretAt(tn, 1);
        }
        inp.dispatchEvent(new InputEvent('beforeinput', {
          inputType: 'insertText', data: ch,
          bubbles: true, cancelable: true, composed: true
        }));
        inp.dispatchEvent(new InputEvent('input', {
          inputType: 'insertText', data: ch,
          bubbles: true, composed: true
        }));
        inp.dispatchEvent(new KeyboardEvent('keyup', {
          key: ch, code: code, keyCode: kc, which: kc, bubbles: true, cancelable: true, composed: true
        }));
        // 每 16 字符 yield 一次，避免长提示词把主线程卡太久
        if (i % 16 === 15) await sleep(0);
      }
      await sleep(250);
      // v1.5.22：必须是「整段严格相等」，不能用 includes ——
      // 上一条残留 + 本条追加时 includes 也为 true，会把上一条又提交一遍（重复生成）。
      const domHas = promptEquals(text, inp.innerText);
      const btnOk = isBtnEnabled();
      console.log('[Flow] setPrompt 策略C(字符级键盘) DOM=' + domHas + ' btn=' + btnOk);
      if (domHas && btnOk) wrote = true;
    } catch (e) {
      console.warn('[Flow] setPrompt 策略C 异常: ' + (e && e.message || e));
    }
  }

  // ===== 策略D: execCommand('insertText') 兜底 =====
  if (!wrote) {
    try {
      clearEditor();
      const ok = document.execCommand('insertText', false, text);
      await sleep(250);
      // v1.5.22：必须是「整段严格相等」，不能用 includes ——
      // 上一条残留 + 本条追加时 includes 也为 true，会把上一条又提交一遍（重复生成）。
      const domHas = promptEquals(text, inp.innerText);
      const btnOk = isBtnEnabled();
      console.log('[Flow] setPrompt 策略D(execCommand) ok=' + ok + ' DOM=' + domHas + ' btn=' + btnOk);
      if (domHas && btnOk) wrote = true;
    } catch (e) {
      console.warn('[Flow] setPrompt 策略D 异常: ' + (e && e.message || e));
    }
  }

  const finalDom = (inp.innerText || '').trim();
  const finalBtn = isBtnEnabled();
  console.log('[Flow] setPrompt 最终 DOM含文本=' + finalDom.includes(text) + ' 按钮可用=' + finalBtn + ' wrote=' + wrote);

  if (!finalDom.includes(text)) {
    throw new Error('setPrompt 失败：DOM 仍未含提示词，四种策略均未把文本写进文本框。请把 Console 的 [Flow] setPrompt 策略A/B/C/D 日志发我。');
  }
  if (!finalBtn) {
    throw new Error('setPrompt 部分成功：DOM 含提示词但 Flow 提交按钮仍不可用（aria-disabled=true）。\n' +
      'v1.4.6 已尝试 IME 组合 / Range 直写 / 字符级键盘 / execCommand 四种策略仍被拒。\n' +
      '可能原因：Flow Slate 编辑器已升级到只接受真实 isTrusted 键盘事件。临时自救：点 Flow 输入框【手动输入一两个字再删掉】让 React 同步，然后重新运行。\n' +
      '请把 Console 的 [Flow] setPrompt 策略A/B/C/D 日志发我。');
  }
}

// 失败时抓取真实页面状态，便于定位（不再靠猜）
function diagnose(startCount) {
  const tb = getPromptBox();
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

// 通过合成事件点击页面里第一个文本匹配的元素。
// 注意：旧版本(v1.3.x)曾引入 chrome.debugger(CDP) 真实点击，但 Flow 有反调试机制——
// 一旦 attach debugger 页面就会闪「已经开始调试此浏览器」并踢出/重载，整个扩展「不动」。
// v1.6/v1.7 正是纯靠合成事件(.click() / execCommand / KeyboardEvent)驱动的，实测可用，现回归此方案。
async function clickByText(texts, selector) {
  const btn = findButtonByText(texts, selector);
  if (!btn) return false;
  try { btn.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(200);
  try { btn.click(); } catch (_) {}
  await sleep(300);
  return true;
}

// 选模式：合成点击模式芯片（best-effort，被框架忽略也只是沿用默认，不致命）
async function setMode(mode) {
  const map = {
    text2img: ['图片', '图像', 'Image', 'Images', '文生图', 'Text to image'],
    text2video: ['视频', 'Video', 'Videos', '文生视频', 'Text to video'],
    img2img: ['图生图', 'Image to image', '图生图像'],
  };
  const texts = map[mode];
  if (!texts) return;
  // 模式芯片通常不是 button，多是 div；把候选范围放宽
  await clickByText(texts, 'button, [role="button"], [role="tab"], [role="option"], [role="radio"], div, span, a');
  await sleep(600);
}

// 设画幅（合成点击）
async function setAspectRatio(ratio) {
  if (!ratio) return false;
  const wanted = String(ratio).trim();
  const ok = await clickByText([wanted], 'button, [role="button"], [role="radio"], [role="option"], label, div');
  return ok;
}

// 选模型（合成点击：先点触发器展开，再点匹配项）
async function setModel(model) {
  if (!model) return;
  const trigger = findButtonByText([model, '模型', 'Model', 'Veo', 'Nano', 'Imagen', 'Gemini'], 'button, [role="button"], div, span, a');
  if (!trigger) return;
  try { trigger.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(150);
  try { trigger.click(); } catch (_) {}
  await sleep(600);
  // 再点一次匹配项（部分设计需要先展开下拉）
  const opt = findButtonByText([model], 'button, [role="button"], [role="option"], div, span, a');
  if (opt && opt !== trigger) {
    try { opt.scrollIntoView({ block: 'center' }); } catch (_) {}
    await sleep(150);
    try { opt.click(); } catch (_) {}
    await sleep(400);
  }
}

// 设视频时长（合成点击）
async function setDuration(duration) {
  if (!duration) return;
  await clickByText([duration], 'button, [role="button"], [role="option"], div, span');
  await sleep(400);
}

// 从一组候选按钮里挑出真正的「提交生成」按钮。
// 判定优先级（必须一眼锁定真实按钮，避免点错）：
//   ① 文本/aria 含 arrow_forward（真正的提交箭头图标，Material Symbols 连字名，绝不会是 add_2 等素材按钮）
//   ② 含 svg 图标且几乎无文字的图标按钮（就是提交箭头）
//   ③ aria-label 含 创建/生成/send/submit
//   ④ 该组里最靠右的按钮（提交箭头一定在输入栏最右侧）
// 同时明确【排除】“add_2 / add media / 添加素材”这类素材按钮（它们文本也含“创建”，但不是提交）。
function submitButtonLabel(button) {
  return [
    button.innerText, button.textContent, button.getAttribute('aria-label'),
    button.getAttribute('title'), button.getAttribute('data-tooltip'),
    button.getAttribute('data-testid'),
  ].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
}

function isCloseButton(button) {
  return /(^|[\s_-])(close|dismiss|cancel)(?=$|[\s_-])|关闭|取消|×/i.test(submitButtonLabel(button));
}

function pickSubmit(btns, promptBox) {
  const decoy = (b) => /add_2|add media|添加素材|upload|上载/i.test(
    (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')
  );
  // 展开提示词面板的 × 在提交箭头上方；它绝不能成为图标按钮的兜底候选。
  const clean = btns.filter((b) => !decoy(b) && !isCloseButton(b));
  // 不能在 clean 为空时恢复 btns：小容器里往往只有 close，恢复它会
  // 恰好造成“过滤了关闭按钮却仍点击关闭按钮”的反向回退。
  const cand = clean;
  if (!cand.length) return null;

  // ① Flow 的无障碍名称通常就是「开始生成」；同时兼容英文/Material 图标名。
  let b = cand.find((x) => /开始生成|开始创建|生成图片|arrow_forward|(^|\s)(send|submit|generate|create)(\s|$)/i.test(submitButtonLabel(x)));
  if (b) return b;
  // ② 未暴露名称时，取提示词所在同一行的最右按钮。这里必须严格按垂直中心
  // 对齐；展开层上方的 × 可能没有 aria-label，宽松的“同一容器”匹配会误点它。
  if (promptBox) {
    const p = promptBox.getBoundingClientRect();
    const row = cand.filter((x) => {
      const r = x.getBoundingClientRect();
      const cy = r.top + r.height / 2;
      const promptCy = p.top + p.height / 2;
      return r.width > 0 && r.height > 0 && r.left >= p.right - 24 &&
        Math.abs(cy - promptCy) <= 42;
    });
    if (row.length) {
      return row.sort((a, b2) => b2.getBoundingClientRect().right - a.getBoundingClientRect().right)[0];
    }
    // 有提示框却无法锁定同一行的提交按钮时，宁可失败也不能把上方的 ×
    // 当作“通用 SVG 图标”点击。
    return null;
  }
  // ③ 只在没有提示框时才允许普通图标兜底。
  b = cand.find((x) => x.querySelector('svg, [class*="icon"], [class*="Icon"]') && ((x.innerText || '').trim().length < 3));
  if (b) return b;
  // ④ aria-label 明确是创建/生成/发送
  b = cand.find((x) => /创建|生成|create|generate|send|submit/i.test(x.getAttribute('aria-label') || ''));
  if (b) return b;
  // ⑤ 最靠右
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
  // 当前 Flow 的稳定、唯一提交控件。先走精确选择器，避免在输入框的父级
  // 容器中先遇到“清除提示 / close”按钮。
  const direct = Array.from(document.querySelectorAll(
    'button.generate-icon-button[aria-label="开始生成"], button.generate-icon-button[aria-label*="生成"], button.generate-icon-button[aria-label*="Generate"]'
  )).find((b) => isVisible(b) && (!skipDisabled || !b.disabled));
  if (direct) return direct;
  // 1) 从 textbox 上升找包含它的「输入栏」，在栏内挑提交按钮
  const tb = getPromptBox();
  if (tb) {
    let bar = tb.parentElement;
    for (let i = 0; i < 8 && bar; i++) {
      let btns = Array.from(bar.querySelectorAll('button')).filter((b) => !b.contains(tb));
      btns = btns.filter((b) => isVisible(b)); // 排除隐藏/固定定位导致不可见的按钮
      if (skipDisabled) btns = btns.filter((b) => !b.disabled);
      if (btns.length) {
        const s = pickSubmit(btns, tb);
        if (s) return s;
      }
      bar = bar.parentElement;
    }
  }
  // 2) 兜底：全局找 arrow_forward 提交按钮（必须可见）
  for (const b of document.querySelectorAll('button')) {
    if (!isVisible(b)) continue;
    if (skipDisabled && b.disabled) continue;
    if (isCloseButton(b)) continue;
    if (/开始生成|开始创建|生成图片|arrow_forward|(^|\s)(send|submit|generate|create)(\s|$)/i.test(submitButtonLabel(b))) return b;
  }
  return null;
}

// 与 findGenerateButton 完全相同，但【不跳过 disabled 按钮】。
// 仅用于 confirmGenerationStarted：生成开始后提交按钮通常会变 disabled/busy，
// 此时若用 findGenerateButton（会跳过 disabled）就会永远找不到 → 误判“未进入生成状态”。
function findGenerateButtonAnyState() {
  return findGenerateButton(false);
}

async function clickGenerate(promptText = '') {
  // 提交 = CDP 硬件级鼠标点击（novri-ra/Flow-Auto-Prompter 验证可靠：Input.dispatchMouseEvent
  // mousePressed+mouseReleased 在按钮中心，React/Radix 无法拦截）。相对旧版纯合成事件的关键加固：
  // ① 点之前先等按钮真正「可点」（disabled=false 且 aria-disabled≠true）——禁用按钮点 CDP 也是白点；
  // ② 点击前做 (0,0)/零尺寸安全校验（Radix portal 会把隐藏元素返回 (0,0)，点了也白点）；
  // ③ CDP 点击后校验「是否进入生成」，未开始就重试 CDP 点击（最多 3 次）；
  // ④ 兜底：在文本框 CDP 派发真实 Enter 键（部分 Flow 版本监听 textbox 回车提交）。
  let btn = null;
  for (let i = 0; i < 40; i++) {
    btn = findGenerateButtonAnyState();
    if (btn) break;
    await sleep(500);
  }
  if (!btn) throw new Error('未找到生成按钮（按钮可能改版）。' + fullDiagnosticDump());
  console.log('[Flow] clickGenerate：找到提交按钮 disabled=' + btn.disabled + ' label="' + (btn.innerText || '').replace(/\s+/g, ' ').slice(0, 30) + '"');

  // ① 等按钮可点：禁用按钮点了也不触发 Flow 的提交 handler
  let enabled = false;
  for (let i = 0; i < 20; i++) {
    const b = findGenerateButtonAnyState();
    if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { btn = b; enabled = true; break; }
    await sleep(400);
  }
  if (!enabled) {
    throw new Error('提交按钮一直是禁用状态（disabled=' + btn.disabled + ' aria-disabled=' + (btn.getAttribute('aria-disabled') || '-') +
      '）。说明提示词没进入 Flow 的 React state（CDP 输入未生效/被拒）。请打开 Console 看 [Flow] setPrompt 策略0 日志，连同面板「执行轨迹」发我。');
  }

  // ② CDP 硬件级点击（带 (0,0)/零尺寸安全校验）
  const tryCdpClick = async (el) => {
    for (let k = 0; k < 2; k++) {
      try { el.scrollIntoView({ block: 'center', inline: 'center' }); } catch (_) {}
      await sleep(300); // 等滚动动画稳定（novri-ra 等 300ms）
      const rb = el.getBoundingClientRect();
      if (rb.width === 0 || rb.height === 0 || (rb.left === 0 && rb.top === 0)) {
        throw new Error('提交按钮尺寸为 0 或位于 (0,0)，跳过本次 CDP 点击（Radix portal 隐藏元素）');
      }
      const cxb = Math.round(rb.left + rb.width / 2);
      const cyb = Math.round(rb.top + rb.height / 2);
      const resp = await bgRpc({ cmd: 'cdpClick', x: cxb, y: cyb });
      console.log('[Flow] clickGenerate CDP click ok=' + (resp && resp.ok) + ' @(' + cxb + ',' + cyb + ')');
      if (resp && resp.ok) return true;
      await sleep(200);
    }
    return false;
  };

  // ③ 只做一次真实 CDP 点击。提示词被清空只是前端编辑器的状态变化，不能证明
  // Flow 已向后端提交；重复点击或向已清空的输入框发 Enter 既不能修复问题，还可能
  // 在页面真正恢复时重复扣额度。真正的开始信号由外层统一等待并核验。
  const startCountBefore = countMedia();
  const target = findGenerateButtonAnyState() || btn;
  const cdpClicked = await tryCdpClick(target);
  // Chrome 可能已有其他调试器连接（此时 CDP 会静默拒绝扩展的鼠标事件）。
  // target 已被精确锁定为 Flow 的 generate-icon-button，因此可安全回退到完整
  // DOM 鼠标事件序列；绝不再回退到任意图标/关闭按钮。
  if (!cdpClicked) {
    console.warn('[Flow] CDP 提交点击未执行，回退到精确发送按钮的 DOM 点击');
    forceClick(target);
  }
  await sleep(500);
  return confirmGenerationStarted(startCountBefore, 1500, promptText);
}

// v1.3.21: 已彻底移除 CDP（chrome.debugger）真实输入封装（cdpType / cdpClickSubmit / locateControls）。
// 原因：Flow 有反调试，一旦 attach debugger 页面就闪「已经开始调试此浏览器」并踢出/重载，导致扩展「不动」。
// 提交改回纯合成事件：提示词用 setPrompt（execCommand），提交用 clickGenerate（回车 + 点击箭头）。


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

// ===== v1.5.22：提示词「严格相等」比对（全局，setPrompt 与 generateOne 共用）=====
// 旧代码到处用 `innerText.includes(text)` 判定"提示词写入成功"。致命漏洞：
// 若上一条提示词没被清干净、本条被追加在后面，框里变成「上一条+本条」，
// includes 依然为 true → 判定成功 → 提交的内容带着上一条 → 生成出重复的图。
// 这正是用户"26 条提示词里重复 4 条"的主因。改为整段严格相等（先归一化空白/标点差异）。
function normPromptText(s) {
  return String(s || '')
    .replace(/[\u3000\s\u200b-\u200f\ufeff]+/g, '')   // 去所有空白（含全角空格、换行、零宽字符）
    .replace(/[“”‘’"'`]/g, '')                          // 统一引号
    .toLowerCase();
}
function promptEquals(expected, got) {
  const a = normPromptText(expected);
  if (!a) return true;
  const b = normPromptText(got);
  if (!b) return false;
  if (a === b) return true;
  // 二段兜底：ProseMirror 可能引入标点/连字符差异，再剥掉标点比一次
  const strip = (s) => s.replace(/[，。、；：！？,.!?;:()（）\[\]【】\-—_~·]/g, '');
  if (strip(a) === strip(b)) return true;
  // 三段兜底（放行档）：编辑器偶尔会在首尾多带少量字符（换行、不可见节点、序号图标等）。
  // 只有同时满足「长度接近」+「包含本条提示词的独有尾部」才放行——
  // 「上一条残留 + 本条追加」长度会明显超出，「完全没写进去」则不含本条尾部，两种情况都拦得住。
  const tail = a.slice(-40);
  if (tail.length >= 20 && b.includes(tail)) {
    const diff = Math.abs(a.length - b.length) / Math.max(a.length, 1);
    if (diff <= 0.15) return true;
  }
  return false;
}

// 确认页面真的开始生成了：生成按钮进入 loading/禁用，或出现进度条/生成中提示，
// 或媒体总数比点击前增加了，或输入框里的提示词被清空（Flow 提交后会清掉输入框）。
// 任一成立即视为已开始。等不到就返回 false。
async function confirmGenerationStarted(startCount, timeoutMs = 20000, promptText = '') {
  const t0 = Date.now();
  // 新版 Flow UI 的“生成中”文案更杂（正在生成 / 渲染中 / 排队 / 创建中 / generating / rendering ...），放宽匹配。
  // 不能匹配孤立的“生成”或“创建”：空闲提交按钮的固定文案正是“开始生成”，
  // 旧版因此每次点击前就把它误判成正在运行，直接跳进 180 秒的媒体等待。
  const busyRe = /\b(generating|creating|loading|rendering|processing|queued|working)\b|生成中|创建中|处理中|渲染中|排队中|正在生成|正在创建/i;
  while (Date.now() - t0 < timeoutMs) {
    // 按钮禁用 / 文案变为生成中（注意：必须用 AnyState 版本，因为生成中按钮是 disabled 的，
    // 普通 findGenerateButton 会跳过它，导致永远检测不到“已开始”，最终被误判为失败而中止）
    const btn = findGenerateButtonAnyState();
    if (btn) {
      const label = ((btn.innerText || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim();
      // 空输入框本身也会让提交按钮 disabled；不能再把它当作“生成中”。
      // 只有明确 busy 状态或生成中标签才算后端已经开始。
      if (btn.getAttribute('aria-busy') === 'true' || busyRe.test(label)) {
        return true;
      }
    }
    // 只认可可见的进度组件。Flow 的页面根节点和懒加载资源常年带 aria-busy/
    // loading class，若全局搜索会在空白画布上误报“正在生成”。
    const visibleProgress = Array.from(document.querySelectorAll('[role="progressbar"], .progress, .spinner, .loader, [class*="spinner"], [class*="Spinner"]'))
      .some((el) => isVisible(el));
    if (visibleProgress) {
      return true;
    }
    // 注意：新版 Flow 点击后可能只清空 Slate 编辑器，并不发生成请求；因此不能
    // 用“输入框为空”作为成功依据，必须看到忙碌、进度、媒体或网络诊断中的请求。
    // 媒体总数增加（说明有新内容产生，作为上面按钮检测的兜底）
    if (countMedia() > startCount) return true;
    await sleep(400);
  }
  return false;
}

async function getBackendDiagnostics() {
  const pageErrors = [];
  const nodes = Array.from(document.querySelectorAll('[role="alert"], [role="status"], [aria-live], [data-sonner-toast], [class*="toast" i], [class*="error" i]'));
  for (const node of nodes) {
    const text = (node.innerText || node.textContent || '').trim().replace(/\s+/g, ' ');
    if (text && text.length < 500 && /错误|失败|额度|限制|稍后|error|failed|quota|limit|blocked|safety/i.test(text)) pageErrors.push(text);
  }
  let trace = [];
  try {
    const r = await bgRpc({ cmd: 'cdpDiagnostics' });
    if (r && Array.isArray(r.trace)) trace = r.trace;
  } catch (_) {}
  return { pageErrors: Array.from(new Set(pageErrors)).slice(0, 10), trace: trace.slice(-20) };
}

// v1.5.22：Flow 结果区同一张成品图常同时存在「网格缩略图」和「大图预览」两个 <img>，
// 两者 blob URL 不同、像素尺寸不同 → 单纯按 URL 或 dataUrl 去重都拦不住 → 同一张图被下载 2 份
// （用户看到的"26 条里有 4 个重复"）。
// 判定条件刻意收紧，避免误杀「一次生成多张不同的图」：
//   ① 两者互为祖先/后代，或最近公共祖先内只有它们俩这两个媒体节点；
//   ② 且两者 naturalWidth 相差 >20%（缩略图 vs 大图的特征；多张并列成品图尺寸基本一致）。
function dedupeMediaByDom(list) {
  const area = (el) => (el.naturalWidth || el.clientWidth || 0) * (el.naturalHeight || el.clientHeight || 0);
  const ancestorOf = (a, b) => {
    let n = b;
    while (n && n !== document.body && n !== document.documentElement) { if (n === a) return true; n = n.parentElement; }
    return false;
  };
  const lca = (a, b) => {
    const chain = new Set();
    let n = a;
    while (n) { chain.add(n); n = n.parentElement; }
    n = b;
    while (n) { if (chain.has(n)) return n; n = n.parentElement; }
    return null;
  };
  const out = [];
  for (const el of list) {
    let dupIdx = -1;
    for (let i = 0; i < out.length; i++) {
      const k = out[i];
      if (k === el) { dupIdx = i; break; }
      if (ancestorOf(k, el) || ancestorOf(el, k)) { dupIdx = i; break; }
      const p = lca(k, el);
      if (p && p !== document.body && p !== document.documentElement) {
        if (p.querySelectorAll('img, video').length <= 2) {
          const w1 = k.naturalWidth || 0, w2 = el.naturalWidth || 0;
          if (w1 && w2 && Math.abs(w1 - w2) / Math.max(w1, w2) > 0.2) { dupIdx = i; break; }
        }
      }
    }
    if (dupIdx >= 0) { if (area(el) > area(out[dupIdx])) out[dupIdx] = el; continue; }
    out.push(el);
  }
  return out;
}

// 收集 click 之后“新出现”的 img 与 video（排除占位图、排除已知 URL）
async function collectNewMedia(knownKeys, timeoutMs = 180000) {
  const t0 = Date.now();
  const promptBox = getPromptBox(); // 参考图就嵌在提示框里，必须整体排除（不只靠 src 匹配，避免 re-render 后漏排）
  const pick = (el) => {
    const s = (el.src || el.currentSrc || '');
    if (!s) return false;
    if (s === attachedReferenceSrc) return false;       // 排除刚粘贴进提示框的参考图（它会出现在 DOM 里，但不算结果）
    if (promptBox && promptBox.contains(el)) return false; // 提示框内的图（参考图缩略图）不算结果
    if (s.includes(PLACEHOLDER_KEY)) return false;
    if (!(s.startsWith('blob:') || s.startsWith('http'))) return false;
    return !knownKeys.has(s);
  };
  const scan = () => ({
    imgs: dedupeMediaByDom(Array.from(document.querySelectorAll('img')).filter(pick)),
    vids: dedupeMediaByDom(Array.from(document.querySelectorAll('video')).filter(pick)),
  });
  let last = { imgs: [], vids: [] };
  while (Date.now() - t0 < timeoutMs) {
    // v1.5.22：先等待再扫描。旧代码是「先扫描后等待」，第一轮在点击后几乎立刻执行，
    // 会抓到上一条成品图 re-render 出的新 blob URL（不在 knownKeys 里）→ 把上一张图又下一遍。
    await sleep(2000);
    const found = scan();
    if (found.imgs.length || found.vids.length) {
      last = found;
      // 再确认一次：Flow 常先渲染低清占位、随后才换成成品，直接返回第一帧会抓错/抓重。
      await sleep(3500);
      const again = scan();
      if (again.imgs.length || again.vids.length) return again;
      return last;
    }
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
  // 单文件注入（保留旧接口）；多文件请直接用 injectFilesIntoInput
  return injectFilesIntoInput(input, [file]);
}
// 把一组文件【一次性】注入 file input。关键点：
// ① 必须放进【同一个 DataTransfer】再整体写入——逐个 item 分别 set 会互相覆盖，只剩最后一张
//    （这是过去“参考图只进了 1 张 / 上传不生效”的真正根因）。
// ② 用原型上的原生 files setter 写入，比直接赋值 input.files 更能被 React 的 onChange 捕获。
// ③ 派发 change + input 事件（input 事件对部分框架是触发 onChange 的关键），并返回是否真的写进去了。
async function injectFilesIntoInput(input, fileList) {
  const dt = new DataTransfer();
  for (const f of fileList) { try { dt.items.add(f); } catch (_) {} }
  if (dt.files.length === 0) return false;
  let setOk = false;
  try {
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'files');
    if (desc && desc.set) { desc.set.call(input, dt.files); setOk = true; }
    else { input.files = dt.files; setOk = true; }
  } catch (_) {
    try { input.files = dt.files; setOk = true; } catch (_) { setOk = false; }
  }
  try { input.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  try { input.dispatchEvent(new Event('input', { bubbles: true })); } catch (_) {}
  try { document.dispatchEvent(new Event('change', { bubbles: true })); } catch (_) {}
  await sleep(600);
  return !!(input.files && input.files.length >= 1);
}
async function clickUploadTrigger() {
  // 优先点“添加媒体 / 上传媒体 / add media”这种真正打开上传入口的按钮；
  // 避免误点“查看已上传的媒体内容”（只读媒体库）或“添加”菜单触发（点了没用）。
  const prefer = ['添加媒体', '上传媒体', 'add media', 'upload media', '上传图片', '上传图像', '添加图片', '添加图像', '上传文件', '上传参考图'];
  const fallback = ['上传', '添加', '导入', '选择文件', '选择图片', '选择图像', 'add', 'upload', 'import', 'choose', '选择', '图片', '照片', '从设备', '添加媒体', '查看已上传的媒体内容', '媒体内容'];
  let trigger = findButtonByText(prefer, 'button, [role="button"], div, span, a');
  if (!trigger) trigger = findButtonByText(fallback, 'button, [role="button"], div, span, a');
  if (!trigger) return false;
  try { trigger.scrollIntoView({ block: 'center' }); } catch (_) {}
  await sleep(200);
  try { trigger.click(); } catch (_) {}
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
async function waitForUploadDone(expected, timeoutMs, input, log) {
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
    if (newCount >= expected) { if (log) log.push('检测到 ' + newCount + ' 个新缩略图/图片'); return { ok: true, newCount }; }
    await sleep(800);
  }
  // 兜底①：注入确实把文件放进 input 了（files 达标）→ 视为上传已触发，放行
  if (input && input.files && input.files.length >= expected) {
    if (log) log.push('文件已注入 input.files(' + input.files.length + ')，视为已上传');
    console.warn('[Flow扩展] 未检测到新缩略图，但文件已注入 input（files=' + input.files.length + '），视为上传已触发，放行');
    return { ok: true, newCount: input.files.length, note: 'injected-but-no-thumbnail' };
  }
  // 兜底②：再算一次有没有新增 img/缩略图
  const now2 = snapMarkers();
  let newCount = 0;
  for (const s of now2) if (!before.has(s)) newCount++;
  if (newCount > 0) return { ok: true, newCount };
  return { ok: false, error: '上传后未在页面检测到新缩略图（Flow 的上传 UI 可能与预期不同，或上次残留的旧图未清空）。', diagnostic: dumpUploadArea() };
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

  const log = [];
  const step = (s) => { log.push(s); console.log('[Flow上传] ' + s); };

  // 策略A：直接注入已存在的 file input（含隐藏的 sc-dcc7b7da-0 fhJvUC 之类）
  step('策略A：查找已存在的 file input');
  let input = findFileInput();
  if (input) {
    step('找到 input(accept=' + (input.getAttribute('accept') || '') + ' hidden=' + input.hidden + ' class=' + (input.className || '') + ')');
    const ok = await injectFilesIntoInput(input, files);
    step('注入结果: ' + (ok ? ('input.files=' + (input.files ? input.files.length : 0)) : '失败（input.files 仍为 0，说明该 input 未与 Flow 的 React 状态绑定）'));
    const r = await waitForUploadDone(files.length, 30000, input, log);
    if (r.ok) { step('策略A 成功'); return r; }
    step('策略A 未成功（' + (r.error || '') + '），改走按钮触发');
  } else {
    step('策略A：未发现任何 file input');
  }

  // 策略B：点“添加媒体 / 上传”按钮，等真正的上传入口出现后再注入（点一次后循环探测新出现的 input）
  step('策略B：点击“添加媒体/上传”按钮触发上传入口');
  await clickUploadTrigger();
  await sleep(1200);
  for (let i = 0; i < 12; i++) {
    input = findFileInput();
    if (input && input.files && input.files.length >= files.length) { step('策略B：input 已有 ' + input.files.length + ' 个文件，跳过注入'); break; }
    if (input) {
      step('策略B：向第 ' + i + ' 次找到的 input 一次性注入 ' + files.length + ' 个文件');
      const ok = await injectFilesIntoInput(input, files);
      step('注入结果: ' + (ok ? ('input.files=' + (input.files ? input.files.length : 0)) : '失败'));
      const r = await waitForUploadDone(files.length, 30000, input, log);
      if (r.ok) { step('策略B 成功'); return r; }
    }
    await sleep(800);
  }

  // 策略C：拖拽区
  step('策略C：尝试拖拽区');
  const zone = document.querySelector('[class*="drop"], [class*="Drop"], [data-test*="drop"], [class*="upload"], [class*="Upload"]');
  if (zone && zone.tagName !== 'INPUT') {
    await uploadViaDropZone(zone, files);
    const r = await waitForUploadDone(files.length, 30000, input, log);
    if (r.ok) { step('策略C 成功'); return r; }
  }

  // 三种策略都失败：给出明确、可操作的结论，而不是一堆看不懂的 DOM
  const diag = dumpUploadArea() + '\n\n上传步骤记录:\n' + log.join('\n');
  return {
    ok: false,
    error: '图片上传失败（已尝试 ①直接注入 ②点击「添加媒体」按钮触发 ③拖拽区 三种策略）。' +
      '最可能的原因：Flow 新版的上传入口依赖「原生文件选择框 / Google 云端硬盘选择器」，扩展无法替你自动选文件。' +
      '建议：A) 改用「文生图」模式（不需要上传参考图，最稳）；B) 若必须用参考图，请先手动点「添加媒体」把图传好，再运行本扩展（它会复用已上传的媒体）。',
    diagnostic: diag,
  };
}

// ============ v1.5.6：图生图参考图挂接（对齐 czdtech/flowauto-extension 实测可用做法）============
// 实证结论（来自开源 czdtech/flowauto-extension，唯一把 img2img 做完整且能跑的扩展）：
//   1) 主路径 = 把图片当 File 用 ClipboardEvent 粘贴进提示框，但 clipboardData 必须在【构造函数】里传。
//      v1.5.5 用 Object.defineProperty 事后改写 → Chrome 静默失败 → Slate 读不到 file → 参考图没挂上（第一轮失败根因）。
//   2) 粘贴失败 → 回退「拦截 Flow 上传按钮的 file input.click() 注入文件」→ 再回退拖拽。
//   3) 真值校验 = 页面新出现 media.getMediaUrlRedirect?name=<UUID>（不是只看提示框里有没有 <img>）。
//   4) 等待必须非阻塞：等进度条出现→消失，最多几秒就放弃，绝不硬等 60s（否则每条都白等 60s 变「很慢」）。
// 全程不用 CDP / chrome.debugger（Flow 反调试会踢页），纯合成事件即可。

// 模块级状态
let charRefProjectEntered = false; // charRef 首条进项目，后续条复用（不 reload、不重建）
let attachedReferenceSrc = '';      // 刚挂接的参考图 src，下载时排除（次级保险，主要靠提示框内 img 排除）

// forceClick：完整指针/鼠标事件序列 + 坐标，React 吞不掉裸 .click()
function forceClick(el) {
  if (!el || !(el instanceof HTMLElement)) return false;
  try { el.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } catch (_) {}
  try { el.focus(); } catch (_) {}
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const common = { bubbles: true, cancelable: true, composed: true, clientX: cx, clientY: cy, view: window, button: 0 };
  try { el.dispatchEvent(new PointerEvent('pointerdown', { ...common, pointerId: 1, pointerType: 'mouse', isPrimary: true, buttons: 1 })); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mousedown', { ...common, buttons: 1 })); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('mouseup', { ...common, buttons: 0 })); } catch (_) {}
  try { el.dispatchEvent(new MouseEvent('click', { ...common })); } catch (_) {}
  return true;
}

// ---- 通用小工具 ----
function randSleep(a, b) { return sleep(a + Math.random() * (b - a)); }
function normalizeForMatch(s) { return (s || '').toLowerCase().replace(/\s+/g, ' ').trim(); }
function getElementName(el) {
  if (!el || !el.getAttribute) return '';
  const parts = [];
  const a = el.getAttribute('aria-label'); if (a) parts.push(a);
  const t = el.getAttribute('title'); if (t) parts.push(t);
  const r = el.getAttribute('role'); if (r) parts.push(r);
  const it = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim(); if (it) parts.push(it);
  return parts.join(' ');
}
function isVisible(el) {
  if (!el) return false;
  const r = el.getBoundingClientRect();
  return (r.width > 0 && r.height > 0) || (el.offsetWidth > 0 && el.offsetHeight > 0);
}
async function waitFor(fn, opts) {
  opts = opts || {};
  const timeoutMs = opts.timeoutMs || 8000, intervalMs = opts.intervalMs || 300;
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { if (fn()) return true; } catch (_) {}
    await sleep(intervalMs);
  }
  return false;
}

// ---- 媒体 UUID 真值校验（czdtech 验证方式）----
const MEDIA_UUID_RE = /media(?:\.getMediaUrlRedirect|\/).*?[?&/]name[=/]([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;
function collectMediaUuids() {
  const uuids = new Set();
  const imgs = document.querySelectorAll('img');
  for (const img of imgs) {
    const src = img.src || img.getAttribute('src') || '';
    let m = src.match(MEDIA_UUID_RE); if (m) uuids.add(m[1]);
    const ds = img.getAttribute('data-src') || ''; m = ds.match(MEDIA_UUID_RE); if (m) uuids.add(m[1]);
  }
  return uuids;
}
function captureNewMediaUuid(before) {
  const after = collectMediaUuids();
  for (const u of after) if (!before.has(u)) return u;
  return undefined;
}

// ---- 非阻塞上传等待（不再硬等 60s）----
function hasVisibleProgress() {
  const inds = document.querySelectorAll('[role="progressbar"], [aria-busy="true"], [class*="progress"], [class*="spinner"], [class*="loading"]');
  for (const el of inds) { if (el instanceof HTMLElement && el.offsetWidth > 0 && el.offsetHeight > 0) return true; }
  const cand = document.querySelectorAll('span, div, p');
  for (const el of cand) {
    if (el.childElementCount > 0) continue;
    const txt = (el.textContent || '').trim();
    if (/^\d{1,3}\s*%$/.test(txt) && el instanceof HTMLElement && el.offsetWidth > 0) return true;
  }
  return false;
}
async function waitForUploadComplete() {
  let started = false;
  for (let i = 0; i < 10; i++) { await sleep(500); if (hasVisibleProgress()) { started = true; break; } }
  if (!started) { await sleep(1500); return; } // 没出现进度条，可能已秒传，短等即返回
  try { await waitFor(() => hasVisibleProgress() ? null : true, { timeoutMs: 60000, intervalMs: 1000 }); } catch (_) {}
  await sleep(1200);
}

// ---- 策略 A：粘贴（clipboardData 在构造函数里传 —— 关键修复点）----
async function tryPasteReference(blob, filename, D) {
  const box = getPromptBox();
  if (!box) return false;
  box.focus();
  try {
    const sel = window.getSelection();
    if (sel && sel.rangeCount > 0) { const r = document.createRange(); r.selectNodeContents(box); r.collapse(false); sel.removeAllRanges(); sel.addRange(r); }
  } catch (_) {}
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  const dt = new DataTransfer(); dt.items.add(file);
  const evt = new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt });
  box.dispatchEvent(evt);
  D('参考图已按构造函数 clipboardData paste 进提示框: ' + filename);
  await waitForUploadComplete();
  return true;
}

// ---- 资源面板 / 上传按钮定位（用于策略 B）----
function findPromptAddButton() {
  const btns = Array.from(document.querySelectorAll('button'));
  for (const btn of btns) {
    if (!isVisible(btn)) continue;
    const n = normalizeForMatch(getElementName(btn));
    if (n.includes('add_2') && n.includes('创建')) return btn;
  }
  for (const btn of btns) {
    if (!isVisible(btn)) continue;
    const n = normalizeForMatch(getElementName(btn));
    if (n.includes('add_2')) return btn;
  }
  return null;
}
function isResourcePanelOpen() { const b = findPromptAddButton(); return !!b && b.getAttribute('aria-expanded') === 'true'; }
async function openResourcePanel() {
  if (isResourcePanelOpen()) return;
  const b = findPromptAddButton(); if (!b) throw new Error('未找到提示词旁的 "+"(add_2) 按钮');
  forceClick(b);
  await waitFor(isResourcePanelOpen, { timeoutMs: 5000, intervalMs: 300 });
  await randSleep(250, 500);
}
async function closeResourcePanel() {
  if (!isResourcePanelOpen()) return;
  const b = findPromptAddButton(); if (b) forceClick(b);
  await randSleep(300, 600);
  if (isResourcePanelOpen()) { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await randSleep(300, 600); }
}
function findUploadButtonInPanel() {
  const all = Array.from(document.querySelectorAll('button, [role="menuitem"], [role="button"]'));
  for (const el of all) {
    if (!isVisible(el)) continue;
    const n = normalizeForMatch(getElementName(el));
    if ((n.includes('上传') || n.includes('upload')) && !n.includes('添加媒体')) return el;
  }
  return null;
}

// ---- 策略 B：拦截 Flow 上传按钮的 file input.click() 注入文件 ----
function armFileInputInterception(file, timeoutMs) {
  timeoutMs = timeoutMs || 8000;
  let observer = null, timer = null, resolved = false, resolve;
  const armed = [];
  const promise = new Promise((res) => { resolve = res; });
  const finish = (ok) => {
    if (resolved) return; resolved = true;
    if (observer) observer.disconnect();
    if (timer) clearTimeout(timer);
    for (const inp of armed) { try { delete inp.click; } catch (_) {} }
    resolve(ok);
  };
  const armInput = (input) => {
    if (armed.includes(input)) return; armed.push(input);
    input.click = function () {
      const dt = new DataTransfer(); dt.items.add(file);
      try { this.files = dt.files; } catch (_) {}
      try { delete this.click; } catch (_) {}
      this.dispatchEvent(new Event('change', { bubbles: true }));
      try {
        const rKey = Object.keys(this).find((k) => k.indexOf('__reactProps') === 0);
        if (rKey) { const props = this[rKey]; if (props && typeof props.onChange === 'function') props.onChange({ target: this, currentTarget: this }); }
      } catch (_) {}
      finish(true);
    };
  };
  const existing = document.querySelectorAll('input[type="file"]');
  for (const inp of existing) armInput(inp);
  observer = new MutationObserver((muts) => {
    for (const m of muts) for (const node of m.addedNodes) {
      if (node instanceof HTMLInputElement && node.type === 'file') { armInput(node); return; }
      if (node instanceof Element) { const inp = node.querySelector('input[type="file"]'); if (inp) { armInput(inp); return; } }
    }
  });
  observer.observe(document.body || document.documentElement, { childList: true, subtree: true });
  timer = setTimeout(() => { finish(false); }, timeoutMs);
  return { promise, disarm: () => finish(false) };
}
async function tryResourcePanelUpload(blob, filename, D) {
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  await openResourcePanel();
  await randSleep(400, 800);
  const uploadBtn = await waitFor(() => findUploadButtonInPanel(), { timeoutMs: 5000, intervalMs: 300 });
  if (!uploadBtn) { await closeResourcePanel().catch(() => {}); return false; }
  const armed = armFileInputInterception(file, 8000);
  forceClick(uploadBtn);
  const ok = await armed.promise;
  await waitForUploadComplete();
  await closeResourcePanel().catch(() => {});
  D('资源面板 file-input 注入' + (ok ? '成功' : '未被触发'));
  return ok;
}

// ---- 策略 C：拖拽兜底 ----
async function tryDragDrop(blob, filename, D) {
  const file = new File([blob], filename, { type: blob.type || 'image/png' });
  const box = getPromptBox();
  const dropTarget = (box && box.closest('form')) || box || document.body;
  if (!dropTarget) return false;
  const dt = new DataTransfer(); dt.items.add(file);
  const rect = dropTarget.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const o = { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy };
  dropTarget.dispatchEvent(new DragEvent('dragenter', o)); await sleep(50);
  dropTarget.dispatchEvent(new DragEvent('dragover', o)); await sleep(50);
  dropTarget.dispatchEvent(new DragEvent('drop', o));
  D('已派发拖拽事件到提示框');
  await waitForUploadComplete();
  return true;
}

// ---- 主注入：策略链 + UUID 真值校验 ----
async function injectReferenceImage(blob, filename, D) {
  const before = collectMediaUuids();
  try { if (await tryPasteReference(blob, filename, D)) { await randSleep(800, 1500); if (captureNewMediaUuid(before)) return true; } } catch (e) { D('paste 失败: ' + ((e && e.message) || e)); }
  try { if (await tryResourcePanelUpload(blob, filename, D)) { await randSleep(800, 1500); if (captureNewMediaUuid(before)) return true; } } catch (e) { D('资源面板上传失败: ' + ((e && e.message) || e)); }
  try { if (await tryDragDrop(blob, filename, D)) { await randSleep(800, 1500); if (captureNewMediaUuid(before)) return true; } } catch (e) { D('拖放失败: ' + ((e && e.message) || e)); }
  return false;
}

// 清掉提示框内已挂接的参考图（每条前清，避免继承上一条）
async function clearAttachedReferences() {
  try {
    const box = getPromptBox();
    if (!box) return;
    for (const im of Array.from(box.querySelectorAll('img'))) {
      const rm = im.closest('button, [role="button"], [class*="remove" i], [class*="close" i]')
        || (im.parentElement && im.parentElement.querySelector('button, [role="button"]'));
      if (rm) { try { forceClick(rm); } catch (_) {} }
    }
    let p = box.parentElement, d = 0;
    while (p && d < 6) {
      const rmBtns = Array.from(p.querySelectorAll('button, [role="button"]')).filter((b) => {
        const t = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return /移除|删除|remove|delete|取消|clear|清除|×/.test(t);
      });
      if (rmBtns.length) { rmBtns.forEach((b) => { try { forceClick(b); } catch (_) {} }); break; }
      p = p.parentElement; d++;
    }
    const remaining = Array.from(box.querySelectorAll('img'));
    if (remaining.length > 0) {
      remaining.forEach((im) => { try { im.remove(); } catch (_) {} });
      try { box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContent' })); } catch (_) {}
    }
    attachedReferenceSrc = '';
  } catch (_) {}
}

// 挂接参考图：清 → 逐张 dataURL→blob → 注入（策略链 + UUID 校验）
async function attachReferenceImages(images, mode, D) {
  D = D || ((s) => console.log('[Flow] ' + s));
  await clearAttachedReferences();
  await sleep(400);
  let anyAttached = false;
  for (let i = 0; i < images.length; i++) {
    D('正在挂接参考图 ' + (i + 1) + '/' + images.length);
    let blob;
    try { blob = await dataUrlToBlob(images[i]); } catch (e) { D('参考图 ' + (i + 1) + ' 解码失败: ' + ((e && e.message) || e)); continue; }
    const ok = await injectReferenceImage(blob, 'ref_' + i + '.png', D);
    anyAttached = anyAttached || ok;
    if (i < images.length - 1) await sleep(400);
  }
  const box = getPromptBox();
  if (box) { const im = box.querySelector('img'); attachedReferenceSrc = (im && (im.src || im.currentSrc)) || ''; }
  return { ok: true, attached: anyAttached };
}

async function generateOne(prompt, options = {}) {
  const dbg = [];
  const D = (s) => { dbg.push(s); console.log('[Flow] ' + s); };
  const count = Math.max(1, Math.min(8, options.count || 1));
  const aspectRatio = options.aspectRatio || '';
  const mode = options.mode || 'text2img';
  D('开始 generateOne: mode=' + mode + ' effectiveMode=' + (options.charRef ? 'img2img' : mode) + ' prompt="' + prompt.slice(0, 40) + '" count=' + count);

  // ===== 角色参考图：固定人物（视觉一致）=====
  // 启用后把参考图作为图生图(img2img)的基准图，每张批量图都基于同一人物生成。
  const charRef = options.charRef || null;
  const charRefImages = charRef ? [charRef] : [];
  const effectiveMode = charRef ? 'img2img' : mode;
  // charRef 每个 generateOne（即每个提示词批次）重置：首条进入新项目，本批次后续条复用同一项目（不 rebuild / 不 reload）
  charRefProjectEntered = charRef ? false : charRefProjectEntered;

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

  // 固定人物(charRef)：本批次首条 newProject=true 进新项目；之后 charRefProjectEntered=true 复用同一项目，不再 ensureNewProject。
  // 这样多条批量共享同一参考图、同一画布——既修「第二条很慢」（不再每条重建项目），又修「图生图链式漂移」（始终基于原始参考图）。
  const newProject = charRef ? !charRefProjectEntered : (options.newProject !== false);

  // 按模式选用对应模型：视频类模式用 videoModel，图片类用 imageModel，否则退回通用 model
  const isVideoMode = ['text2video', 'frame2video', 'ingredients'].includes(effectiveMode);
  const model = (isVideoMode ? (options.videoModel || options.model) : (options.imageModel || options.model)) || '';
  const duration = options.duration || '';
  const timeoutMs = options.timeoutMs || 180000;

  if (newProject) {
    const ok = await ensureNewProject();
    D('ensureNewProject 结果=' + ok + ' (isNewFlowUI=' + isNewFlowUI() + ')');
    if (!ok) {
      const ok2 = await ensureCanvas();
      D('ensureCanvas 结果=' + ok2);
      if (!ok2) return { ok: false, error: '未能进入编辑器画布（超时）。请确认已在 Flow 项目页并登录。', diagnostic: fullDiagnosticDump() + '\n\n执行轨迹:\n' + dbg.join('\n') };
    } else {
      // 仅在确实进入新项目后标记，后续条复用同一项目（charRef 不重建/不 reload）
      charRefProjectEntered = true;
    }
  } else {
    const ok = await ensureCanvas();
    D('ensureCanvas 结果=' + ok);
    if (!ok) return { ok: false, error: '未能进入编辑器画布（超时）。', diagnostic: fullDiagnosticDump() + '\n\n执行轨迹:\n' + dbg.join('\n') };
  }

  // 选模式/模型/画幅（best-effort：这些合成点击即便被框架忽略也只是沿用默认，不致命）
  try { if (effectiveMode) await setMode(effectiveMode); } catch (_) {}
  try { if (model) await setModel(model); } catch (_) {}
  try { if (aspectRatio) await setAspectRatio(aspectRatio); } catch (_) {}
  try { if (duration) await setDuration(duration); } catch (_) {}

  // 图生视频 / 成分动画：先上传图片素材，再生成。上传后再快照“已有图”，把刚上传的素材一并视为输入、不误下载。
  if (effectiveMode === 'img2img' && charRefImages.length) {
    // 角色固定（图生图）：把参考图作为 File 直接粘贴进 Slate 提示框，Flow 自动嵌入为参考图。
    // 证据：czdtech/flowauto-extension、tkhieu/auto_flow_chrome_ext 等开源扩展都这么做（不存在可靠「添加到提示」按钮）。
    // 带真值校验：提示框内出现 <img> 才算挂上，否则静默失败——这正是之前反复栽跟头的根因。
    const up = await attachReferenceImages(charRefImages, 'img2img', D);
    if (!up.ok) return { ok: false, error: '参考图挂接失败：' + (up.error || '未知'), diagnostic: dbg.join('\n') };
    if (!up.attached) D('⚠️ 参考图疑似未挂上（提示框内未出现 <img>），但仍继续生成（可能 Flow 已静默接受）');
  } else if (['frame2video', 'ingredients'].includes(effectiveMode)) {
    const up = await uploadImagesToFlow(options.images || [], effectiveMode);
    if (!up.ok) return { ok: false, error: up.error, diagnostic: up.diagnostic || '' };
  }

  // 先记录“点击前已有的图”URL（这些都属于旧图，绝不能误下载）
  const knownKeys = snapshotMediaUrls();
  const startCount = countMedia();

  // 真正把提示词敲进框 + 点下提交：CDP 硬件级输入（setPrompt 用 Input.insertText、clickGenerate 用
  // Input.dispatchMouseEvent 真实点击 + 文本框真实 Enter）。顶部黄色「正在调试此浏览器」横幅是 CDP 正常信号，无需处理。
  async function typePrompt() {
    try { await setPrompt(prompt); } catch (e2) { throw new Error('填词失败：' + ((e2 && e2.message) || e2)); }
  }
  async function clickSubmit() {
    try { await clickGenerate(prompt); } catch (e2) { throw new Error('点击生成失败：' + ((e2 && e2.message) || e2)); }
  }

  const items = [];
  // v1.3.17: 提示词读回验证——避免"输入框还残留上一条提示词"导致连续生成同一张图
  function readPromptInBox() {
    const tb = getPromptBox();
    return tb ? (tb.innerText || '').trim() : '';
  }
  // v1.5.22 修「重复生成同一张图」的真根因：
  // 旧逻辑只比对前/后 24 个字符的 includes。批量提示词常常共享同一段前缀
  // （例如都以 "Clean flat 2D cartoon animation style, ..." 开头），
  // 于是输入框里其实还残留着【上一条】提示词时，也会被判定为"匹配通过"，
  // 结果把上一条又提交了一遍 → 生成出重复的图。
  // 现改为整段精确比对（先归一化空白），只有内容完全一致才算写入成功；
  // 宁可明确报错，也不要静默地把上一条重复生成一次。
  // 直接用全局严格比对（去空白/引号/标点差异后整段相等），避免"残留上一条"被判通过。
  function verifyPromptInBox(expected, got) {
    return promptEquals(expected, got);
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
      return { ok: false, error: '提示词写入后读回不匹配：预期="' + prompt.slice(0, 40) + '..."，实际="' + promptInBox.slice(0, 60) + '"。Flow 可能改了输入框行为，请把「🔍 复制页面诊断」发我。', diagnostic: fullDiagnosticDump() + '\n\n执行轨迹:\n' + dbg.join('\n') };
    }
    const genBtn0 = findGenerateButtonAnyState();
    D('填词后：DOM含提示词=' + verifyPromptInBox(prompt, promptInBox) + ' | 提交按钮存在=' + !!genBtn0 + ' | disabled=' + (genBtn0 ? genBtn0.disabled : 'n/a') + (genBtn0 ? (' | label="' + (genBtn0.innerText || '').replace(/\s+/g, ' ').slice(0, 30) + '"') : ''));
    try { await clickSubmit(); } catch (e) {
      return { ok: false, error: (e && e.message) || String(e), diagnostic: '\n\n执行轨迹:\n' + dbg.join('\n') };
    }
    const genBtn1 = findGenerateButtonAnyState();
    D('点击提交后：提交按钮 disabled=' + (genBtn1 ? genBtn1.disabled : 'n/a') + ' | 输入框是否已被清空(提交成功标志)=' + (readPromptInBox().length === 0));

    // 1) 确认页面确实进入了生成状态。新 UI 的“生成中”信号可能与旧版不同，
    //    即便没检测到明确信号也【不中止】——直接继续等结果，MEDIA 真正出现才算数。
    //    这避免了“其实已经在生成、只是信号没识别到”时误中止（这正是“点了不生成”的常见根因）。
    const started = await confirmGenerationStarted(startCount, 25000, promptInBox);
    D('confirmGenerationStarted 结果=' + started + '（若 false 不代表失败，会继续等结果）');

    // v1.5.22 修「图生成出来了却不自动下载」的真根因：
    // 旧代码在 !started 时直接 return ok:false —— 于是 Flow 其实已经生成、只是“生成中”信号没被识别到时，
    // 图都渲染在页面上了我们却提前放弃，永远走不到 collectNewMedia → 用户看到“生成了但不下载”。
    // 现改为：没信号也继续等结果，只是用较短超时（避免真没生成时干等 180s）；
    // 等不到再由下方 `if (!items.length)` 统一报错并附带完整后端诊断。
    let collectTimeoutMs = timeoutMs;
    if (!started) {
      collectTimeoutMs = Math.min(timeoutMs, 60000);
      try {
        const d = diagnose(startCount);
        D('⚠️ 未检测到生成开始信号，仍继续等待结果 ' + collectTimeoutMs + 'ms（避免误中止导致不下载）。' +
          ' 输入框含提示词=' + d.textboxHasPrompt + ' 生成按钮=' + d.generateButton +
          ' 媒体数=' + d.mediaCountBefore + '/' + d.mediaCountNow + ' 转圈=' + d.spinnerFound);
      } catch (_) {}
    }

    // 2) 直接按「点击前」快照收集新媒体。旧版会在这里等待确认状态后，再把页面
    // 现有媒体全部并入 knownKeys；图片模型若在这段时间内已完成，新图就被错当旧图，
    // 导致扩展报“未捕获到结果”。
    const { imgs, vids } = await collectNewMedia(knownKeys, collectTimeoutMs);
    D('collectNewMedia 结果：imgs=' + imgs.length + ' vids=' + vids.length + '（页面总媒体数=' + countMedia() + '）');
    for (const im of imgs.slice(0, 8)) items.push(await mediaToPayload(im, 'img'));
    for (const v of vids.slice(0, 8)) items.push(await mediaToPayload(v, 'video'));
    for (const m of [...imgs, ...vids]) {
      const s = m.src || m.currentSrc || '';
      if (s) knownKeys.add(s);
    }
  }

  if (!items.length) {
    const backend = await getBackendDiagnostics();
    const backendText = [
      backend.pageErrors.length ? ('Flow 页面错误:\n' + backend.pageErrors.join('\n')) : '',
      backend.trace.length ? ('CDP 网络/运行时记录:\n' + backend.trace.join('\n')) : '',
    ].filter(Boolean).join('\n\n');
    return { ok: false, error: 'Flow 未出现任何生成结果。提示词清空不等于生成成功；请查看本条诊断中的 Flow 错误或 HTTP 响应。', diagnostic: '【后端诊断】\n' + (backendText || '未捕获到页面或网络错误；Flow 没有暴露生成开始信号。') + '\n\n【页面诊断】\n' + dumpPageStructure() + '\n\n执行轨迹:\n' + dbg.join('\n') };
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
  // charRef 复用同一项目/画布，禁止 item 间 reload（reload 会清掉已挂接的参考图导致第二条无参考）。纯文生图也不 reload（保速度）。
  const needFreshCanvas = isNewFlowUI() && newProject && effectiveMode !== 'text2img' && !charRef;
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
    log(`B#${i} txt="${(b.innerText || '').replace(/\s+/g, ' ').slice(0, 24)}" aria="${b.getAttribute('aria-label') || ''}" dis=${b.disabled} ariaDis=${b.getAttribute('aria-disabled') || '-'} ${b.querySelector('svg') ? 'svg' : ''}`);
  });
  log('=== 提交按钮命中测试（诊断"点了没反应"用）===');
  const gen = Array.from(document.querySelectorAll('button')).find(
    (b) => /arrow_forward/i.test((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || ''))
  );
  if (!gen) {
    log('未找到 arrow_forward 提交按钮');
  } else {
    const r = gen.getBoundingClientRect();
    const cx = Math.round(r.left + r.width / 2);
    const cy = Math.round(r.top + r.height / 2);
    log(`按钮 rect: left=${Math.round(r.left)} top=${Math.round(r.top)} w=${Math.round(r.width)} h=${Math.round(r.height)}`);
    log(`按钮中心: (${cx}, ${cy})`);
    log(`视口大小: ${window.innerWidth} x ${window.innerHeight}  dpr=${window.devicePixelRatio}`);
    log(`按钮状态: dis=${gen.disabled} aria-disabled=${gen.getAttribute('aria-disabled') || '(无)'}`);
    log(`按钮完整在视口内: ${r.top >= 0 && r.bottom <= window.innerHeight && r.left >= 0 && r.right <= window.innerWidth}`);
    let hit = null;
    try { hit = document.elementFromPoint(cx, cy); } catch (_) {}
    if (!hit) {
      log(`命中测试 (${cx},${cy}): 没有任何元素 → 坐标在视口外，CDP 点击会被浏览器丢弃！`);
    } else {
      const isSelf = hit === gen;
      const isChild = !isSelf && gen.contains(hit);
      const isAnc = !isSelf && hit.contains(gen);
      log(`命中测试 (${cx},${cy}): <${hit.tagName.toLowerCase()}> cls="${typeof hit.className === 'string' ? hit.className : ''}" aria="${hit.getAttribute('aria-label') || ''}"`);
      log(`与按钮关系: ${isSelf ? '正是按钮本身 OK' : isChild ? '按钮的子元素 OK' : isAnc ? '按钮的祖先容器 (注意: onClick 若挂在按钮上则点祖先无效)' : '无关元素 —— 有东西挡住了按钮！'}`);
      if (!isSelf && !isChild) {
        const path = [];
        let p = hit;
        for (let i = 0; i < 5 && p; i++) {
          path.push(`${p.tagName.toLowerCase()}${p.className && typeof p.className === 'string' ? '.' + p.className.trim().split(/\s+/).slice(0, 2).join('.') : ''}`);
          p = p.parentElement;
        }
        log(`遮挡链: ${path.join(' < ')}`);
      }
    }
  }
  log('=== 输入框所在输入栏内的按钮 ===');
  const box = getPromptBox();
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
    sendResponse({ ok: true, ts: Date.now(), ver: SELF_VERSION });
    return true;
  }
  if (msg && msg.cmd === 'testFill') {
    // 自检用：用一条简单中文测试 setPrompt 是否能让提交按钮 aria-disabled 解除
    const testText = (msg && msg.text) || '身上';
    setPrompt(testText)
      .then(() => {
        const inp = getPromptBox();
        const domText = inp ? (inp.innerText || '') : '';
        const btn = (typeof findGenerateButtonAnyState === 'function') ? findGenerateButtonAnyState() : null;
        const ariaDis = btn ? btn.getAttribute('aria-disabled') : null;
        const htmlDis = btn ? btn.disabled : null;
        sendResponse({ ok: true, domText: domText.slice(0, 80), domHasTest: domText.includes(testText), ariaDisabled: ariaDis, htmlDisabled: htmlDis });
      })
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
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
