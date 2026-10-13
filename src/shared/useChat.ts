import { useCallback, useEffect, useRef, useState } from 'react';
import {
  uid,
  type ChatMessage,
  type MessageImage,
  type SelectionPayload,
  type Settings,
} from './constants';
import { ApiError, streamChat, type ApiMessage } from './client';
import { clearHistory, loadHistory, saveHistory } from './history';
import { isExtensionGone, loadSettings, onSettingsChanged, saveSettings } from './storage';

/** 历史里最多往回带多少条消息，控制 token 增长 */
const MAX_HISTORY_TURNS = 12;

export interface UseChatOptions {
  /**
   * 引用上下文（网页正文等）注入方式。
   * 关键：正文只进请求，不进对话气泡 —— 否则侧边栏/浮层会被大段正文塞满。
   */
  contextLabel?: string;
  /**
   * 对话分行用的键（通常由题目文字算出）。
   *
   * 为什么需要：历史原先用固定 key，同一标签页里所有对话共用一份 ——
   * 换一道题打开浮层会把上一题的对话读回来，也就是"串历史"。
   * 按题目分行后，不同题目的对话彼此独立。
   */
  historyKey?: string;
}

export interface ChatController {
  settings: Settings | null;
  messages: ChatMessage[];
  streaming: boolean;
  notice: string;
  setNotice: (s: string) => void;
  /**
   * 扩展被重新加载、当前页面脚本失效。
   * 此时设置读写全部不可用，UI 必须提示用户刷新页面
   * （否则会表现成"Key 保存不上"，让人以为是保存按钮坏了）。
   */
  stale: boolean;
  ask: (text: string, opts?: AskOptions) => void;
  /** 直接从选区载荷发起提问（自动处理引用） */
  askFromPayload: (payload: SelectionPayload, text?: string) => void;
  retry: () => void;
  stop: () => void;
  reset: () => void;
  saveSettings: (patch: Partial<Settings>) => void;
  hasApiKey: boolean;
}

export interface AskOptions {
  images?: MessageImage[];
  /** 引用上下文：只发给模型，不在对话里显示 */
  reference?: string;
  /** 引用来源标签，仅用于展示 chip */
  referenceLabel?: string;
  /** 用户可手动去掉引用 */
  referenceEnabled?: boolean;
}

/**
 * 对话状态机：两个界面（侧边栏、页面浮层）共用。
 *
 * 之所以抽出来：流式、重试、中断、上下文注入这些逻辑一旦复制两份必然走样。
 */
