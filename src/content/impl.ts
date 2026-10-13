/**
 * Content script 实现：划词浮标 + 页面内浮层。
 *
 * 职责：
 *   - 监听划词，在**鼠标位置**弹出药丸条（「做题 / 问 AI」）
 *   - 采集选中文字与页面正文
 *   - 在药丸条右侧展开一个 Shadow DOM 内的 React 浮层（见 panel.tsx）
 *
 * ⚠️ 构建约束：本文件及其全部依赖会被 esbuild 打成**完全自包含**的普通脚本
 * （见 scripts/build-content.mjs）。
 *
 * Chrome 不支持把 ESM 当内容脚本加载。产物里一旦出现任何顶层 import 语句，
 * 内容脚本会加载失败——而且不报错，只是功能静默消失，极难排查。
 * 所以内容脚本不走 Vite（多入口必然代码分割），单独用 esbuild 打包。
 *
 * 浮层需要的 API Key / 设置直接读 chrome.storage —— 内容脚本有 storage 权限，
 * 不必经 background 中转；流式请求也直接在页面里发起（实测 API 的 CORS 放行）。
 */

import { MSG, type SelectionPayload } from '../shared/constants';
import { checkBuildFreshness } from '../shared/buildInfo';
import { cleanExtractedText, extractPageContext } from './extract';
import { exposeDiagnostics, diagnoseOptions } from './diagnose';
import { trace, traceSnapshot } from './trace';
import type { CaptureOutcome } from './captureTypes';
import { createPanel } from './panelHost';
import type { MountedPanel } from './mountPanel';
import type { PanelMode } from './ChatPanel';

/** 选中文字的展示上限（原始选区可能很长，气泡里不该铺满整屏） */
const SELECTION_DISPLAY_LIMIT = 900;

/**
 * 页面里跑的是不是旧脚本。
 *
 * 重新加载扩展后，已打开页面里的内容脚本会失效（chrome.* 全部不可用），
 * 表现成"设置读不到、按钮点不动"。这里在插件启动时就判断出来，
 * 由浮层明确提示刷新页面，而不是让用户对着报错猜。
 */
const freshness = checkBuildFreshness();
if (freshness.stale) {
  console.warn(
    `[qa] 本页运行的脚本已过期（页面 ${freshness.runningBuild} / 扩展 ${freshness.extensionBuild ?? '未知'}）。` +
      '请刷新本页。',
  );
}

/** 供浮层使用：本页脚本是否已过期（需要刷新） */
export function isScriptStale(): boolean {
  return freshness.stale;
}

// 暴露诊断工具：在页面控制台执行 __QA_DEBUG_OPTIONS__() 可查看选项识别情况
exposeDiagnostics();
// 记一笔"脚本已就绪"：有了它，诊断里 trace 为空就能确定是脚本根本没加载，
// 而不是"点了按钮但提前返回"
trace('script:loaded', { build: freshness.runningBuild, stale: freshness.stale });

declare global {
  interface Window {
    __qaContentScriptLoaded?: boolean;
  }
}

const LAUNCHER_HOST_ID = 'qa-launcher-host';
const PANEL_HOST_ID = 'qa-panel-host';
const SHOT_HOST_ID = 'qa-shot-host';

if (!window.__qaContentScriptLoaded) {
  window.__qaContentScriptLoaded = true;
  bootstrap();
}

/** 上一次划词结果 */
interface PendingSelection {
  text: string;
  /** 鼠标落点（视口坐标）—— 药丸条就贴在这里 */
  anchor: { x: number; y: number };
  /** 选区矩形，用于边界回退 */
  rect: DOMRect;
}

let pending: PendingSelection | null = null;
let launcher: HTMLDivElement | null = null;
let panelHost: HTMLDivElement | null = null;
let panel: MountedPanel | null = null;
let panelRequestId = 0;
/** 最近一次打开浮层的模式，用于截图取消后恢复 */
let lastMode: PanelMode = 'solve';
/** 用户是否手动拖动过浮层；拖过之后就不再自动定位 */
let userMovedPanel = false;

/* ------------------------------------------------------------------ *
 * 药丸条（做题 / 问 AI）
 * ------------------------------------------------------------------ */

