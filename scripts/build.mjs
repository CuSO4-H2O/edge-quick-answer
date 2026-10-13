/**
 * 完整构建流程：
 *   1. Vite 构建侧边栏 + service worker（多入口，允许代码分割）
 *   2. esbuild 构建内容脚本（单文件、完全自包含的 IIFE）
 *
 * 分成两步的原因：Vite 是多入口 + 代码分割，产物必然带 import 语句，
 * 而内容脚本不能是 ESM。见 src/content/impl.ts 的说明。
 *
 * 用法：pnpm build（先跑 tsc 类型检查，再执行本脚本）
 */

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);

/**
 * 用 node 直接跑包的 bin 脚本。
 *
 * 为什么不 spawn node_modules/.bin/vite.cmd：Windows 上不带 shell 直接执行 .cmd
 * 会 EINVAL；带 shell 又会引入参数转义问题（Node 还会报弃用告警）。
 * 用 node 执行 bin 的 JS 入口最干净，且跨平台一致。
 */
function resolveBinEntry(pkg) {
  const pkgJsonPath = require.resolve(`${pkg}/package.json`);
  const pkgDir = dirname(pkgJsonPath);
  const pkgJson = require(pkgJsonPath);
  const binField = pkgJson.bin;
  const rel = typeof binField === 'string' ? binField : binField?.[pkg];
  if (!rel) throw new Error(`${pkg} 没有可用的 bin 入口`);
  const entry = resolve(pkgDir, rel);
  if (!existsSync(entry)) throw new Error(`${pkg} 的 bin 入口不存在: ${entry}`);
  return entry;
}

const run = (label, cmd, args) => {
  console.log(`\n=== ${label} ===`);
  const res = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (res.error) {
    console.error(`\n[build] ${label} 启动失败: ${res.error.message}`);
    process.exit(1);
  }
  if (res.status !== 0) {
    console.error(`\n[build] ${label} 失败（exit ${res.status}）`);
    process.exit(res.status ?? 1);
  }
};

run('Vite：侧边栏 + service worker', process.execPath, [
  resolveBinEntry('vite'),
  'build',
]);
run('esbuild：内容脚本（自包含）', process.execPath, ['scripts/build-content.mjs']);

console.log('\n[build] 全部完成 → dist/');
