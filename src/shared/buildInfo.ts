/**
 * 构建指纹。
 *
 * 为什么需要它：重新加载扩展后，**已经打开的页面**里跑的还是旧的内容脚本。
 * 这时它调 chrome.* 会抛 "Extension context invalidated"，
 * 表现成"设置读不到、按钮点不动"，而用户完全看不出原因。
 *
 * 做法：把构建时间写进 manifest 的一个自定义字段，
 * 内容脚本读回来跟自己的编译期常量比对；不一致就说明页面跑的是旧脚本。
 * 这样不依赖任何被作废的 API，也不怕 getManifest 本身失败（那本身就是证据）。
 *
 * scripts/build.mjs 会在每次构建时更新 manifest 里的 dshBuildId。
 */

/** 编译期注入的构建 id；由 scripts/build-content.mjs 通过 define 替换 */
declare const __QA_BUILD_ID__: string;

export const BUILD_ID: string =
  typeof __QA_BUILD_ID__ === 'string' ? __QA_BUILD_ID__ : 'dev';

/** 取当前已加载扩展的构建 id */
function manifestBuildId(): string | null {
  try {
    const manifest = chrome?.runtime?.getManifest?.() as
      | (chrome.runtime.Manifest & { dshBuildId?: string })
      | undefined;
    return manifest?.dshBuildId ?? null;
  } catch (err) {
    // 只有"上下文作废"才算过期。
    // 受限页面（应用商店、PDF 阅读器等）里 chrome API 本就不可用，
    // 那种情况不能误报成"需要刷新"。
    const msg = err instanceof Error ? err.message : String(err ?? '');
    if (msg.includes('invalidated') || msg.includes('context')) return '';
    return null;
  }
}

export interface StaleCheck {
  stale: boolean;
  runningBuild: string;
  extensionBuild: string | null;
}

/**
 * 判断页面里运行的脚本是否已经落后于当前扩展。
 *
 * @returns stale=true 表示必须刷新页面
 */
export function checkBuildFreshness(): StaleCheck {
  const extensionBuild = manifestBuildId();
  const runningBuild = BUILD_ID;

  // 读不到 manifest（context invalidated）→ 必然要刷新
  if (extensionBuild === '') {
    return { stale: true, runningBuild, extensionBuild: null };
  }
  // manifest 里没有 build id：老版本扩展或未按新流程构建，不做判断
  if (extensionBuild === null) {
    return { stale: false, runningBuild, extensionBuild: null };
  }
  return { stale: extensionBuild !== runningBuild, runningBuild, extensionBuild };
}
