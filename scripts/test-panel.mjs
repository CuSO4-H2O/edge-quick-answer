/**
 * 在 jsdom 里加载**真实构建产物** dist/content.js，检查浮层的样式与结构。
 *
 * 为什么要这么做：浮层挂在 Shadow DOM 里，而它的 CSS 变量来自 :root ——
 * 而 `:root` 在 shadow tree 里**匹配不到任何元素**，变量会全部失效。
 * 这类问题靠读代码判断不出来，必须实测计算值。
 * （这个测试正是为了钉死那个 bug：浮层背景变成 rgba(0,0,0,0) 全透明。）
 *
 * 用法：node scripts/test-panel.mjs     前置：pnpm build
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'dist/content.js');

if (!existsSync(bundlePath)) {
  console.error('找不到 dist/content.js，请先 pnpm build');
  process.exit(1);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------------------------ *
 * 样式变量：只做字符串级断言
 *
 * ⚠️ 不要断言"计算后的 background"：jsdom 根本不做 var() 替换
 * （`background: var(--c)` 会原样返回字符串 `var(--c)`），
 * 断言它只会得到一个假的失败。
 * 变量注入是否正确的完整断言在 scripts/test-shadow-css.mjs。
 * ------------------------------------------------------------------ */

console.log('=== Shadow DOM 样式注入 ===');

const sourceCss = readFileSync(resolve(root, 'src/sidepanel/styles.css'), 'utf-8');
const rootVars = [...sourceCss.matchAll(/:root\s*\{([^}]*)\}/g)].flatMap((m) =>
  m[1]
    .split(';')
    .map((d) => d.trim())
    .filter((d) => d.startsWith('--')),
);
check('源样式里存在 :root 变量块', rootVars.length > 0, `${rootVars.length} 个变量`);

const shadowPrelude =
  `*,*::before,*::after{box-sizing:border-box}\n` +
  (rootVars.length ? `.qa-panel-root{${rootVars.join(';')}}\n` : '');

const pageHtml = `<!doctype html><html><body>
  <h3>1. Python 的字符串默认采用（ ）编码。</h3>
  <label><input type="radio" name="q1" value="A"> A. UTF-8</label>
  <label><input type="radio" name="q1" value="B"> B. ASCII</label>
</body></html>`;

const dom = new JSDOM(pageHtml, {
  url: 'https://example.edu/exam/1',
  pretendToBeVisual: true,
  runScripts: 'outside-only',
});
const { window } = dom;

/* chrome API 桩：只实现内容脚本用到的部分，并且**预置一个已保存的 API Key**，
   这样浮层会直接渲染对话界面（而不是被"未配置 Key"挡成设置面板）。 */
/* chrome API 桩：只实现内容脚本用到的部分。
   注意 getManifest 必须返回**真实的构建 id**（从 dist/manifest.json 读），
   否则构建指纹校验会判定"页面脚本已过期"，浮层会显示"请刷新页面"
   而不是对话界面 —— 那样整个测试都在测一个错误的状态。 */
const manifest = JSON.parse(readFileSync(resolve(root, 'dist/manifest.json'), 'utf-8'));
const realBuildId = manifest.dshBuildId ?? null;

const SETTINGS_KEY = 'qa:settings';
const storageStore = {
  [SETTINGS_KEY]: {
    apiKey: 'sk-test-key',
    model: 'deepseek-flash',
    thinking: false,
    reasoningEffort: 'low',
    attachPageContext: true,
    panelPinned: false,
    systemPrompt: '',
  },
};