export function useChat(options: UseChatOptions = {}): ChatController {
  const [settings, setSettings] = useState<Settings | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [notice, setNotice] = useState('');
  /** 扩展被重新加载：设置读写都不可用，需要刷新页面 */
  const [stale, setStale] = useState(false);
  /**
   * 历史是否已从会话存储恢复。
   * 在恢复之前**绝不能**把空数组写回去，否则会把上次的对话冲掉。
   */
  const hydratedRef = useRef(false);

  const settingsRef = useRef<Settings | null>(null);
  const messagesRef = useRef<ChatMessage[]>([]);
  const abortRef = useRef<AbortController | null>(null);
  const lastTurnRef = useRef<{
    text: string;
    images?: MessageImage[];
    reference?: string;
  } | null>(null);
  const contextLabel = options.contextLabel ?? '当前网页正文';
  const historyKey = options.historyKey ?? 'default';

  useEffect(() => {
    let alive = true;
    loadSettings()
      .then((s) => {
        if (!alive) return;
        settingsRef.current = s;
        setSettings(s);
      })
      .catch((err) => {
        if (!alive) return;
        // 上下文失效：不要静默降级成默认值，否则会表现成"Key 保存不上"
        if (isExtensionGone(err)) {
          setStale(true);
          return;
        }
        console.warn('[qa] 初始化设置失败:', err);
        setSettings((prev) => prev ?? null);
      });
    const off = onSettingsChanged((s) => {
      settingsRef.current = s;
      setSettings(s);
    });
    return () => {
      alive = false;
      off();
    };
  }, []);

  const commitMessages = useCallback((next: ChatMessage[]) => {
    messagesRef.current = next;
    setMessages(next);
  }, []);

  /* 恢复上次的对话（浮层关闭会卸载 React 树，不恢复就丢了）。
     切换题目（historyKey 变化）时开一段新对话，否则会把上一题的内容混进来。 */
  useEffect(() => {
    const restored = loadHistory(historyKey);
    hydratedRef.current = true;
    messagesRef.current = restored;
    setMessages(restored);
    setNotice('');
  }, [historyKey]);

  /* 同步到会话存储 */
  useEffect(() => {
    if (!hydratedRef.current) return;
    saveHistory(historyKey, messages);
  }, [messages, historyKey]);

  /**
   * 把 UI 消息转成 API 消息。
   *
   * 这里是"引用只进 prompt"的落点：reference 在发送时拼进用户消息文本，
   * 既不写进 messages 状态（所以气泡里看不到正文），也不会被重复累积。
   */
  const toApiMessages = useCallback(
    (history: ChatMessage[], reference?: string): ApiMessage[] => {
      const usable = history.filter((m) => !m.error && (m.content.trim() || m.images?.length));
      const sliced = usable.slice(-MAX_HISTORY_TURNS);

      return sliced.map((m, index) => {
        const isLast = index === sliced.length - 1;
        let text = m.content;

        // 引用只挂在最后一条用户消息上，且标注清楚它是参考资料而非问题本身
        if (isLast && m.role === 'user' && reference && reference.trim()) {
          text += `\n\n【参考资料：${contextLabel}（仅供作答参考，可能含无关内容）】\n${reference.trim()}`;
        }

        if (m.role === 'user' && m.images && m.images.length > 0) {
          return {
            role: 'user' as const,
            content: [
              { type: 'text' as const, text },
              ...m.images.map((img) => ({
                type: 'image_url' as const,
                image_url: { url: img.dataUrl, detail: 'high' as const },
              })),
            ],
          };
        }
        return { role: m.role, content: text };
      });
    },
    [contextLabel],
  );

  const runTurn = useCallback(
    async (apiMessages: ApiMessage[]) => {
      const assistantId = uid();
      const startedAt = Date.now();

      commitMessages([
        ...messagesRef.current,
        { id: assistantId, role: 'assistant', content: '' },
      ]);
      setStreaming(true);

      const patchAssistant = (fn: (m: ChatMessage) => ChatMessage) => {
        commitMessages(messagesRef.current.map((m) => (m.id === assistantId ? fn(m) : m)));
      };

      const controller = new AbortController();
      abortRef.current = controller;

      try {
        const current = settingsRef.current;
        if (!current) throw new ApiError('设置尚未加载完成，请稍后重试。');

        const result = await streamChat({
          settings: current,
          messages: apiMessages,
          signal: controller.signal,
          handlers: {
            onReasoning: (delta) =>
              patchAssistant((m) => ({ ...m, reasoning: (m.reasoning ?? '') + delta })),
            onContent: (delta) => patchAssistant((m) => ({ ...m, content: m.content + delta })),
          },
        });

        patchAssistant((m) => ({
          ...m,
          content: result.content,
          reasoning: result.reasoning || m.reasoning,
          elapsedMs: Date.now() - startedAt,
        }));
      } catch (err) {
        const aborted = err instanceof DOMException && err.name === 'AbortError';
        if (aborted) {
          patchAssistant((m) => ({
            ...m,
            content: m.content || '（已停止）',
            elapsedMs: Date.now() - startedAt,
          }));
        } else {
          const message = err instanceof Error ? err.message : String(err);
          patchAssistant((m) => ({
            ...m,
            error: true,
            content: m.content || `⚠️ ${message}`,
            elapsedMs: Date.now() - startedAt,
          }));
        }
      } finally {
        abortRef.current = null;
        setStreaming(false);
      }
    },
    [commitMessages],
  );

  const ask = useCallback(
    (text: string, askOpts: AskOptions = {}) => {
      const userMsg: ChatMessage = {
        id: uid(),
        role: 'user',
        content: text,
        images: askOpts.images && askOpts.images.length > 0 ? askOpts.images : undefined,
        referenceLabel: askOpts.reference ? askOpts.referenceLabel : undefined,
      };
      lastTurnRef.current = {
        text,
        images: askOpts.images,
        reference: askOpts.reference,
      };

      // 历史里保存的是"干净"的用户消息，引用不进入
      const history = [...messagesRef.current, userMsg];
      commitMessages(history);
      void runTurn(toApiMessages(history, askOpts.reference));
    },
    [commitMessages, runTurn, toApiMessages],
  );

  const retry = useCallback(() => {
    const last = lastTurnRef.current;
    if (!last) return;
    const trimmed = messagesRef.current.filter(
      (m, i) => !(i === messagesRef.current.length - 1 && m.error),
    );
    commitMessages(trimmed);
    void runTurn(toApiMessages(trimmed, last.reference));
  }, [commitMessages, runTurn, toApiMessages]);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /**
   * 清空当前对话。
   *
   * 同时清掉存储里的这一条 —— 否则浮层重新挂载时会把旧内容读回来。
   * 模型侧不需要额外"清空记忆"：每轮请求的上下文都是由 messages 现拼的，
   * 这里把 messages 清掉，下一轮请求自然就没有历史了。
   */
  const reset = useCallback(() => {
    abortRef.current?.abort();
    lastTurnRef.current = null;
    clearHistory(historyKey);
    commitMessages([]);
    setNotice('');
  }, [commitMessages, historyKey]);

  const saveSettingsCb = useCallback((patch: Partial<Settings>) => {
    saveSettings(patch)
      .then((s) => {
        settingsRef.current = s;
        setSettings(s);
        setStale(false);
      })
      .catch((err) => {
        // 保存失败必须让用户看见：否则表现成"点了保存但没生效"
        if (isExtensionGone(err)) {
          setStale(true);
          return;
        }
        console.error('[qa] 保存设置失败:', err);
        setNotice(`保存设置失败：${err instanceof Error ? err.message : String(err)}`);
      });
  }, []);

  /** 从选区载荷构造一次提问 */
  const askFromPayload = useCallback(
    (payload: SelectionPayload, text?: string) => {
      const current = settingsRef.current;
      const useContext = (current?.attachPageContext ?? true) && !!payload.context;
      ask(text ?? payload.text.trim() ?? '', {
        reference: useContext ? payload.context : undefined,
        referenceLabel: payload.pageTitle || payload.pageUrl,
      });
    },
    [ask],
  );

  return {
    settings,
    messages,
    streaming,
    notice,
    setNotice,
    stale,
    ask,
    askFromPayload,
    retry,
    stop,
    reset,
    saveSettings: saveSettingsCb,
    hasApiKey: !!settings?.apiKey.trim(),
  };
}
