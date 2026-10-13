/**
 * 页面内浮层的挂载逻辑。
 *
 * 挂载点说明：React root 建在 Shadow DOM 内部的一个 div 上。
 * react-dom 19 的 getHoistableRoot() 对 nodeType===11（DocumentFragment/ShadowRoot）
 * 返回该 root 本身，因此样式与 DOM 都不会泄漏到宿主页面。
 *
 * 样式必须内联成字符串：外部 <link> 的 CSS 进不了 Shadow DOM。
 */

import { createRoot, type Root } from 'react-dom/client';
import { buildShadowCss } from '../shared/injectStyles';
import { ChatPanel, type PanelRequest } from './ChatPanel';
import type { CaptureOutcome } from './captureTypes';

const STYLE_ID = 'qa-panel-style';

export interface MountedPanel {
  /** 用新的请求（模式 + 选中内容）重渲染 */
  update: (request: PanelRequest) => void;
  unmount: () => void;
  /** 面板当前渲染尺寸，供定位逻辑使用 */
  size: () => { width: number; height: number };
}

export interface PanelHooks {
  /** 框选截图，返回 JPEG data URL；null 表示用户取消 */
  onCaptureRegion: () => Promise<CaptureOutcome>;
  /** 用户手动拖动过浮层 */
  onUserMoved: () => void;
  /** 是否在网页上标注答案选项 */
  highlightEnabled: boolean;
  /** 用户切换了"标注答案选项"开关 */
  onHighlightPrefChange: (v: boolean) => void;
  /** 本页脚本是否已过期（扩展被重载过 → 必须刷新页面） */
  scriptStale: boolean;
  /** 收集选项识别诊断信息（JSON 字符串） */
  onDiagnose: () => string;
  /** 截图完成后带着图片重新挂载浮层（框选期间浮层已被卸载） */
  onSnapshot: (dataUrl: string) => void;
}

/**
 * 在宿主元素上建立浮层。
 * @param host    零尺寸的 fixed 宿主元素（见 content/impl.ts）
 * @param onClose 面板内点 ✕ 时回调
 * @param hooks   截图 / 拖动 / 标注回调（由 content/impl.ts 提供）
 */
export function mountPanel(
  host: HTMLElement,
  onClose: () => void,
  hooks: PanelHooks,
): MountedPanel {
  const shadow = host.shadowRoot ?? host.attachShadow({ mode: 'open' });

  if (!shadow.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    // 必须用 buildShadowCss：它把 :root 变量改挂到 .qa-panel-root，
    // 否则浮层里所有 var(--qa-*) 都会失效（背景会变成透明）
    style.textContent = buildShadowCss();
    shadow.appendChild(style);
  }

  const container = document.createElement('div');
  container.className = 'qa-panel-container';
  shadow.appendChild(container);

  const root: Root = createRoot(container);

  return {
    update(request: PanelRequest) {
      root.render(
        <ChatPanel
          request={request}
          onClose={onClose}
          onCaptureRegion={hooks.onCaptureRegion}
          onUserMoved={hooks.onUserMoved}
          highlightEnabled={hooks.highlightEnabled}
          onHighlightPrefChange={hooks.onHighlightPrefChange}
          scriptStale={hooks.scriptStale}
          onDiagnose={hooks.onDiagnose}
          onSnapshot={hooks.onSnapshot}
        />,
      );
    },
    unmount() {
      root.unmount();
      container.remove();
    },
    size() {
      // 量的是面板本体：container 是零尺寸挂载点，量它没有意义
      const node = shadow.querySelector<HTMLElement>('.qa-panel-root');
      if (!node) return { width: 0, height: 0 };

      const rect = node.getBoundingClientRect();
      if (rect.width > 0 || rect.height > 0) {
        return { width: rect.width, height: rect.height };
      }

      // 兜底：布局还没算出来（或环境没有布局引擎）时，矩形会全是 0。
      // 这种情况如果直接返回 0，定位逻辑会一直放弃 → 面板永远定不了位。
      // 所以退一步用 CSS 声明的宽度当作估算值。
      const declared = parseFloat(window.getComputedStyle(node).width);
      const width = Number.isFinite(declared) && declared > 0 ? declared : 384;
      return { width, height: 240 };
    },
  };
}