const LAUNCHER_CSS = `
  .qa-bar {
    position: absolute;
    display: none;
    align-items: stretch;
    gap: 0;
    border-radius: 9px;
    overflow: hidden;
    background: #4D6BFE;
    box-shadow: 0 4px 16px rgba(0, 0, 0, .24);
    font: 500 13px/1.2 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    user-select: none;
    white-space: nowrap;
    animation: qa-pop .12s ease-out;
  }
  .qa-bar.qa-visible { display: inline-flex; }
  /* 量尺寸期间：可见但不可见（能参与布局，又不会画出来） */
  .qa-bar.qa-measuring { display: inline-flex; visibility: hidden; }
  @keyframes qa-pop {
    from { opacity: 0; transform: translateY(-3px) scale(.97); }
    to   { opacity: 1; transform: none; }
  }
  .qa-bar button {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 12px;
    border: none;
    background: transparent;
    color: #fff;
    font: inherit;
    cursor: pointer;
    transition: background .12s ease;
  }
  .qa-bar button:hover { background: rgba(255, 255, 255, .16); }
  .qa-bar button:active { background: rgba(255, 255, 255, .26); }
  .qa-bar .qa-sep { width: 1px; background: rgba(255, 255, 255, .28); margin: 6px 0; }
  .qa-bar .qa-ico { font-size: 12px; line-height: 1; opacity: .95; }
`;

function ensureLauncher(): { host: HTMLDivElement; bar: HTMLDivElement } {
  if (launcher?.isConnected) {
    const bar = launcher.shadowRoot?.querySelector('.qa-bar') as HTMLDivElement;
    return { host: launcher, bar };
  }

  const host = document.createElement('div');
  host.id = LAUNCHER_HOST_ID;
  // fixed + 零尺寸：不受宿主页面布局影响，也不会撑开页面
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';

  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = LAUNCHER_CSS;

  const bar = document.createElement('div');
  bar.className = 'qa-bar';

  const makeButton = (icon: string, label: string, mode: PanelMode, title: string) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.title = title;
    b.innerHTML = `<span class="qa-ico">${icon}</span><span>${label}</span>`;
    // 阻止 mousedown 抢走选区：否则点击瞬间 selection 会清空
    b.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();
    });
    b.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel(mode);
    });
    return b;
  };

  const solveBtn = makeButton('✦', '做题', 'solve', '直接用 AI 解答选中内容');
  const sep = document.createElement('span');
  sep.className = 'qa-sep';
  const chatBtn = makeButton('💬', '问 AI', 'chat', '把选中内容作为引用，和 AI 对话');

  bar.append(solveBtn, sep, chatBtn);
  shadow.append(style, bar);
  document.documentElement.appendChild(host);
  launcher = host;
  return { host, bar };
}

function hideLauncher(): void {
  launcher?.shadowRoot?.querySelector('.qa-bar')?.classList.remove('qa-visible');
}

/**
 * 把药丸条放在鼠标落点附近。
 *
 * 两条硬要求：
 *   1. 以**鼠标**为准而不是选区末尾（原来用选区末尾，用户反馈"离鼠标太远不好点"）
 *   2. 必须在显示之前就把位置算好 —— 否则会先在旧位置/左上角闪一帧
 */
function showLauncherAt(anchor: { x: number; y: number }): void {
  const { bar } = ensureLauncher();

  // 先隐形再量尺寸：量完立刻定位，最后才加 qa-visible 显示出来。
  // 这样不会出现"先在别处闪一下再跳过来"。
  bar.classList.remove('qa-visible');
  bar.classList.add('qa-measuring');

  const OFFSET_X = 6;
  const OFFSET_Y = 8;
  const width = bar.offsetWidth || 150;
  const height = bar.offsetHeight || 32;

  let left = anchor.x + OFFSET_X;
  let top = anchor.y + OFFSET_Y;

  // 视口边界保护：右边放不下就往左翻，下边放不下就往上翻
  if (left + width > window.innerWidth - 8) left = Math.max(8, anchor.x - width - OFFSET_X);
  if (top + height > window.innerHeight - 8) top = Math.max(8, anchor.y - height - OFFSET_Y);

  bar.style.left = `${left}px`;
  bar.style.top = `${top}px`;
  bar.classList.remove('qa-measuring');
  bar.classList.add('qa-visible');
}

