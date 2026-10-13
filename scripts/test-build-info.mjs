/**
 * 构建指纹（过期脚本检测）测试。
 *
 * 背景：重新加载扩展后，已经打开的页面里跑的还是旧内容脚本，
 * 它调 chrome.* 会抛 "Extension context invalidated"，
 * 表现成"设置读不到、按钮点不动"，而用户看不出原因。
 *
 * 做法：manifest 里写入本次构建 id，内容脚本读回来与自己的编译期常量比对。
 * 这个测试覆盖三种情况：新鲜、过期、受限页面（不能误报）。
 *
 * 用法：node scripts/test-build-info.mjs     前置：pnpm build
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = resolve(root, 'dist/manifest.json');

if (!existsSync(manifestPath)) {
  console.error('找不到 dist/manifest.json，请先 pnpm build');
  process.exit(1);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/* 用真实构建 id 编译模块（define 与 build-content.mjs 保持一致） */
const manifest = JSON.parse(readFileSync(manifestPath, 'utf-8'));
const realBuildId = manifest.dshBuildId;

console.log('=== 构建指纹写入 ===');
check('manifest 里有 dshBuildId', typeof realBuildId === 'string' && realBuildId.length > 0, realBuildId);
check('version_name 与之对应（edge://extensions 可见）', manifest.version_name === realBuildId, manifest.version_name);

const { build } = await import('esbuild');
const outDir = mkdtempSync(join(tmpdir(), 'qa-buildinfo-'));

async function compileWith(buildId) {
  const outFile = join(outDir, `build-${buildId.replace(/\W/g, '_')}.mjs`);
  await build({
    entryPoints: [resolve(root, 'src/shared/buildInfo.ts')],
    outfile: outFile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    define: { __QA_BUILD_ID__: JSON.stringify(buildId) },
    logLevel: 'warning',
  });
  return import(pathToFileURL(outFile).href);
}

console.log('\n=== 新鲜度判定 ===');

// 1) 页面脚本与扩展同一构建 → 新鲜
globalThis.chrome = {
  runtime: { id: 'x', getManifest: () => ({ dshBuildId: realBuildId }) },
};
{
  const mod = await compileWith(realBuildId);
  const r = mod.checkBuildFreshness();
  check('同一次构建 → 不过期', r.stale === false, JSON.stringify(r));
}

// 2) 页面脚本是旧构建 → 过期
{
  const mod = await compileWith('dev.oldbuild');
  const r = mod.checkBuildFreshness();
  check('旧脚本 + 新扩展 → 判定过期', r.stale === true, JSON.stringify(r));
  check('报告了两边的构建 id 便于排查', r.runningBuild === 'dev.oldbuild' && r.extensionBuild === realBuildId);
}

// 3) getManifest 抛 "Extension context invalidated" → 过期
globalThis.chrome = {
  runtime: {
    id: undefined,
    getManifest: () => {
      throw new Error('Extension context invalidated.');
    },
  },
};
{
  const mod = await compileWith(realBuildId);
  const r = mod.checkBuildFreshness();
  check('上下文失效 → 判定过期', r.stale === true, JSON.stringify(r));
}

// 4) 受限页面：chrome API 不可用，但不是"过期"，不能误报
globalThis.chrome = {
  runtime: {
    getManifest: () => {
      throw new Error('Cannot access a chrome:// URL');
    },
  },
};
{
  const mod = await compileWith(realBuildId);
  const r = mod.checkBuildFreshness();
  check('受限页面不误报为过期', r.stale === false, JSON.stringify(r));
}

// 5) 老版本扩展没有 build id → 不做判断，也不能误报
globalThis.chrome = { runtime: { getManifest: () => ({}) } };
{
  const mod = await compileWith(realBuildId);
  const r = mod.checkBuildFreshness();
  check('manifest 无 build id 时不误报', r.stale === false, JSON.stringify(r));
}

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
