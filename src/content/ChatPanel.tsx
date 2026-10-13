import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useChat } from '../shared/useChat';
import { conversationKey } from '../shared/history';
import { MessageList } from '../sidepanel/MessageList';
import { SettingsPanel } from '../sidepanel/SettingsPanel';
import { clearOptionHighlight, highlightOption } from './highlight';
import { trace } from './trace';
import type { CaptureOutcome } from './captureTypes';
import type { SelectionPayload } from '../shared/constants';

export type PanelMode = 'solve' | 'chat';

export interface PanelRequest {
  /** 每次请求的唯一 id，保证同一模式重复点击也能重新触发 */
  requestId: number;
  mode: PanelMode;
  payload: SelectionPayload;
  /**
   * 打开面板时就要一起发出去的图片（data URL）。
   * 用于右键菜单"截取区域问 AI"：截图在打开面板之前就完成了。
   */
  initialImage?: string;
}

interface Props {
  request: PanelRequest;
  onClose: () => void;
  /** 截取区域 → 图片 data URL（由 content/impl.ts 实现） */
  onCaptureRegion: () => Promise<CaptureOutcome>;
  /**
   * 截图完成后把图片交回外层（content/impl.ts），由它带着图片重新挂载浮层。
   *
   * 为什么不让组件自己直接 ask：框选前必须先把浮层卸载掉（否则浮层会被截进图里），
   * 一卸载这个组件就没了 —— 图片回来时再调 chat.ask() 更新的是**已卸载组件**的状态，
   * 界面上什么都不会发生。这个 bug 就是这么来的。
   */
  onSnapshot: (dataUrl: string) => void;
  /** 用户手动拖动过浮层后通知外层，停止自动定位 */
  onUserMoved: () => void;
  /** 是否在网页上标出答案对应的选项 */
  highlightEnabled: boolean;
  /** 标注结果反馈（空数组表示没匹配到选项） */
  onHighlighted?: (letters: string[]) => void;
  /** 用户切换了"标注答案选项"开关 */
  onHighlightPrefChange?: (v: boolean) => void;
  /**
   * 本页脚本已过期：扩展被重载过，页面里的旧脚本再也调不通 chrome.*。
   * 此时无论用户点什么都只会失败，所以直接显示"请刷新页面"。
   */
  scriptStale?: boolean;
  /** 收集"选项识别"诊断信息，用于排查标注不生效 */
  onDiagnose?: () => string;
}

/** 顶部控制条：引用 + 高亮两个开关 */
function ControlBar({
  label,
  refEnabled,
  onToggleRef,
  highlightEnabled,
  onToggleHighlight,
}: {
  label: string;
  refEnabled: boolean;
  onToggleRef: (v: boolean) => void;
  highlightEnabled: boolean;
  onToggleHighlight: (v: boolean) => void;
}): React.ReactElement {
  return (
    <div className="qa-panel-controls">
      <label className="qa-panel-check" title={label}>
        <input type="checkbox" checked={refEnabled} onChange={(e) => onToggleRef(e.target.checked)} />
        <span className="qa-panel-check-text">
          引用网页正文<span className="qa-panel-check-name">（{label}）</span>
        </span>
      </label>
      <label
        className="qa-panel-check"
        title="在网页上把答案对应的选项圈出来（不会替你勾选）"
      >
        <input
          type="checkbox"
          checked={highlightEnabled}
          onChange={(e) => onToggleHighlight(e.target.checked)}
        />
        <span className="qa-panel-check-text">标注答案选项</span>
      </label>
    </div>
  );
}

