/**
 * 扩展上下文失效的处理测试。
 *
 * 背景（用户实际遇到的）：重新加载扩展后，**已经打开的页面**里内容脚本还活着，
 * 但它持有的扩展上下文已作废，chrome.storage 调用会抛
 * "Extension context invalidated"。
 *
 * 旧实现把这类错误当"读取失败"静默降级为默认值，表现成
 * "Key 保存不上、一直提示未配置"，让人以为保存按钮坏了。
 * 现在必须变成明确的"请刷新页面"。
 *
 * 这个测试直接针对构建产物，模拟真实失效场景。
 *
 * 用法：node scripts/test-stale-context.mjs     前置：pnpm build
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

const pageHtml = `<!doctype html><html><body><h3>题目：1+1=?</h3></body></html>`;

/**
 * 注入内容脚本，并让 chrome.storage 抛出指定的错误。
 * @param storageError 传给 storage.get/set 的异常消息（null 表示正常）
 * @param options.runtimeIdThrows 访问 chrome.runtime.id 是否抛错
 */
async function runScenario({ storageError = null, runtimeIdThrows = false } = {}) {
  const dom = new JSDOM(pageHtml, {
    url: 'https://example.edu/exam/1',
    pretendToBeVisual: true,
    runScripts: 'outside-only',
  });
  const { window } = dom;

  const storage = {
    local: {
      get: async () => {
        if (storageError) throw new Error(storageError);
        return {};
      },
      set: async () => {
        if (storageError) throw new Error(storageError);
      },
    },
    onChanged: { addListener: () => {}, removeListener: () => {} },
  };

  const runtime = {
    onMessage: { addListener: () => {} },
    sendMessage: async () => ({ ok: false }),
    connect: () => {
      throw new Error('no port in test');
    },
  };
  if (runtimeIdThrows) {
    Object.defineProperty(runtime, 'id', {
      get() {
        throw new Error('Extension context invalidated.');
      },
    });
  } else {
    runtime.id = 'test-extension-id';
  }

  window.chrome = { runtime, storage };
  window.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);
  window.cancelAnimationFrame = (id) => window.clearTimeout(id);
  if (!window.Element.prototype.scrollIntoView) {
    window.Element.prototype.scrollIntoView = function scrollIntoView() {};
  }

  window.eval(readFileSync(bundlePath, 'utf-8'));
  await new Promise((r) => setTimeout(r, 120));

  // 触发一次划词 → 点「做题」→ 打开浮层
  const textNode = window.document.querySelector('h3').firstChild;
  window.getSelection = () => ({
    isCollapsed: false,
    rangeCount: 1,
    toString: () => textNode.textContent,
    anchorNode: textNode,
    getRangeAt: () => ({
      getBoundingClientRect: () => ({ left: 20, top: 20, right: 200, bottom: 44, width: 180, height: 24 }),
    }),
  });
  window.document.dispatchEvent(
    new window.MouseEvent('mouseup', { bubbles: true, clientX: 100, clientY: 30 }),
  );
  await new Promise((r) => setTimeout(r, 80));

  const bar = window.document
    .getElementById('qa-launcher-host')
    ?.shadowRoot?.querySelector('.qa-bar');
  bar?.querySelector('button')?.dispatchEvent(
    new window.MouseEvent('click', { bubbles: true }),
  );
  await new Promise((r) => setTimeout(r, 220));

  const shadow = window.document.getElementById('qa-panel-host')?.shadowRoot ?? null;
  return { window, shadow, text: shadow?.textContent ?? '' };
}

/* ------------------------------------------------------------------ */

console.log('=== 场景一：扩展上下文失效（storage 抛 context invalidated）===');

{
  const { text, shadow } = await runScenario({
    storageError: 'Extension context invalidated.',
  });
  check('浮层仍能打开（不崩）', !!shadow);
  check('显示"需要刷新页面"提示', text.includes('需要刷新页面'), text.slice(0, 60));
  check('提示里含 F5 指引', text.includes('F5'));
  check(
    '不再把失效静默降级成"未配置 API Key"',
    !text.includes('未配置 API Key') && !text.includes('DeepSeek API Key'),
    '旧实现会显示设置面板，让人以为保存按钮坏了',
  );
}

console.log('\n=== 场景二：runtime.id 取值即抛错 ===');

{
  const { text, shadow } = await runScenario({ runtimeIdThrows: true });
  check('浮层仍能打开', !!shadow);
  check('同样给出刷新提示', text.includes('需要刷新页面'), text.slice(0, 60));
}

console.log('\n=== 场景三：一切正常（不应误报）===');

{
  const { text, shadow } = await runScenario({});
  check('浮层能打开', !!shadow);
  check(
    '不出现"需要刷新页面"误报',
    !text.includes('需要刷新页面'),
    text.slice(0, 60),
  );
  // 没有 API Key 时应该引导去设置，而不是说页面要刷新
  check(
    '未配置 Key 时引导去设置',
    text.includes('DeepSeek API Key'),
    text.slice(0, 80),
  );
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
