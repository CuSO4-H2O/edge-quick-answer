/**
 * Service worker（MV3）。
 *
 * 刻意做得很薄，原因：MV3 的 service worker 空闲约 30 秒就会被终止，
 * 长连接的流式响应放这里必然被腰斩。所以：
 *   - 所有流式请求都在侧边栏 / 页面浮层里发起
 *   - 这里只负责：开侧边栏、暂存并转发选区、右键菜单、截屏裁剪
 *
 * 截屏为什么放这里：chrome.tabs.captureVisibleTab 只有后台能调，
 * 而且用 OffscreenCanvas 在这里裁剪，可以避免在内容脚本里创建 canvas 元素
 * （内容脚本的 DOM 改动是可见的，页面能检测到，能不做就不做）。
 */

import { MSG, type SelectionPayload } from '../shared/constants';

const MENU_ID = 'qa-ask-selection';

/** 尚未被侧边栏消费的选区 */
let pendingPayload: SelectionPayload | null = null;
/** 已连上的侧边栏 port（可能是多个窗口） */
const panelPorts = new Set<chrome.runtime.Port>();

/* ------------------------------------------------------------------ *
 * 安装与启动
 * ------------------------------------------------------------------ */

chrome.runtime.onInstalled.addListener((details) => {
  // 点扩展图标时打开侧边栏，而不是弹 popup
  chrome.sidePanel
    .setPanelBehavior({ openPanelOnActionClick: true })
    .catch((err) => console.warn('[qa] setPanelBehavior 失败:', err));

  // 首次安装时打开权限说明页。
  //
  // 为什么只在 install 时开：安装提示里的"读取你访问的所有网站"容易被误解成
  // 这个插件在偷看浏览记录。与其让用户对着权限列表猜，不如一次说清楚
  // "为什么需要、会做什么、不会做什么"。
  // 更新（update）时不打扰 —— 那时候用户已经在用了，再弹一次很烦。
  if (details.reason === 'install') {
    chrome.tabs
      .create({ url: chrome.runtime.getURL('src/welcome/index.html') })
      .catch((err) => console.warn('[qa] 无法打开说明页:', err));
  }

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: '用 AI 解答选中内容',
      contexts: ['selection', 'page'],
    });
    chrome.contextMenus.create({
      id: 'qa-screenshot-ask',
      title: '截取区域问 AI',
      contexts: ['page', 'selection'],
    });
  });
});

// service worker 每次冷启动都要重新声明一次，否则行为会丢
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(() => {
    /* 旧版本浏览器没有这个 API，忽略 */
  });

/* ------------------------------------------------------------------ *
 * 侧边栏连接
 * ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'qa-sidepanel') return;
  panelPorts.add(port);
  port.onDisconnect.addListener(() => panelPorts.delete(port));

  // 连上就立刻把暂存的选区递过去，覆盖"先发消息后挂载"的情况
  if (pendingPayload) {
    try {
      port.postMessage({ type: MSG.BROADCAST, payload: pendingPayload });
      pendingPayload = null;
    } catch {
      /* port 刚断开，下次再取 */
    }
  }
});

function flushToPanels(payload: SelectionPayload): boolean {
  if (panelPorts.size === 0) return false;
  let delivered = false;
  for (const port of panelPorts) {
    try {
      port.postMessage({ type: MSG.BROADCAST, payload });
      delivered = true;
    } catch {
      panelPorts.delete(port);
    }
  }
  return delivered;
}

/* ------------------------------------------------------------------ *
 * 截屏裁剪
 * ------------------------------------------------------------------ */

interface CaptureRequest {
  /** 选区矩形（视口 CSS 像素） */
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
}

/**
 * 截取当前可见区域并按矩形裁剪，返回 JPEG data URL。
 *
 * 选 JPEG（0.85）而不是 PNG：截图是给模型看的，JPEG 体积小很多，
 * 而视觉理解对这点压缩损失不敏感。
 */
