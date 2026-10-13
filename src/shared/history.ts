/**
 * 对话历史的会话级持久化。
 *
 * 为什么用 sessionStorage 而不是 chrome.storage：
 *   - sessionStorage 按「标签页 + 来源」隔离，天然就是我们要的"这个页面的对话"
 *   - 不会在标签页之间串台，也不会长期堆积
 *   - 关掉标签页自动清理，不需要额外做失效回收
 *
 * 为什么需要它：浮层每次关闭都会卸载 React 树，`useChat` 的状态随之丢失。
 * 不持久化的话，用户只是把浮层关了再打开，之前的问答就没了。
 *
 * ⚠️ 图片（base64 截图）刻意不持久化：一张截图动辄几百 KB，
 * 塞进 sessionStorage（一般上限 5MB）很容易爆掉，而爆掉是抛异常、不是静默截断。
 * 所以恢复历史时只保留文字与引用标签。
 */

import type { ChatMessage } from './constants';

const KEY_PREFIX = 'qa:history:v2:';
/** 最多保留多少条消息 */
const MAX_MESSAGES = 30;
/** 最多保留多少组不同题目的对话 */
const MAX_CONVERSATIONS = 6;

type Persisted = Omit<ChatMessage, 'images'>;

/**
 * 把题目文字压成一个稳定的短键。
 *
 * 用途：同一标签页里不同题目的对话必须彼此独立 ——
 * 用一个固定 key 会让换题后把上一题的对话读回来（"串历史"）。
 *
 * 用 FNV-1a：够短、够稳、无依赖；对中文走 charCodeAt 也稳定。
 */
export function conversationKey(seed: string): string {
  const text = seed.replace(/\s+/g, '').slice(0, 200);
  if (!text) return 'default';

  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    // FNV 素数 16777619 的乘法，用移位避免超出精度
    hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
  }
  return hash.toString(36);
}

const storageKeyFor = (key: string) => `${KEY_PREFIX}${key}`;

function isUsable(): boolean {
  try {
    // 隐私模式等场景下 sessionStorage 可能不可用
    return typeof sessionStorage !== 'undefined' && sessionStorage !== null;
  } catch {
    return false;
  }
}

/** 记录本会话用过哪些对话键，便于控制总量 */
function rememberConversation(key: string): void {
  try {
    const raw = sessionStorage.getItem(`${KEY_PREFIX}__keys`);
    const keys: string[] = raw ? (JSON.parse(raw) as string[]) : [];
    const next = [key, ...keys.filter((k) => k !== key)].slice(0, MAX_CONVERSATIONS);
    // 超出上限的对话直接清掉，避免 sessionStorage 无限增长
    keys
      .filter((k) => !next.includes(k))
      .forEach((k) => sessionStorage.removeItem(storageKeyFor(k)));
    sessionStorage.setItem(`${KEY_PREFIX}__keys`, JSON.stringify(next));
  } catch {
    /* 记不住也不影响主流程 */
  }
}

/** 读取某个对话的历史（失败一律返回空数组，不打断对话） */
export function loadHistory(key = 'default'): ChatMessage[] {
  if (!isUsable()) return [];
  try {
    const raw = sessionStorage.getItem(storageKeyFor(key));
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    return parsed
      .filter((m): m is Persisted => {
        if (typeof m !== 'object' || m === null) return false;
        const obj = m as Record<string, unknown>;
        return (
          typeof obj.id === 'string' &&
          (obj.role === 'user' || obj.role === 'assistant') &&
          typeof obj.content === 'string'
        );
      })
      .slice(-MAX_MESSAGES)
      .map((m) => ({ ...m })); // 图片本来就没存，无需还原
  } catch (err) {
    console.warn('[qa] 读取对话历史失败，忽略:', err);
    return [];
  }
}

/** 写入历史；任何异常都吞掉，历史不该影响主流程 */
export function saveHistory(key: string, messages: ChatMessage[]): void {
  if (!isUsable()) return;
  try {
    const slim: Persisted[] = messages.slice(-MAX_MESSAGES).map((m) => {
      const { images: _images, ...rest } = m;
      return rest;
    });
    sessionStorage.setItem(storageKeyFor(key), JSON.stringify(slim));
    rememberConversation(key);
  } catch (err) {
    // 配额超了之类：清掉这条记录，避免每次写入都失败
    try {
      sessionStorage.removeItem(storageKeyFor(key));
    } catch {
      /* 忽略 */
    }
    console.warn('[qa] 保存对话历史失败（已清理）:', err);
  }
}

export function clearHistory(key?: string): void {
  if (!isUsable()) return;
  try {
    if (key === undefined) {
      // 清空全部：连键列表一起清
      Object.keys(sessionStorage)
        .filter((k) => k.startsWith(KEY_PREFIX))
        .forEach((k) => sessionStorage.removeItem(k));
      return;
    }
    sessionStorage.removeItem(storageKeyFor(key));
  } catch {
    /* 忽略 */
  }
}

/* ------------------------------------------------------------------ *
 * 轻量界面偏好（每个标签页各自记住）
 * ------------------------------------------------------------------ */

const PREF_PREFIX = 'qa:pref:';

export function readPref(key: string, fallback: boolean): boolean {
  if (!isUsable()) return fallback;
  try {
    const raw = sessionStorage.getItem(PREF_PREFIX + key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

export function writePref(key: string, value: boolean): void {
  if (!isUsable()) return;
  try {
    sessionStorage.setItem(PREF_PREFIX + key, value ? '1' : '0');
  } catch {
    /* 忽略 */
  }
}