/* ------------------------------------------------------------------ *
 * 浮层
 * ------------------------------------------------------------------ */

/**
 * 浮层的公共回调。
 * 拖动过之后要记住，避免自动定位把用户摆好的位置覆盖掉。
 */
const PANEL_BASE_HOOKS = {
  onCaptureRegion: captureRegion,
  onUserMoved: () => {
    userMovedPanel = true;
  },
  // 扩展被重载过：本页旧脚本调不通 chrome.*，浮层直接提示刷新
  scriptStale: freshness.stale,
  // 截图完成后带着图片重新挂载浮层（框选期间浮层已被卸载）
  onSnapshot: handleSnapshot,
  // 诊断信息：选项识别、答案解析、截图时间线、可疑点，一键复制给开发者
  onDiagnose: () =>
    JSON.stringify(
      {
        url: location.href,
        build: freshness,
        trace: traceSnapshot(),
        ...diagnoseOptions(),
      },
      null,
      2,
    ),
};

function ensurePanelHost(): HTMLDivElement {
  if (panelHost?.isConnected) return panelHost;

  const host = document.createElement('div');
  host.id = PANEL_HOST_ID;
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
  document.documentElement.appendChild(host);
  panelHost = host;
  return host;
}

/**
 * 把浮层摆到落点右侧；贴边时自动翻到左侧/上收。
 *
 * 量尺寸与定位必须在同一帧内完成，否则面板会先在左上角闪一下
 * （CSS 里 .qa-panel-root 默认 visibility: hidden，定位完成才显示）。
 *
 * @returns 是否成功定位（尺寸还没量出来时返回 false）
 */
function positionPanel(preferAnchor: { x: number; y: number }): boolean {
  if (!panel || !panelHost) return false;
  const root = panelHost.shadowRoot?.querySelector('.qa-panel-root') as HTMLElement | null;
  if (!root) return false;

  const { width, height } = panel.size();
  // 尺寸为 0 表示还没真正渲染出来（例如设置面板尚未挂载），先不定位
  if (width === 0 && height === 0) return false;

  const GAP = 8;
  const MARGIN = 12;

  let left = preferAnchor.x + GAP;
  let top = preferAnchor.y;

  // 右边放不下就翻到左侧
  if (left + width > window.innerWidth - MARGIN) {
    left = Math.max(MARGIN, preferAnchor.x - width - GAP);
  }
  // 下面放不下就上收
  if (top + height > window.innerHeight - MARGIN) {
    top = Math.max(MARGIN, window.innerHeight - height - MARGIN);
  }
  if (top < MARGIN) top = MARGIN;

  root.style.left = `${left}px`;
  root.style.top = `${top}px`;
  // 位置已定，可以显示了
  root.classList.add('qa-panel-positioned');
  return true;
}

/**
 * 面板尺寸要等设置加载完、首帧渲染后才量得到，所以这里重试几次。
 * 比起固定 setTimeout，"量不到就再等一帧"更耐受慢加载。
 */
function schedulePosition(anchor: { x: number; y: number }, attempt = 0): void {
  // 用户已经手动拖过位置：尊重他的选择，不再自动摆放
  if (userMovedPanel) return;
  if (!isPanelOpen()) return;

  requestAnimationFrame(() => {
    if (positionPanel(anchor)) return;
    if (attempt >= 10) return; // 约 0.5s 后放弃，避免无限重试
    window.setTimeout(() => schedulePosition(anchor, attempt + 1), 50);
  });
}

/** 面板准备回答时用的选区快照 */
function currentPayload(): SelectionPayload | null {
  if (!pending) return null;
  return {
    // 选中文字也过一遍清洗：题库常把标点拆在独立元素里，
    // 直接显示会变成 "A\n.\n100" 那种每个字符一行的观感
    text: cleanExtractedText(pending.text, SELECTION_DISPLAY_LIMIT),
    pageTitle: document.title,
    pageUrl: location.href,
    context: safeContext(),
    source: 'selection',
    createdAt: Date.now(),
  };
}