async function captureRegion(req: CaptureRequest): Promise<string> {
  const tab = await chrome.tabs.query({ active: true, currentWindow: true });
  const windowId = tab[0]?.windowId;
  if (windowId === undefined) throw new Error('找不到当前窗口');

  // 先给页面一点时间把浮层/遮罩收起来（调用方已提前移除），再截图
  const dataUrl = await chrome.tabs.captureVisibleTab(windowId, {
    format: 'jpeg',
    quality: 92,
  });

  const dpr = req.devicePixelRatio || 1;
  const sx = Math.max(0, Math.round(req.rect.x * dpr));
  const sy = Math.max(0, Math.round(req.rect.y * dpr));
  const sw = Math.max(1, Math.round(req.rect.width * dpr));
  const sh = Math.max(1, Math.round(req.rect.height * dpr));

  const blob = await (await fetch(dataUrl)).blob();
  const bitmap = await createImageBitmap(blob);

  // 选区可能超出图像范围（缩放/滚动边缘），裁到有效区域
  const cw = Math.min(sw, Math.max(1, bitmap.width - sx));
  const ch = Math.min(sh, Math.max(1, bitmap.height - sy));

  const canvas = new OffscreenCanvas(cw, ch);
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('无法创建 2D 上下文');
  ctx.drawImage(bitmap, sx, sy, cw, ch, 0, 0, cw, ch);
  bitmap.close();

  const out = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.88 });

  // service worker 里没有 FileReader，用分块 base64
  const buf = new Uint8Array(await out.arrayBuffer());
  let binary = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  return `data:image/jpeg;base64,${btoa(binary)}`;
}

/* ------------------------------------------------------------------ *
 * 消息处理
 * ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener(
  (
    message: { type?: string; payload?: SelectionPayload; rect?: CaptureRequest['rect']; devicePixelRatio?: number },
    sender,
    sendResponse,
  ) => {
    switch (message?.type) {
      // content script：用户点了浮标 / 按了快捷键
      case MSG.OPEN_PANEL: {
        const payload = message.payload;
        if (!payload) {
          sendResponse({ ok: false, reason: 'no-payload' });
          return true;
        }
        void handleSelection(payload, sender.tab?.windowId);
        sendResponse({ ok: true });
        return true;
      }

      // 侧边栏：我挂载好了，把暂存的选区给我
      case MSG.TAKE_PENDING: {
        const payload = pendingPayload;
        pendingPayload = null;
        sendResponse({ ok: true, payload });
        return true;
      }

      // content script：截取区域
      case MSG.CAPTURE_REGION: {
        if (!message.rect) {
          sendResponse({ ok: false, error: '缺少选区矩形' });
          return true;
        }
        captureRegion({ rect: message.rect, devicePixelRatio: message.devicePixelRatio ?? 1 })
          .then((dataUrl) => sendResponse({ ok: true, dataUrl }))
          .catch((err: Error) => sendResponse({ ok: false, error: err.message }));
        return true; // 异步响应
      }

      default:
        return undefined;
    }
  },
);

/**
 * 暂存选区、尝试打开侧边栏、并尽快投递。
 */
async function handleSelection(
  payload: SelectionPayload,
  windowId: number | undefined,
): Promise<void> {
  // 侧边栏已经开着：直接投递，不必再 open（open 在已打开时会报错）
  if (flushToPanels(payload)) return;

  pendingPayload = payload;

  try {
    if (typeof windowId === 'number') {
      await chrome.sidePanel.open({ windowId });
    } else {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.windowId !== undefined) {
        await chrome.sidePanel.open({ windowId: tab.windowId });
      }
    }
  } catch (err) {
    console.warn('[qa] 打开侧边栏失败，选区已暂存，点一下扩展图标即可:', err);
  }

  // open() resolve 后侧边栏还不一定挂载完，靠 port 连接或 TAKE_PENDING 兜底
  window.setTimeout(() => {
    if (pendingPayload && flushToPanels(pendingPayload)) pendingPayload = null;
  }, 600);
}

/* ------------------------------------------------------------------ *
 * 右键菜单
 * ------------------------------------------------------------------ */

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (tab?.id === undefined) return;

  if (info.menuItemId === MENU_ID) {
    // 让 content script 去采集（它才有 DOM 访问权），再由它发回 OPEN_PANEL
    chrome.tabs.sendMessage(tab.id, { type: 'qa:trigger-ask' }).catch(() => {
      console.warn('[qa] 无法触达 content script，页面可能未注入或为受限页面');
    });
    return;
  }

  if (info.menuItemId === 'qa-screenshot-ask') {
    chrome.tabs.sendMessage(tab.id, { type: 'qa:trigger-screenshot' }).catch(() => {
      console.warn('[qa] 无法触达 content script');
    });
  }
});
