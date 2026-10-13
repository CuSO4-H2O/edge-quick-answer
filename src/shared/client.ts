/**
 * DeepSeek 客户端：SSE 流式对话。
 *
 * 两个关键设计决定（都经过实测/查证）：
 *
 * 1. 请求直接从这里（侧边栏页面）发出，不经过 service worker。
 *    实测 https://api.deepseek.com 的 CORS 预检会精确回显 chrome-extension:// 来源，
 *    并允许 authorization 头，所以扩展页面可以直连。
 *    好处：彻底避开 MV3 service worker 30 秒空闲终止，长回答不会被腰斩。
 *
 * 2. 答题默认关闭思考模式（thinking: disabled）。
 *    思考模式默认开启且 effort=high，首字延迟很长，对"快速答题"是负担；
 *    需要深挖时用户可在设置里打开。
 */

import { DEEPSEEK_BASE, DEFAULT_SYSTEM_PROMPT, type Settings } from './constants';

export interface ApiMessage {
  role: 'system' | 'user' | 'assistant';
  /** 纯文本，或带图片的多模态数组 */
  content: string | ContentPart[];
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'original' | 'auto' } };

export interface StreamHandlers {
  onReasoning?: (delta: string) => void;
  onContent: (delta: string) => void;
}

export interface StreamResult {
  content: string;
  reasoning: string;
}

/** 调用失败时抛出，带上可读的中文原因 */
export class ApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

function describeHttpError(status: number, body: string): string {
  const detail = body.slice(0, 500);
  switch (status) {
    case 401:
      return `API Key 无效或已失效（401）。请在设置里重新填写。\n${detail}`;
    case 402:
      return `账户余额不足（402）。请到 platform.deepseek.com 充值。\n${detail}`;
    case 422:
      return `请求参数不合法（422）。\n${detail}`;
    case 429:
      return `请求过于频繁，被限流（429）。稍等几秒再试。\n${detail}`;
    case 500:
    case 503:
      return `DeepSeek 服务端暂时不可用（${status}），稍后重试。\n${detail}`;
    default:
      return `请求失败（HTTP ${status}）。\n${detail}`;
  }
}

export interface ChatOptions {
  settings: Settings;
  messages: ApiMessage[];
  handlers: StreamHandlers;
  signal?: AbortSignal;
}

/**
 * 流式对话。逐块通过 handlers 回调，返回完整结果。
 */
export async function streamChat(options: ChatOptions): Promise<StreamResult> {
  const { settings, messages, handlers, signal } = options;

  if (!settings.apiKey.trim()) {
    throw new ApiError('还没有填写 DeepSeek API Key，请点右上角设置填入。');
  }

  const systemPrompt = settings.systemPrompt.trim() || DEFAULT_SYSTEM_PROMPT;

  // 思考模式下 temperature / penalty 全部失效，就不要传了，避免误导
  const body: Record<string, unknown> = {
    model: settings.model,
    messages: [{ role: 'system', content: systemPrompt }, ...messages],
    stream: true,
    thinking: { type: settings.thinking ? 'enabled' : 'disabled' },
  };
  if (settings.thinking) {
    body.reasoning_effort = settings.reasoningEffort;
  }

  let response: Response;
  try {
    response = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.apiKey.trim()}`,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') throw err;
    throw new ApiError(
      `网络请求失败，请检查网络是否能访问 api.deepseek.com。\n${(err as Error).message}`,
    );
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new ApiError(describeHttpError(response.status, text), response.status);
  }
  if (!response.body) {
    throw new ApiError('响应没有可读的数据流（response.body 为空）。');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let content = '';
  let reasoning = '';

  /** 处理一行 SSE 数据 */
  const handleDataLine = (line: string): boolean => {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith(':')) return false; // 注释/心跳
    if (!trimmed.startsWith('data:')) return false;

    const data = trimmed.slice(5).trim();
    if (data === '[DONE]') return true; // 流结束

    let parsed: {
      choices?: Array<{
        delta?: { content?: string | null; reasoning_content?: string | null };
      }>;
    };
    try {
      parsed = JSON.parse(data);
    } catch {
      return false; // 半包或非法 JSON，跳过
    }

    const delta = parsed.choices?.[0]?.delta;
    if (!delta) return false;

    if (delta.reasoning_content) {
      reasoning += delta.reasoning_content;
      handlers.onReasoning?.(delta.reasoning_content);
    }
    if (delta.content) {
      content += delta.content;
      handlers.onContent(delta.content);
    }
    return false;
  };

  let finished = false;
  while (!finished) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });

    // SSE 以空行分隔事件，但逐行解析更耐受不同实现
    let newlineIndex: number;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      if (handleDataLine(line)) {
        finished = true;
        break;
      }
    }
  }

  // 收尾：可能还剩最后一行没换行
  if (!finished && buffer.trim()) handleDataLine(buffer);

  try {
    await reader.cancel();
  } catch {
    /* 已结束，忽略 */
  }

  if (!content.trim() && !reasoning.trim()) {
    throw new ApiError('模型返回了空内容。可以重试一次，或把思考模式打开。');
  }

  return { content, reasoning };
}