/**
 * 最近一次打开浮层用的选区快照。
 *
 * 用途：截图期间浮层会被卸载，而框选动作很可能清掉页面上的文字选区，
 * 那时 currentPayload() 会返回 null。有这份快照就能兜住。
 */
let lastPayload: SelectionPayload | null = null;

function safeContext(): string | undefined {
  try {
    return extractPageContext();
  } catch {
    return undefined;
  }
}

/**
 * 截图完成后由浮层回调进来：带着图片重新挂载浮层，并把图片作为提问发出去。
 *
 * 为什么走这条路：框选前必须卸载浮层（否则浮层会被截进图里），
 * 一卸载发起截图的组件就没了 —— 所以图片必须回到这里处理。
 *
 * 这里刻意**重新采集一次选区快照**：用户框选时可能已经改了选择，
 * 用当前状态比用打开浮层时的旧快照更贴近意图；取不到就退回旧快照。
 */
function handleSnapshot(dataUrl: string): void {
  trace('snapshot:received', `dataUrl ${dataUrl.length} 字节`);
  const fresh = currentPayload() ?? lastPayload;
  if (!fresh) {
    trace('snapshot:no-payload');
    console.warn('[qa] 截图后拿不到选区信息，已忽略');
    return;
  }
  lastPayload = fresh;

  const host = ensurePanelHost();
  if (!panel) {
    panel = createPanel(host, closePanel, PANEL_BASE_HOOKS);
  }

  lastMode = 'solve';
  panelRequestId += 1;
  panel.update({
    requestId: panelRequestId,
    mode: 'solve',
    initialImage: dataUrl,
    // 有图就不必再问"请解答图中的题目"——ChatPanel 会用这段文字作为问题
    payload: { ...fresh, text: '请解答图中的题目，给出答案和简要理由。' },
  });
  trace('snapshot:panel-updated', { requestId: panelRequestId });

  schedulePosition(pending?.anchor ?? { x: 120, y: 120 });
}

/**
 * 打开浮层。
 * @param mode solve=直接作答；chat=把选中内容作为引用开始对话
 */
function openPanel(mode: PanelMode): void {
  const payload = currentPayload();
  if (!payload) return;

  trace('panel:open', { mode, hasContext: !!payload.context });
  lastPayload = payload;
  lastMode = mode;
  hideLauncher();

  const host = ensurePanelHost();
  if (!panel) {
    panel = createPanel(host, closePanel, PANEL_BASE_HOOKS);
  }

  // 记录药丸条的落点，用于把浮层摆在它右侧
  const anchor = pending?.anchor ?? { x: 80, y: 80 };

  panelRequestId += 1;
  panel.update({ requestId: panelRequestId, mode, payload });

  // 定位要等面板真的渲染出尺寸，且流式输出会让它变高，所以分两次校正
  schedulePosition(anchor);
  window.setTimeout(() => schedulePosition(anchor), 400);
}

function closePanel(): void {
  if (!panel) return;
  panel.unmount();
  panel = null;
}

/**
 * 浮层是否固定在最上层。
 * 设置读不到时按"未固定"处理（也就是默认点别处会关，符合直觉）。
 */
let pinnedCache = false;

function refreshPinned(): void {
  try {
    chrome.storage.local
      .get('qa:settings')
      .then((stored) => {
        const raw = stored?.['qa:settings'] as { panelPinned?: boolean } | undefined;
        pinnedCache = raw?.panelPinned === true;
      })
      .catch(() => {
        /* 读不到就维持原值 */
      });
  } catch {
    /* 忽略 */
  }
}

// 页面加载先同步一次，并在设置变化时保持最新
refreshPinned();
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes['qa:settings']) return;
    const next = changes['qa:settings'].newValue as { panelPinned?: boolean } | undefined;
    pinnedCache = next?.panelPinned === true;
  });
} catch {
  /* 忽略 */
}

function isPanelOpen(): boolean {
  return panel !== null;
}

/* ------------------------------------------------------------------ *
 * 截取区域
 * ------------------------------------------------------------------ */

