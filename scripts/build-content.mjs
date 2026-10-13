/**
 * 内容脚本单独打包（自包含 IIFE）。
 *
 * 布局考虑：
 *   内联面板时用了 flex + min-height:0，不需要固定高度 ——
 *   让面板按内容自适应，再由定位逻辑夹到视口内即可。
 *
 * 为什么必须自包含：Chrome 不支持把 ESM 当内容脚本加载。
 * 产物里一旦出现 import 语句，内容脚本就会静默失效（不报错、只是没反应）。
 */

import { build } from 'esbuild';
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 构建指纹：写进 manifest 的自定义字段，内容脚本读回来比对。
 * 不一致就说明"页面里跑的是旧脚本"，插件会明确提示刷新页面。
 */
const BUILD_ID = `dev.${Date.now().toString(36)}`;

mkdirSync(resolve(root, 'dist'), { recursive: true });

await build({
  entryPoints: [resolve(root, 'src/entries/content.ts')],
  outfile: resolve(root, 'dist/content.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome114',
  jsx: 'automatic',
  // 内容脚本会跑在每一个页面上，压一下体积；
  // 函数名保留，方便出错时看调用栈。
  minify: true,
  keepNames: true,
  legalComments: 'none',
  loader: { '.css': 'text' },
  define: {
    'process.env.NODE_ENV': '"production"',
    __QA_BUILD_ID__: JSON.stringify(BUILD_ID),
  },
  logLevel: 'warning',
});

// 构建期护栏：这里失败比在浏览器里静默失效好得多
const out = resolve(root, 'dist/content.js');
if (!existsSync(out)) {
  console.error('[build-content] 产物缺失: dist/content.js');
  process.exit(1);
}
const code = readFileSync(out, 'utf-8');
const esm = /^\s*(?:import|export)\s/m.exec(code);
if (esm) {
  console.error(
    `[build-content] content.js 含 ESM 语法（${esm[0].trim()}），内容脚本会加载失败。`,
  );
  process.exit(1);
}

// 把本次构建 id 写进 manifest：页面里的旧脚本据此发现自己过期了
const manifestPath = resolve(root, 'dist/manifest.json');
if (!existsSync(manifestPath)) {
  console.error('[build-content] 找不到 dist/manifest.json（Vite 步骤应先完成）');
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
manifest.dshBuildId = BUILD_ID;
// version_name 只是给人看的（edge://extensions 里显示），保留可读的构建时间
manifest.version_name = BUILD_ID;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

const kb = (Buffer.byteLength(code) / 1024).toFixed(0);
console.log(`✓ content.js 自包含构建完成（${kb} kB, build ${BUILD_ID}）`);
