/**
 * 浮层样式注入的单元测试。
 *
 * 为什么单独测这个函数：浮层挂在 Shadow DOM 里，而它的 CSS 变量写在 `:root` 中，
 * **`:root` 在 shadow tree 里匹配不到任何元素**（shadow root 不是元素、宿主是 div），
 * 变量会全部失效，`background: var(--qa-bg)` 直接退化成透明。
 *
 * 不能靠"读计算样式"来测：jsdom 根本不做 var() 替换
 * （`background: var(--c)` 会原样返回 `var(--c)` 字符串），
 * 所以这里改为直接断言生成的 CSS 文本。
 *
 * 用 esbuild 编译真实模块，避免测试里复制一份实现导致走样。
 *
 * 用法：node scripts/test-shadow-css.mjs
 */

import { build } from 'esbuild';
import { resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/* 把真实的 injectStyles.ts 编译成可导入的 ESM（CSS 走 text loader 内联） */
const outDir = mkdtempSync(join(tmpdir(), 'qa-shadow-css-'));
const outFile = join(outDir, 'injectStyles.mjs');

await build({
  entryPoints: [resolve(root, 'src/shared/injectStyles.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  loader: { '.css': 'text' },
  logLevel: 'warning',
});

const mod = await import(pathToFileURL(outFile).href);
const { SHARED_CSS, buildShadowCss, panelVariableBlock } = mod;

console.log('=== 生成 Shadow DOM 用的 CSS ===');

const shadowCss = buildShadowCss();

check('原始 CSS 非空', typeof SHARED_CSS === 'string' && SHARED_CSS.length > 1000);

const varBlock = panelVariableBlock();
check('生成了变量块', varBlock.length > 0);
check(
  '变量块挂在 .qa-panel-root 上',
  varBlock.startsWith('.qa-panel-root{') && varBlock.includes('--qa-bg'),
  varBlock.slice(0, 60) + '…',
);
check(
  '不再使用 :host（jsdom 等环境不支持，且无法写回归测试）',
  !shadowCss.includes(':host'),
);

// 关键回归点：变量必须在**匹配得到元素**的选择器上
for (const v of ['--qa-brand', '--qa-bg', '--qa-text', '--qa-border', '--qa-bg-soft']) {
  check(`变量 ${v} 出现在 .qa-panel-root 块里`, varBlock.includes(`${v}:`));
}

// 透明问题的直接断言：用到的变量必须都有定义
const used = new Set([...shadowCss.matchAll(/var\((--[a-z-]+)\)/g)].map((m) => m[1]));
const defined = new Set([...shadowCss.matchAll(/(--[a-z-]+)\s*:/g)].map((m) => m[1]));
const missing = [...used].filter((v) => !defined.has(v));
check(
  `CSS 里用到的 ${used.size} 个变量都有定义（否则属性会失效）`,
  missing.length === 0,
  missing.join(', '),
);

check(
  '补了 box-sizing（shadow tree 没有全局 reset）',
  /box-sizing:\s*border-box/.test(shadowCss),
);

check(
  '变量块在样式之前（保证同选择器下不被覆盖）',
  shadowCss.indexOf('.qa-panel-root{--qa-brand') < shadowCss.indexOf('.qa-panel-root {'),
);

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