const SHOT_CSS = `
  * { box-sizing: border-box; }
  .qa-shot-overlay {
    position: absolute; top: 0; left: 0;
    width: 100vw; height: 100vh;
    cursor: crosshair; user-select: none;
    font: 13px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
  }
  .qa-shot-dim { position: absolute; inset: 0; background: rgba(15, 23, 42, .42); }
  .qa-shot-tip {
    position: absolute; top: 14px; left: 50%;
    transform: translateX(-50%);
    padding: 7px 14px; border-radius: 999px;
    background: rgba(15, 23, 42, .88); color: #fff;
    font-size: 12.5px; white-space: nowrap; pointer-events: none;
  }
  .qa-shot-box {
    position: absolute; display: none;
    border: 2px solid #4D6BFE;
    box-shadow: 0 0 0 9999px rgba(15, 23, 42, .42);
  }
  .qa-shot-box.qa-visible { display: block; }
  .qa-shot-actions {
    position: absolute; display: none; gap: 6px; padding: 6px;
    border-radius: 10px; background: #fff;
    box-shadow: 0 8px 26px rgba(15, 23, 42, .3);
  }
  .qa-shot-actions.qa-visible { display: flex; }
  .qa-shot-actions button {
    padding: 6px 12px; border: 1px solid #e5e7eb; border-radius: 7px;
    background: #fff; color: #1c1f23; font-size: 12.5px; cursor: pointer;
  }
  .qa-shot-actions button:hover { border-color: #4D6BFE; }
  .qa-shot-actions button.qa-shot-primary {
    border-color: #4D6BFE; background: #4D6BFE; color: #fff; font-weight: 500;
  }
  .qa-shot-actions button.qa-shot-primary:hover { background: #3d5bf0; }
`;

let shotHost: HTMLDivElement | null = null;

interface ShotOverlay {
  overlay: HTMLElement;
  box: HTMLElement;
  actions: HTMLElement;
  tip: HTMLElement;
  redoBtn: HTMLButtonElement;
  confirmBtn: HTMLButtonElement;
}

/** 建立框选遮罩；返回需要绑定事件的元素引用 */
function createShotOverlay(): ShotOverlay | null {
  removeShotOverlay();

  const host = document.createElement('div');
  host.id = SHOT_HOST_ID;
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647;';
  const shadow = host.attachShadow({ mode: 'open' });

  const style = document.createElement('style');
  style.textContent = SHOT_CSS;

  const overlay = document.createElement('div');
  overlay.className = 'qa-shot-overlay';

  const dim = document.createElement('div');
  dim.className = 'qa-shot-dim';

  const tip = document.createElement('div');
  tip.className = 'qa-shot-tip';
  tip.textContent = '按住鼠标框选要提问的区域 · Esc 取消';

  const box = document.createElement('div');
  box.className = 'qa-shot-box';

  const actions = document.createElement('div');
  actions.className = 'qa-shot-actions';

  // 变量名刻意避开 redo / confirm —— window.redo 与 window.confirm 会抢占解析
  const redoBtn = document.createElement('button');
  redoBtn.type = 'button';
  redoBtn.textContent = '重新框选';

  const confirmBtn = document.createElement('button');
  confirmBtn.type = 'button';
  confirmBtn.className = 'qa-shot-primary';
  confirmBtn.textContent = '问 AI';

  actions.append(redoBtn, confirmBtn);
  overlay.append(dim, box, tip, actions);
  shadow.append(style, overlay);
  document.documentElement.appendChild(host);
  shotHost = host;

  const q = <T extends HTMLElement>(sel: string) => shadow.querySelector<T>(sel);
  const found = {
    overlay: q<HTMLElement>('.qa-shot-overlay'),
    box: q<HTMLElement>('.qa-shot-box'),
    actions: q<HTMLElement>('.qa-shot-actions'),
    tip: q<HTMLElement>('.qa-shot-tip'),
    redoBtn: q<HTMLButtonElement>('.qa-shot-actions button:not(.qa-shot-primary)'),
    confirmBtn: q<HTMLButtonElement>('.qa-shot-primary'),
  };

  if (
    !found.overlay ||
    !found.box ||
    !found.actions ||
    !found.tip ||
    !found.redoBtn ||
    !found.confirmBtn
  ) {
    removeShotOverlay();
    return null;
  }
  return found as ShotOverlay;
}

