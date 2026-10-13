/**
 * 轻量事件追踪（放在 shared 里，内容脚本与浮层组件共用）。
 *
 * 用途：有些问题只在真实浏览器里出现（jsdom 测不出来），例如"截图后没有反应"。
 * 这时需要的是一条**时间线**：哪一步执行了、哪一步没到、报了什么错。
 * 追踪结果通过浮层的 ⓘ 按钮一键复制，不用去翻控制台。
 *
 * 刻意做成环形缓冲：上限固定，不会无限增长。
 */

export interface TraceEvent {
  /** 相对启动的毫秒数 */
  t: number;
  /** 事件名 */
  name: string;
  /** 附加信息（已转成短字符串） */
  detail?: string;
}

const MAX_EVENTS = 60;
const started = Date.now();
const events: TraceEvent[] = [];

function shorten(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value === 'string') return value.length > 120 ? `${value.slice(0, 120)}…` : value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  try {
    const json = JSON.stringify(value);
    return json.length > 160 ? `${json.slice(0, 160)}…` : json;
  } catch {
    return String(value);
  }
}

/** 记录一个事件 */
export function trace(name: string, detail?: unknown): void {
  events.push({ t: Date.now() - started, name, detail: shorten(detail) });
  if (events.length > MAX_EVENTS) events.shift();
}

/** 取一份追踪快照（副本，调用方随便改） */
export function traceSnapshot(): TraceEvent[] {
  return events.map((e) => ({ ...e }));
}

/** 清空追踪（例如每次打开浮层时重新开始记） */
export function traceReset(): void {
  events.length = 0;
}
