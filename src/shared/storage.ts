/**
 * 设置持久化：chrome.storage.local
 *
 * 关于 API Key 存这里的安全性：扩展的 storage 与其他扩展、与网页的 localStorage
 * 都是隔离的，比把 key 写进网页里安全。但它仍是明文落盘，所以设置页要提醒用户
 * 只充小额、并在 DeepSeek 平台侧设用量上限。
 *
 * ⚠️ 扩展上下文失效（Extension context invalidated）
 *
 * 重新加载扩展后，**已经打开的页面**里的内容脚本还活着，但它持有的扩展上下文
 * 已经作废：此时 chrome.storage 调用会抛 "Extension context invalidated"。
 * 旧实现把这类错误当成"读取失败"静默降级为默认值，结果表现成
 * "Key 保存不上、一直提示未配置" —— 真正的原因是页面该刷新了。
 *
 * 所以这里显式区分：上下文失效时抛 ExtensionGoneError，由 UI 提示用户刷新页面。
 */

import { SETTINGS_DEFAULTS, type Settings } from './constants';

const SETTINGS_KEY = 'qa:settings';

/** 扩展上下文已失效：页面必须刷新才能继续用 */
export class ExtensionGoneError extends Error {
  constructor(action: string, cause?: unknown) {
    super(`扩展刚刚被重新加载，当前页面里的脚本已失效（${action}）。请刷新这个网页。`);
    this.name = 'ExtensionGoneError';
    this.cause = cause;
  }
}

export function isExtensionGone(err: unknown): boolean {
  if (err instanceof ExtensionGoneError) return true;
  const msg = err instanceof Error ? err.message : String(err ?? '');
  return (
    msg.includes('Extension context invalidated') ||
    msg.includes('context invalidated') ||
    // 某些版本抛的是这个
    msg.includes('Receiving end does not exist') ||
    msg.includes('message port closed')
  );
}

/**
 * chrome.storage 是否还可用。
 *
 * ⚠️ 判定以**实际报错内容**为准，不能只看 chrome.runtime.id 存不存在：
 * 万一某环境下 id 取不到，就会把新鲜加载的页面误判成"已失效"，
 * 那就从"静默降级成未配置"变成"误报要求刷新"，同样难用。
 * 这里只在**能确定**失效时提前抛错，其余情况交给调用处 catch 后按错误文案判断。
 */
function assertAlive(action: string): void {
  let runtime: { id?: string } | undefined;
  try {
    runtime = chrome?.runtime as { id?: string } | undefined;
  } catch (err) {
    // 访问 chrome.runtime 本身就抛异常：确定已失效
    throw new ExtensionGoneError(action, err);
  }
  if (runtime !== undefined && runtime.id === undefined) {
    throw new ExtensionGoneError(action);
  }
}

export async function loadSettings(): Promise<Settings> {
  assertAlive('读取设置');
  try {
    const stored = await chrome.storage.local.get(SETTINGS_KEY);
    const raw = stored?.[SETTINGS_KEY] as Partial<Settings> | undefined;
    // 与默认值合并，保证新增字段有值
    return { ...SETTINGS_DEFAULTS, ...(raw ?? {}) };
  } catch (err) {
    if (isExtensionGone(err)) throw new ExtensionGoneError('读取设置', err);
    // 其他异常（例如存储被清空）退回默认值即可，不必打断用户
    console.warn('[qa] 读取设置失败，使用默认值:', err);
    return { ...SETTINGS_DEFAULTS };
  }
}

export async function saveSettings(patch: Partial<Settings>): Promise<Settings> {
  assertAlive('保存设置');
  const current = await loadSettings();
  const next: Settings = { ...current, ...patch };
  try {
    await chrome.storage.local.set({ [SETTINGS_KEY]: next });
  } catch (err) {
    if (isExtensionGone(err)) throw new ExtensionGoneError('保存设置', err);
    throw err;
  }
  return next;
}

/** 监听别的上下文改了设置（例如侧边栏与页面浮层同时打开） */
export function onSettingsChanged(cb: (s: Settings) => void): () => void {
  try {
    const listener = (
      changes: Record<string, chrome.storage.StorageChange>,
      area: string,
    ): void => {
      if (area !== 'local' || !changes[SETTINGS_KEY]) return;
      const raw = changes[SETTINGS_KEY].newValue as Partial<Settings> | undefined;
      cb({ ...SETTINGS_DEFAULTS, ...(raw ?? {}) });
    };
    chrome.storage.onChanged.addListener(listener);
    return () => {
      try {
        chrome.storage.onChanged.removeListener(listener);
      } catch {
        /* 上下文已失效，忽略 */
      }
    };
  } catch {
    // 上下文已失效：返回一个空的取消函数，让调用方逻辑保持简单
    return () => {};
  }
}