function removeShotOverlay(): void {
  shotHost?.remove();
  shotHost = null;
}

/** 上一次截图失败的原因，供浮层展示 */
let lastCaptureError: { error: string; permissionIssue: boolean } | null = null;

export function takeLastCaptureError(): { error: string; permissionIssue: boolean } | null {
  const value = lastCaptureError;
  lastCaptureError = null;
  return value;
}

/**
 * 让用户框选区域，然后截图裁剪。
 *
 * 流程：先卸掉浮层与药丸条（否则它们会被截进图里）→ 框选 → 请求 background
 * 截图并裁剪。用户取消或失败都会返回 dataUrl: null。
 */
function captureRegion(): Promise<CaptureOutcome> {
  return new Promise((resolve) => {
    trace('capture:start', { hadPanel: panel !== null });
    const restoreAfter = !!(panelHost?.isConnected && panel);
    if (panel) panel.unmount();
    panel = null;
    hideLauncher();

    createShotOverlay();
    const shadow = shotHost?.shadowRoot;
    const overlay = shadow?.querySelector<HTMLElement>('.qa-shot-overlay');
    const box = shadow?.querySelector<HTMLElement>('.qa-shot-box');
    const actions = shadow?.querySelector<HTMLElement>('.qa-shot-actions');
    const tip = shadow?.querySelector<HTMLElement>('.qa-shot-tip');
    const redoBtn = shadow?.querySelector<HTMLButtonElement>(
      '.qa-shot-actions button:not(.qa-shot-primary)',
    );
    const confirmBtn = shadow?.querySelector<HTMLButtonElement>('.qa-shot-primary');
    if (!overlay || !box || !actions || !tip || !redoBtn || !confirmBtn) {
      trace('capture:overlay-missing-nodes');
      removeShotOverlay();
      resolve({ dataUrl: null });
      return;
    }
    trace('capture:overlay-ready');

    let start: { x: number; y: number } | null = null;
    let rect = { x: 0, y: 0, width: 0, height: 0 };
    let settled = false;

    const paint = () => {
      box.style.left = `${rect.x}px`;
      box.style.top = `${rect.y}px`;
      box.style.width = `${rect.width}px`;
      box.style.height = `${rect.height}px`;
    };

    const moveActions = () => {
      const below = rect.y + rect.height + 10;
      const fits = below + 48 < window.innerHeight;
      actions.style.left = `${Math.max(8, Math.min(rect.x, window.innerWidth - 190))}px`;
      actions.style.top = `${fits ? below : Math.max(8, rect.y - 52)}px`;
    };

    const finish = (result: CaptureOutcome) => {
      if (settled) return;
      settled = true;
      document.removeEventListener('keydown', onKey, true);
      removeShotOverlay();
      if (restoreAfter) {
        // 取消或失败后把浮层放回去，用户不必重新划词
        openPanel(lastMode);
      }
      resolve(result);
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        finish({ dataUrl: null });
      }
    };
    document.addEventListener('keydown', onKey, true);

    overlay.addEventListener('mousedown', (e) => {
      if ((e.target as HTMLElement).closest('.qa-shot-actions')) return;
      const me = e as MouseEvent;
      start = { x: me.clientX, y: me.clientY };
      rect = { x: me.clientX, y: me.clientY, width: 0, height: 0 };
      box.classList.add('qa-visible');
      actions.classList.remove('qa-visible');
      paint();
    });

    overlay.addEventListener('mousemove', (e) => {
      if (!start) return;
      const me = e as MouseEvent;
      rect = {
        x: Math.min(start.x, me.clientX),
        y: Math.min(start.y, me.clientY),
        width: Math.abs(me.clientX - start.x),
        height: Math.abs(me.clientY - start.y),
      };
      paint();
    });

    overlay.addEventListener('mouseup', () => {
      if (!start) return;
      start = null;
      // 太小的选区没有意义，视为误触
      if (rect.width < 12 || rect.height < 12) {
        box.classList.remove('qa-visible');
        actions.classList.remove('qa-visible');
        return;
      }
      tip.textContent = '调整选区，或点「问 AI」确认';
      moveActions();
      actions.classList.add('qa-visible');
    });

    redoBtn.addEventListener('click', () => {
      box.classList.remove('qa-visible');
      actions.classList.remove('qa-visible');
      tip.textContent = '按住鼠标框选要提问的区域 · Esc 取消';
    });

    confirmBtn.addEventListener('click', () => {
      if (rect.width < 12 || rect.height < 12) return;
      const payload = { ...rect };
      trace('capture:confirmed', payload);
      // 先摘掉遮罩，避免它出现在截图里
      removeShotOverlay();

      chrome.runtime
        .sendMessage({
          type: MSG.CAPTURE_REGION,
          rect: payload,
          devicePixelRatio: window.devicePixelRatio || 1,
        })
        .then((res: { ok?: boolean; dataUrl?: string; error?: string } | undefined) => {
          if (!res?.ok || !res.dataUrl) {
            const reason = res?.error ?? '未知原因';
            trace('capture:bg-failed', reason);
            console.warn('[qa] 截取失败:', reason);

            // 权限不足是最常见的失败，且原因对用户不直观：
            // 网页里的按钮点击**不会**授予 activeTab，后台因此拿不到截图权限。
            // 记下来交给浮层显示，而不是静默恢复（那样只会像"点了没反应"）。
            const permissionIssue = /permission|all_urls|activeTab/i.test(reason);
            lastCaptureError = { error: reason, permissionIssue };
            finish({ dataUrl: null, error: reason, permissionIssue });
            return;
          }
          trace('capture:bg-ok', `dataUrl ${res.dataUrl.length} 字节`);
          finish({ dataUrl: res.dataUrl });
        })
        .catch((err: Error) => {
          trace('capture:bg-threw', err.message);
          console.warn('[qa] 截取失败:', err.message);
          lastCaptureError = { error: err.message, permissionIssue: false };
          finish({ dataUrl: null, error: err.message });
        });
    });
  });
}

