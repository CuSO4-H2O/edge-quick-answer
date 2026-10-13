/**
 * 共享样式字符串的唯一出口。
 *
 * 为什么把 CSS 当字符串而不是普通 import：
 *   页面内浮层挂在 Shadow DOM 里，外部 <link> 的样式进不去，
 *   必须把 CSS 文本内联成 <style>。
 *
 * ⚠️ 这里有一个真实踩过的坑，改动前务必读懂：
 *
 *   `:root` **在 shadow tree 里匹配不到任何元素**。
 *   shadow root 不是元素，宿主是 <div>，所以 `:root` 选择器无匹配，
 *   写在它里面的自定义属性（--qa-brand 等）根本不会进入 Shadow DOM。
 *   后果是浮层里所有 `var(--qa-*)` 全部失效：
 *   `background: var(--qa-bg)` 退化成透明，边框/文字色也一起丢。
 *
 *   所以注入到 Shadow DOM 时，必须把变量提出来改挂到 `:host` 上
 *   （:host 是 shadow tree 里唯一能选中宿主的合法选择器）。
 *   injectStyles.ts 里的 buildShadowCss() 就是干这个的，别绕过它。
 */

import css from '../sidepanel/styles.css?inline';

/** 原始 CSS 文本（含 :root 变量块），侧边栏直接用它 */
export const SHARED_CSS: string = css;

/**
 * 从 CSS 里收集自定义属性声明。
 * 同时认 :root / :host / .qa-panel-root 三种写法，避免漏掉。
 */
function collectVars(source: string): string[] {
  const decls: string[] = [];
  const block = /(?::root|:host|\.qa-panel-root)\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = block.exec(source)) !== null) {
    for (const raw of m[1].split(';')) {
      const decl = raw.trim();
      if (decl.startsWith('--') && !decls.includes(decl)) decls.push(decl);
    }
  }
  return decls;
}

/**
 * 生成适合注入 Shadow DOM 的完整 CSS。
 *
 * 关键做法：把变量**直接声明在 `.qa-panel-root` 上**。
 *
 * 为什么不用 `:host` 或 `:root`：
 *   - `:root` 在 shadow tree 里匹配不到任何元素（shadow root 不是元素，
 *     宿主是 <div>），写在里面的变量根本进不来；
 *   - `:host` 虽然语义正确，但对选择器支持的要求更高，
 *     而且 jsdom 之类的环境不支持它（无法写回归测试）。
 *
 * `.qa-panel-root` 是所有面板样式的共同祖先，变量挂在这里既能继承到全部后代，
 * 又不依赖任何特殊选择器。同时补上 box-sizing，因为 shadow tree 没有全局 reset。
 */
export function buildShadowCss(source: string = SHARED_CSS): string {
  const vars = collectVars(source);
  const parts = [
    '*,*::before,*::after{box-sizing:border-box}',
    vars.length > 0 ? `.qa-panel-root{${vars.join(';')}}` : '',
    source,
  ];
  return parts.filter(Boolean).join('\n');
}

/**
 * 仅导出变量块（供测试或特殊场景使用）。
 */
export function panelVariableBlock(source: string = SHARED_CSS): string {
  const vars = collectVars(source);
  return vars.length > 0 ? `.qa-panel-root{${vars.join(';')}}` : '';
}

const INJECTED_ID = 'qa-shared-style';

/**
 * 把共享样式注入某个 root。
 *
 * - ShadowRoot：走 buildShadowCss()，变量挂在 :host 上
 * - Document：直接注入，:root 天然有效
 *
 * 重复调用只会注入一次。
 */
export function injectSharedStyles(target: Document | ShadowRoot): void {
  if (target instanceof Document) {
    if (target.getElementById(INJECTED_ID)) return;
    const style = target.createElement('style');
    style.id = INJECTED_ID;
    style.textContent = SHARED_CSS;
    target.head.appendChild(style);
    return;
  }

  // ShadowRoot
  if (target.getElementById(INJECTED_ID)) return;
  const doc = target.ownerDocument;
  const style = doc.createElement('style');
  style.id = INJECTED_ID;
  style.textContent = buildShadowCss();
  target.appendChild(style);
}