export function ChatPanel({
  request,
  onClose,
  onCaptureRegion,
  onUserMoved,
  highlightEnabled,
  onHighlighted,
  onHighlightPrefChange,
  scriptStale,
  onDiagnose,
  onSnapshot,
}: Props): React.ReactElement {
  const { payload, mode, requestId, initialImage } = request;

  /**
   * 对话按题目分行。
   *
   * 用题目文字算键：换一道题就是另一段对话，不会把上一题的内容读回来。
   * 做题目用引用正文（context）当种子会更稳，但那样"同一页面的两道题"会撞车，
   * 所以优先用选中的题目文字。
   */
  const historyKey = useMemo(
    () => conversationKey(payload.text || payload.pageUrl || 'default'),
    [payload.text, payload.pageUrl],
  );

  const chat = useChat({ contextLabel: '当前网页正文', historyKey });
  const [refEnabled, setRefEnabled] = useState(true);
  const [showSettings, setShowSettings] = useState(false);
  const [draft, setDraft] = useState('');
  const [pinned, setPinned] = useState(false);
  const [capturing, setCapturing] = useState(false);
  /** 是否在网页上标注答案选项；由外层持有（关闭浮层后仍然记得） */
  const [hlEnabled, setHlEnabled] = useState(highlightEnabled);
  /** 诊断按钮的反馈状态 */
  const [diagState, setDiagState] = useState<'idle' | 'copied' | 'logged'>('idle');

  useEffect(() => {
    setHlEnabled(highlightEnabled);
  }, [highlightEnabled]);

  // 设置变化时同步开关（用户在设置面板或侧边栏里改了也要生效）
  useEffect(() => {
    if (!chat.settings) return;
    setHlEnabled(chat.settings.highlightAnswer !== false);
  }, [chat.settings]);

  const onToggleHighlight = useCallback(
    (v: boolean) => {
      setHlEnabled(v);
      onHighlightPrefChange?.(v);
    },
    [onHighlightPrefChange],
  );
  /** 已经处理过的 requestId，避免重放 */
  const handledRef = useRef<number>(-1);
  /** 是否已经用设置里的值初始化过置顶状态 */
  const pinnedInit = useRef(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const refText = payload.context;
  /** 用户选中的题目文字，用于在多题页面上把标注定位到正确的一组 */
  const questionRef = useRef(payload.text);
  const label = useMemo(
    () => (payload.pageTitle || payload.pageUrl || '').slice(0, 40),
    [payload.pageTitle, payload.pageUrl],
  );

  // 置顶状态从设置里恢复（每个页面首次打开时同步一次）
  useEffect(() => {
    if (pinnedInit.current || !chat.settings) return;
    pinnedInit.current = true;
    setPinned(chat.settings.panelPinned);
  }, [chat.settings]);

  // 打开时按模式执行一次
  useEffect(() => {
    if (handledRef.current === requestId) return;
    if (!chat.settings) return; // 设置还没加载完，等下一轮再执行
    handledRef.current = requestId;
    questionRef.current = payload.text;

    setRefEnabled(!!refText);

    if (!chat.hasApiKey) {
      setShowSettings(true);
      return;
    }

    if (initialImage) {
      // 右键菜单截图路径：图已经截好了，打开面板就直接问
      chat.ask(payload.text, {
        images: [{ dataUrl: initialImage }],
        reference: refText,
        referenceLabel: refText ? label : undefined,
      });
    } else if (mode === 'solve') {
      // 做题：直接拿选中内容开问，引用随请求发走（不进对话）
      chat.ask(payload.text, {
        reference: refText,
        referenceLabel: refText ? label : undefined,
      });
    } else if (payload.text && payload.text !== '（未选中文字）') {
      // 问 AI：选中内容只作为草稿，由用户决定怎么问
      setDraft(payload.text);
    }
  }, [requestId, mode, payload, chat, refText, label, initialImage]);

  /**
   * 把最新一条回答里的答案标注到网页上。
   *
   * 只做视觉标注，不勾选任何选项（用户明确不要自动勾选）。
   * 没解析出答案、或页面上没有对应选项时，会把旧标注清掉 ——
   * 否则换一道题后，上一题的标注还留在页面上，很容易误导。
   */
  useEffect(() => {
    if (!hlEnabled) {
      clearOptionHighlight();
      return;
    }
    const last = [...chat.messages].reverse().find((m) => m.role === 'assistant' && !m.error);
    if (!last?.content) {
      clearOptionHighlight();
      return;
    }
    const letters = highlightOption(last.content, questionRef.current);
    onHighlighted?.(letters);
    // onHighlighted 是稳定引用，不列入依赖以免每次渲染都重标
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chat.messages, hlEnabled]);

  /** 引用按当前勾选状态组装进这次请求 */
  const send = useCallback(
    (text: string) => {
      chat.ask(text, {
        reference: refEnabled && refText ? refText : undefined,
        referenceLabel: refEnabled && refText ? label : undefined,
      });
    },
    [chat, refEnabled, refText, label],
  );

  const submitDraft = useCallback(() => {
    const text = draft.trim();
    if (!text || chat.streaming) return;
    send(text);
    setDraft('');
  }, [draft, chat.streaming, send]);

  /**
   * 触发截图。
   *
   * 拿到图片后**交给外层**去带图重新挂载浮层，而不是在这里调 chat.ask ——
   * 框选期间浮层已被卸载，这个组件实例已经没了，本地调 ask 界面上不会有任何反应。
   * 本函数只能把结果传出去。
   */
  const snapshot = useCallback(async () => {
    // 每一步都留痕：诊断里 trace 为空 = 点击根本没到达这里，
    // 有 snapshot:click 但没有 capture:start = 被下面的守卫挡住了
    trace('snapshot:click', { capturing, streaming: chat.streaming });

    if (capturing) {
      console.warn('[qa] 截图已在处理中');
      return;
    }
    if (chat.streaming) {
      console.warn('[qa] 模型正在回答，暂不能截图；请先点「停止」');
      chat.setNotice('模型正在回答，请先「停止」再截图');
      return;
    }
    setCapturing(true);
    try {
      const outcome = await onCaptureRegion();
      // 失败时给出可操作的原因，而不是静默恢复浮层（那样只会像"点了没反应"）
      if (outcome.error) {
        const hint = outcome.permissionIssue
          ? '网页里的按钮拿不到截图权限。请改用扩展图标 →「截取区域问 AI」，或先按 Alt+Shift+S。'
          : outcome.error;
        chat.setNotice(`截图失败：${hint}`);
        console.warn('[qa] 截图失败:', outcome.error);
        return;
      }
      if (!outcome.dataUrl) return; // 用户取消，浮层由外层恢复
      onSnapshot(outcome.dataUrl);
    } finally {
      setCapturing(false);
    }
  }, [capturing, chat, onCaptureRegion, onSnapshot]);

  const togglePin = useCallback(() => {
    const next = !pinned;
    setPinned(next);
    chat.saveSettings({ panelPinned: next });
  }, [pinned, chat]);

  /**
   * 拖动浮层。
   *
   * 用 pointer 事件 + 位移增量，直接改 root 的 left/top。
   * 拖动期间不改尺寸，所以不会触发布局抖动。
   */
  const startDrag = useCallback(
    (e: React.PointerEvent<HTMLElement>) => {
      // 点在按钮上不触发拖动
      if ((e.target as HTMLElement).closest('button')) return;
      const root = rootRef.current;
      if (!root) return;

      e.preventDefault();
      const startX = e.clientX;
      const startY = e.clientY;

      /**
       * 读取当前定位。
       *
       * 优先用 style.left/top：定位逻辑（positionPanel）本来就是写这两个值，
       * 而且这不依赖布局引擎 —— getBoundingClientRect() 在无布局环境下返回 0，
       * 会让位移算成"从 0 开始"，一拖就跳到屏幕左上角。
       */
      const readPos = (prop: 'left' | 'top', axis: 'x' | 'y') => {
        const inline = parseFloat(root.style[prop]);
        if (Number.isFinite(inline)) return inline;
        const rect = root.getBoundingClientRect();
        return axis === 'x' ? rect.left : rect.top;
      };

      const originLeft = readPos('left', 'x');
      const originTop = readPos('top', 'y');
      const panelWidth = root.getBoundingClientRect().width;
      const head = e.currentTarget;
      head.classList.add('qa-dragging');

      const onMove = (ev: PointerEvent) => {
        const nextLeft = originLeft + (ev.clientX - startX);
        const nextTop = originTop + (ev.clientY - startY);
        // 至少留 40px 在视口内，避免拖丢
        const maxLeft = window.innerWidth - 40;
        const maxTop = window.innerHeight - 40;
        root.style.left = `${Math.min(Math.max(nextLeft, -panelWidth + 40), maxLeft)}px`;
        root.style.top = `${Math.min(Math.max(nextTop, 0), maxTop)}px`;
      };

      const onUp = () => {
        head.classList.remove('qa-dragging');
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        onUserMoved();
      };

      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    },
    [onUserMoved],
  );

  const settings = chat.settings;

  // 脚本过期（扩展被重载过）或扩展上下文失效：设置读写全不可用。
  // 必须明确告诉用户刷新，否则会表现成"Key 保存不上、按钮点不动"（本次踩过的坑）。
  if (scriptStale || chat.stale) {
    return (
      <div className="qa-panel-root" ref={rootRef}>
        <div className="qa-panel-inner">
          <header className="qa-panel-head" onPointerDown={startDrag} title="按住可拖动">
            <span className="qa-panel-title">
              <span className="qa-grip" />
              需要刷新页面
            </span>
            <span className="qa-panel-actions">
              <button type="button" className="qa-icon-btn" title="关闭 (Esc)" onClick={onClose}>
                ✕
              </button>
            </span>
          </header>
          <div className="qa-panel-empty">
            <p className="qa-panel-empty-title">插件刚刚更新过</p>
            <p className="qa-panel-empty-tip">
              当前页面里跑的还是旧脚本，设置无法读写、功能点了也不会生效。
              <br />
              按 <kbd>F5</kbd> 刷新本页后即可正常使用。
            </p>
          </div>
        </div>
      </div>
    );
  }

  // 设置未就绪，或没配 Key：显示设置面板（而不是让输入框发不出去）
  if (settings && (showSettings || !chat.hasApiKey)) {
    return (
      <div className="qa-panel-root" ref={rootRef}>
        <div className="qa-panel-inner">
          <SettingsPanel
            settings={settings}
            onSave={chat.saveSettings}
            onClose={() => setShowSettings(false)}
            // 点 ✕ / 取消时明确退出设置界面：
            // 否则"没有 Key"这个条件会立刻把设置面板重新弹回来，看起来像关不掉
            onDismiss={() => {
              setShowSettings(false);
              if (!chat.hasApiKey) onClose();
            }}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="qa-panel-root" ref={rootRef}>
      <div className="qa-panel-inner">
        <header className="qa-panel-head" onPointerDown={startDrag} title="按住可拖动">
          <span className="qa-panel-title">
            <span className="qa-grip" />
            {mode === 'solve' ? '做题' : '问 AI'}
          </span>
          <span className="qa-panel-actions">
            <button
              type="button"
              className={`qa-icon-btn ${pinned ? 'qa-pinned' : ''}`}
              title={pinned ? '已固定在最上层（点击取消）' : '固定在最上层，点别处不消失'}
              onClick={togglePin}
            >
              📌
            </button>
            <button
              type="button"
              className="qa-icon-btn"
              title="复制诊断信息（标注不生效时用来排查）"
              onClick={async () => {
                if (!onDiagnose) return;
                const info = onDiagnose();
                try {
                  await navigator.clipboard.writeText(info);
                  setDiagState('copied');
                } catch {
                  // 剪贴板可能被拒（例如非 HTTPS 页面），退化成打印到控制台
                  console.log(info);
                  setDiagState('logged');
                }
                window.setTimeout(() => setDiagState('idle'), 2600);
              }}
            >
              {diagState === 'copied' ? '✓' : diagState === 'logged' ? '⌨' : 'ⓘ'}
            </button>
            <button
              type="button"
              className="qa-icon-btn"
              title="截取页面区域提问（适合读不到文字的题目）"
              onClick={() => void snapshot()}
              disabled={capturing || chat.streaming}
            >
              {capturing ? '…' : '⛶'}
            </button>
            <button
              type="button"
              className="qa-icon-btn"
              title="清空对话"
              onClick={() => chat.reset()}
              disabled={chat.messages.length === 0 && !chat.streaming}
            >
              ⟲
            </button>
            <button
              type="button"
              className="qa-icon-btn"
              title="设置"
              onClick={() => setShowSettings(true)}
            >
              ⚙
            </button>
            <button type="button" className="qa-icon-btn" title="关闭 (Esc)" onClick={onClose}>
              ✕
            </button>
          </span>
        </header>

        {refText && (
          <ControlBar
            label={label}
            refEnabled={refEnabled}
            onToggleRef={setRefEnabled}
            highlightEnabled={highlightEnabled}
            onToggleHighlight={onToggleHighlight}
          />
        )}

        {chat.messages.length === 0 ? (
          <div className="qa-panel-empty">
            <p className="qa-panel-empty-title">
              {mode === 'chat' ? '和 AI 聊聊这段内容' : '正在准备回答…'}
            </p>
            <p className="qa-panel-empty-tip">引用只随请求发送，不会显示在对话里</p>
            <button type="button" className="qa-secondary" onClick={() => void snapshot()}>
              ⛶ 截取页面区域提问
            </button>
          </div>
        ) : (
          <MessageList
            messages={chat.messages}
            streaming={chat.streaming}
            onRetry={chat.retry}
            variant="compact"
          />
        )}

        <div className="qa-panel-composer">
          <textarea
            className="qa-input"
            rows={1}
            value={draft}
            placeholder={
              chat.streaming ? '正在回答…' : mode === 'chat' ? '想了解什么？' : '继续追问…'
            }
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                submitDraft();
              }
            }}
          />
          {chat.streaming ? (
            <button type="button" className="qa-send qa-stop" onClick={chat.stop}>
              停止
            </button>
          ) : (
            <button type="button" className="qa-send" disabled={!draft.trim()} onClick={submitDraft}>
              发送
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