/* ------------------------------------------------------------------ *
 * 选区采集
 * ------------------------------------------------------------------ */

/** 读取当前选区；返回 null 表示"不值得弹按钮" */
function readSelection(): { text: string; rect: DOMRect } | null {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;

  const text = sel.toString().trim();
  if (text.length < 2) return null;

  const range = sel.getRangeAt(0);
  const rect = range.getBoundingClientRect();
  if (rect.width === 0 && rect.height === 0) return null;

  // 输入框内的选区不打扰
  const anchorNode = sel.anchorNode;
  const el = anchorNode instanceof Element ? anchorNode : anchorNode?.parentElement;
  if (el?.closest('input, textarea, [contenteditable="true"]')) return null;

  return { text, rect };
}

/** 事件目标是否来自我们自己的 UI */
function isOwnUi(target: EventTarget | null): boolean {
  if (!(target instanceof Element)) return false;
  // 标注层是 pointer-events: none，正常点不到；列在这里是防御性的
  return !!target.closest(
    `#${LAUNCHER_HOST_ID}, #${PANEL_HOST_ID}, #${SHOT_HOST_ID}, #qa-highlight-host`,
  );
}

/** 鼠标位置（视口坐标） */
let lastPointer = { x: 0, y: 0 };

function onSelectionSettled(fromKeyboard: boolean): void {
  window.setTimeout(() => {
    const found = readSelection();
    if (!found) {
      hideLauncher();
      return;
    }

    // 键盘选词没有鼠标落点，退回到选区末尾
    const anchor = fromKeyboard
      ? { x: found.rect.right, y: found.rect.bottom }
      : { x: lastPointer.x, y: lastPointer.y };

    pending = { text: found.text, anchor, rect: found.rect };
    showLauncherAt(anchor);
  }, 10);
}