const chromeStub = {
  runtime: {
    id: 'test-extension-id',
    getManifest: () => ({ dshBuildId: realBuildId }),
    onMessage: { addListener: () => {} },
    sendMessage: async (msg) => {
      // 模拟 background：截取区域返回一张假图
      if (msg?.type === 'qa:capture-region') {
        return { ok: true, dataUrl: 'data:image/jpeg;base64,AAAATESTIMAGE' };
      }
      return { ok: false };
    },
    connect: () => {
      throw new Error('no port in test');
    },
  },
  storage: {
    local: {
      get: async (key) => {
        const k = typeof key === 'string' ? key : undefined;
        if (!k) return { ...storageStore };
        return k in storageStore ? { [k]: storageStore[k] } : {};
      },
      set: async (obj) => {
        Object.assign(storageStore, obj);
      },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  },
};
window.chrome = chromeStub;
// 浮层的诊断按钮会用到剪贴板
window.navigator.clipboard = { writeText: async () => {} };

window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
window.cancelAnimationFrame = (id) => window.clearTimeout(id);

/**
 * jsdom 没有 PointerEvent。React 监听的是 pointerdown/pointermove，
 * 只赋 MouseEvent 的话事件类型不匹配、监听器根本不会触发（拖动的测试会假失败）。
 */
class PointerEventStub extends window.MouseEvent {
  constructor(type, params = {}) {
    super(type, params);
    this.pointerId = params.pointerId ?? 1;
    this.pointerType = params.pointerType ?? 'mouse';
    this.isPrimary = params.isPrimary ?? true;
  }
}
window.PointerEvent = PointerEventStub;

// jsdom 没实现 scrollIntoView，React 里消息列表挂载时会调用它
if (!window.Element.prototype.scrollIntoView) {
  window.Element.prototype.scrollIntoView = function scrollIntoView() {};
}
// jsdom 没实现 setPointerCapture，拖动逻辑里没用到，但保险起见补上
if (!window.Element.prototype.releasePointerCapture) {
  window.Element.prototype.releasePointerCapture = function releasePointerCapture() {};
}

/* ------------------------------------------------------------------ *
 * 注入构建产物
 * ------------------------------------------------------------------ */

try {
  window.eval(readFileSync(bundlePath, 'utf-8'));
} catch (err) {
  console.error('注入 content.js 失败:', err.message);
  process.exit(1);
}

const tick = (ms = 60) => new Promise((r) => setTimeout(r, ms));

/* --- 先验证"变量能否在 Shadow DOM 里解析" --- */
const probeHost = window.document.createElement('div');
probeHost.style.cssText = 'all: initial; position: fixed; top: 0; left: 0;';
window.document.documentElement.appendChild(probeHost);
const probeShadow = probeHost.attachShadow({ mode: 'open' });

const styleEl = window.document.createElement('style');
// 关键：必须带变量前导块（变量挂在 .qa-panel-root 上）
styleEl.textContent = `${shadowPrelude}\n${sourceCss}`;
probeShadow.appendChild(styleEl);

const probe = window.document.createElement('div');
probe.className = 'qa-panel-root';
probeShadow.appendChild(probe);

const cs = window.getComputedStyle(probe);
const brandVar = cs.getPropertyValue('--qa-brand').trim();

check('变量块生效在 .qa-panel-root 上', brandVar !== '', `--qa-brand = "${brandVar}"`);
check(
  '注入的样式文本含不透明背景声明',
  // 不做计算值断言：jsdom 不替换 var()，只看声明本身在不在
  /\.qa-panel-root\s*\{[^}]*--qa-bg:\s*#f{3,6}/i.test(`${shadowPrelude}${sourceCss}`),
  'background 依赖 --qa-bg，变量必须在浮层子树内定义',
);
check('浮层宽度生效（384px）', cs.width === '384px', `width = ${cs.width}`);

/* ------------------------------------------------------------------ *
 * 划词 → 浮标 → 浮层
 * ------------------------------------------------------------------ */

console.log('\n=== 划词浮标与浮层 ===');

const textNode = window.document.querySelector('h3').firstChild;
window.getSelection = () => ({
  isCollapsed: false,
  rangeCount: 1,
  toString: () => textNode.textContent,
  anchorNode: textNode,
  getRangeAt: () => ({
    getBoundingClientRect: () => ({
      left: 40,
      top: 60,
      right: 400,
      bottom: 84,
      width: 360,
      height: 24,
    }),
  }),
});

window.document.dispatchEvent(
  new window.MouseEvent('mouseup', { bubbles: true, clientX: 200, clientY: 70 }),
);
await tick(80);

const launcherHost = window.document.getElementById('qa-launcher-host');
const bar = launcherHost?.shadowRoot?.querySelector('.qa-bar');
check('划词后建立了浮标', !!launcherHost);
check('药丸条可见', !!bar?.classList.contains('qa-visible'));

const buttons = launcherHost?.shadowRoot
  ? [...launcherHost.shadowRoot.querySelectorAll('.qa-bar button')]
  : [];
check('药丸条有 2 个按钮', buttons.length === 2, `实际 ${buttons.length}`);
const labels = buttons.map((b) => b.textContent ?? '');
check('含「做题」', labels.some((l) => l.includes('做题')), labels.join(' | '));
check('含「问 AI」', labels.some((l) => l.includes('问 AI')));

buttons[0]?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
await tick(200);

const shadow = () => window.document.getElementById('qa-panel-host')?.shadowRoot ?? null;
const panelRoot = shadow()?.querySelector('.qa-panel-root');

check('点击后建立了浮层', !!shadow());
check('浮层内注入了 <style>', !!shadow()?.querySelector('style'));
check('浮层根节点存在', !!panelRoot);

/*
 * 定位闪烁回归。
 *
 * 宿主是零尺寸 fixed 元素，面板挂载后会先按 left/top: 0 渲染一帧，
 * JS 才量尺寸去摆位置 —— 那一帧会闪在屏幕左上角（用户实际看到的"闪一下"）。
 * 所以定位完成前必须是 hidden，由 .qa-panel-positioned 负责放行。
 */
check(
  '定位完成后加上 qa-panel-positioned（否则会闪在左上角）',
  panelRoot?.classList.contains('qa-panel-positioned') === true,
  `class="${panelRoot?.className ?? ''}"`,
);
check(
  '定位已写入 left/top（不是默认的 0,0）',
  !!panelRoot?.getAttribute('style')?.includes('left:'),
  panelRoot?.getAttribute('style') ?? '(无内联样式)',
);

console.log('\n=== 浮层结构（拖动 / 置顶 / 截图）===');

if (!shadow()?.querySelector('.qa-panel-composer')) {
  // 浮层没渲染出对话界面时，把关键节点的 HTML 打出来，便于一眼定位
  const headHtml = shadow()?.querySelector('.qa-panel-head')?.outerHTML ?? '(没有顶栏)';
  console.log(`      [诊断] 顶栏 HTML: ${headHtml.replace(/\s+/g, ' ').slice(0, 400)}`);
  console.log(
    `      [诊断] 有 .qa-panel-root: ${!!shadow()?.querySelector('.qa-panel-root')}`,
  );
  console.log(
    `      [诊断] 有 .qa-settings: ${!!shadow()?.querySelector('.qa-settings')}`,
  );
  console.log(
    `      [诊断] 按钮数: ${shadow()?.querySelectorAll('.qa-panel-actions button').length}`,
  );
}

const head = shadow()?.querySelector('.qa-panel-head');
check('顶栏存在（拖动把手）', !!head);
check('顶栏有拖动把手 .qa-grip', !!shadow()?.querySelector('.qa-grip'));
check('有置顶按钮', !!shadow()?.querySelector('.qa-icon-btn[title*="固定"]'));
check('有截图按钮', !!shadow()?.querySelector('.qa-icon-btn[title*="截取"]'));
check('有输入框', !!shadow()?.querySelector('.qa-panel-composer .qa-input'));

/* ------------------------------------------------------------------ *
 * 拖动：PointerEvent 应改变浮层的 left/top
 * ------------------------------------------------------------------ */

console.log('\n=== 拖动 ===');

if (panelRoot && head) {
  // 等 openPanel 里那两次自动定位（rAF + 400ms）跑完，否则它会把拖动结果覆盖掉
  await tick(650);

  // jsdom 无布局引擎，getBoundingClientRect 全为 0；
  // 拖动实现优先读 style.left/top，所以这里先写入一个已知位置。
  panelRoot.style.left = '300px';
  panelRoot.style.top = '200px';

  const fire = (type, x, y) => {
    const ev = new window.PointerEvent(type, {
      bubbles: true,
      cancelable: true,
      clientX: x,
      clientY: y,
    });
    // pointerdown 在顶栏上，pointermove/pointerup 的监听挂在 window 上
    head.dispatchEvent(ev);
    window.dispatchEvent(ev);
  };

  fire('pointerdown', 320, 220);
  fire('pointermove', 420, 300);
  fire('pointerup', 420, 300);

  const left = panelRoot.style.left;
  const top = panelRoot.style.top;
  check('拖动后 left 跟随位移', left === '400px', `left = ${left}（期望 400px）`);
  check('拖动后 top 跟随位移', top === '280px', `top = ${top}（期望 280px）`);

  // 拖动后不应再被自动定位覆盖
  await tick(300);
  check(
    '拖动后自动定位不再覆盖用户位置',
    panelRoot.style.left === '400px',
    `left = ${panelRoot.style.left}`,
  );
} else {
  check('拖动（跳过：浮层未渲染）', false);
}

/* ------------------------------------------------------------------ *
 * 设置保存：应真的写进 chrome.storage
 * ------------------------------------------------------------------ */

console.log('\n=== 设置保存 ===');

if (shadow()) {
  const pinBtn = shadow().querySelector('.qa-icon-btn[title*="固定"]');
  pinBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick(120);

  const saved = storageStore[SETTINGS_KEY];
  check(
    '点置顶按钮后写入 chrome.storage.local',
    saved?.panelPinned === true,
    `panelPinned = ${String(saved?.panelPinned)}`,
  );
  check('原有 API Key 未被覆盖', saved?.apiKey === 'sk-test-key', `apiKey = ${saved?.apiKey}`);
} else {
  check('设置保存（跳过：浮层未渲染）', false);
}

/* ------------------------------------------------------------------ *
 * 截图 → 图片必须真的进入对话
 *
 * 这条回归针对一个真实 bug：框选前浮层会被卸载（否则浮层会被截进图里），
 * 而发起截图的组件实例随之消失 —— 图片回来时若还在组件内部调 ask，
 * 更新的是已卸载组件的状态，界面上毫无反应。
 * ------------------------------------------------------------------ */

console.log('\n=== 截图后图片进入对话 ===');

if (shadow()) {
  const shotBtn = shadow().querySelector('.qa-icon-btn[title*="截取"]');
  check('找到截图按钮', !!shotBtn);

  shotBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 等框选遮罩出现
  await tick(120);
  const shotHost = window.document.getElementById('qa-shot-host');
  check('出现了框选遮罩', !!shotHost);

  const shotShadow = shotHost?.shadowRoot;
  const overlay = shotShadow?.querySelector('.qa-shot-overlay');
  check('遮罩可交互', !!overlay);

  // 模拟框选：mousedown → mousemove → mouseup
  const fire = (type, x, y, target) => {
    const ev = new window.MouseEvent(type, { bubbles: true, clientX: x, clientY: y });
    (target ?? overlay)?.dispatchEvent(ev);
  };
  fire('mousedown', 100, 100);
  fire('mousemove', 300, 220);
  fire('mouseup', 300, 220);
  await tick(60);

  const actions = shotShadow?.querySelector('.qa-shot-actions');
  check('框选后出现确认按钮', !!actions?.classList.contains('qa-visible'));

  const confirmBtn = shotShadow?.querySelector('.qa-shot-primary');
  confirmBtn?.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));

  // 等截图 → 带图重新挂载浮层
  await tick(300);

  const panelAfter = window.document.getElementById('qa-panel-host')?.shadowRoot;
  check('截图后浮层被重新挂载', !!panelAfter?.querySelector('.qa-panel-root'));

  const images = panelAfter?.querySelectorAll('.qa-image-chip') ?? [];
  check(
    '图片作为附件出现在了对话里',
    images.length === 1,
    `实际 ${images.length} 张`,
  );
  check(
    '图片内容正确',
    (images[0]?.getAttribute('src') ?? '').startsWith('data:image/jpeg;base64,'),
    images[0]?.getAttribute('src')?.slice(0, 40) ?? '(无)',
  );
  check(
    '截图提问的问题文案存在',
    (panelAfter?.textContent ?? '').includes('请解答图中的题目'),
    panelAfter?.textContent?.replace(/\s+/g, ' ').slice(0, 80) ?? '',
  );
  check(
    '输入框没有被填入旧选中文字（截图路径不应预填草稿）',
    (panelAfter?.querySelector('.qa-input')?.value ?? '') === '',
    `实际 "${panelAfter?.querySelector('.qa-input')?.value ?? ''}"`,
  );
} else {
  check('截图流程（跳过：浮层未渲染）', false);
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