/** 快捷键：优先用选中文字，没有选中就用整页正文 */
function askViaShortcut(): void {
  const found = readSelection();
  const context = safeContext();

  if (!found && !context) return;

  if (found) {
    // 有选中内容：走正常流程（正文作为引用随请求发走）
    pending = { text: found.text, anchor: { x: lastPointer.x, y: lastPointer.y }, rect: found.rect };
    openPanel('solve');
    return;
  }

  // 没有选中内容：把整页正文当作"被选中的内容"直接开问
  const pageText = context ?? '';
  if (!pageText.trim()) return;

  const host = ensurePanelHost();
  if (!panel) {
    panel = createPanel(host, closePanel, PANEL_BASE_HOOKS);
  }
  panelRequestId += 1;
  panel.update({
    requestId: panelRequestId,
    mode: 'solve',
    payload: {
      text: cleanExtractedText(pageText, SELECTION_DISPLAY_LIMIT),
      pageTitle: document.title,
      pageUrl: location.href,
      context: pageText,
      source: 'shortcut',
      createdAt: Date.now(),
    },
  });
  // 摆到右上角，避开页面主体
  schedulePosition({ x: Math.max(12, window.innerWidth - 420), y: 72 });
}

/* ------------------------------------------------------------------ *
 * 事件绑定
 * ------------------------------------------------------------------ */

function bootstrap(): void {
  document.addEventListener(
    'mousemove',
    (e) => {
      lastPointer = { x: e.clientX, y: e.clientY };
    },
    { passive: true, capture: true },
  );

  document.addEventListener('mouseup', (e) => {
    if (isOwnUi(e.target)) return;
    onSelectionSettled(false);
  });

  document.addEventListener('keyup', (e) => {
    if (e.shiftKey || e.key === 'a' || e.key === 'A') onSelectionSettled(true);
  });

  document.addEventListener(
    'mousedown',
    (e) => {
      if (isOwnUi(e.target)) return;
      // 点页面别处：药丸条收起
      hideLauncher();
      // 浮层：仅当没有"固定在最上层"时才关（固定是用户显式要求的）
      if (!pinnedCache) closePanel();
    },
    true,
  );

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideLauncher();
      closePanel();
    }
    // content script 收不到 chrome.commands 的快捷键，这里手动兜一层
    if (e.altKey && e.shiftKey && (e.key === 'S' || e.key === 's')) {
      e.preventDefault();
      askViaShortcut();
    }
  });

  // 滚动会让 fixed 定位的药丸条脱离选区位置，收起它；
  // 浮层已经打开时不关（用户可能正在读答案，且浮层是 fixed 的，翻页时仍在视野里）
  window.addEventListener(
    'scroll',
    () => {
      if (!isPanelOpen()) hideLauncher();
    },
    { passive: true, capture: true },
  );
  window.addEventListener(
    'resize',
    () => {
      if (!isPanelOpen()) hideLauncher();
    },
    { passive: true },
  );
}

/** 供 background 的右键菜单调用 */
chrome.runtime.onMessage.addListener(
  (message: { type?: string }, _sender, sendResponse) => {
    if (message?.type === 'qa:trigger-ask') {
      askViaShortcut();
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === 'qa:trigger-screenshot') {
      // 右键菜单直接进入框选截图。
      // 这条路径是**被授权**的：右键菜单属于用户调用扩展，
      // 浏览器会授予临时 activeTab 权限，所以 captureVisibleTab 能用。
      void captureRegion().then((outcome) => {
        if (outcome.error) {
          console.warn('[qa] 截图失败:', outcome.error);
          return;
        }
        const dataUrl = outcome.dataUrl;
        if (!dataUrl) return;
        const host = ensurePanelHost();
        if (!panel) {
          panel = createPanel(host, closePanel, PANEL_BASE_HOOKS);
        }
        lastMode = 'solve';
        panelRequestId += 1;
        panel.update({
          requestId: panelRequestId,
          mode: 'solve',
          initialImage: dataUrl,
          payload: {
            text: '请解答图中的题目，给出答案和简要理由。',
            pageTitle: document.title,
            pageUrl: location.href,
            context: undefined,
            source: 'contextMenu',
            createdAt: Date.now(),
          },
        });
        schedulePosition({ x: lastPointer.x || 120, y: lastPointer.y || 120 });
      });
      sendResponse({ ok: true });
      return true;
    }
    return undefined;
  },
);
