import { useEffect, useRef, useState } from 'react';
import type { ChatMessage } from '../shared/constants';
import { renderMarkdown } from './Markdown';

interface Props {
  messages: ChatMessage[];
  streaming: boolean;
  onRetry: () => void;
  /** compact：页面内浮层用，间距更紧 */
  variant?: 'full' | 'compact';
}

/** 思维链：默认折叠，避免把"快速答题"的主答案挤下去 */
function Reasoning({ text, streaming }: { text: string; streaming: boolean }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <div className={`qa-reasoning ${open ? 'open' : ''}`}>
      <button type="button" className="qa-reasoning-toggle" onClick={() => setOpen((v) => !v)}>
        {open ? '▾' : '▸'} 思考过程{streaming ? '（进行中…）' : ''}
      </button>
      {open && <div className="qa-reasoning-body">{text}</div>}
    </div>
  );
}

function ImageChips({ images }: { images: NonNullable<ChatMessage['images']> }): React.ReactElement {
  return (
    <div className="qa-image-row">
      {images.map((img, i) => (
        <img className="qa-image-chip" src={img.dataUrl} alt={`截图 ${i + 1}`} key={i} />
      ))}
    </div>
  );
}

/**
 * 引用 chip。
 *
 * 只显示来源标签，**不展开正文** —— 正文在发送时直接注入 prompt，
 * 放进对话会让侧边栏/浮层被大段网页文字塞满。
 */
function ReferenceChip({ label }: { label: string }): React.ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <button
      type="button"
      className={`qa-ref-chip ${open ? 'open' : ''}`}
      title={open ? '收起' : `已引用：${label}`}
      onClick={() => setOpen((v) => !v)}
    >
      <span className="qa-ref-ico">❝</span>
      <span className="qa-ref-label">
        {open ? `已引用（正文不显示，仅随请求发送）：${label}` : `引用 ${label}`}
      </span>
    </button>
  );
}

/** 折叠阈值：超过就只显示前几行 */
const COLLAPSE_LIMIT = 220;

/**
 * 用户消息气泡。
 *
 * 用户选中的可能是整段题干 + 全部选项，直接铺开会把面板占满、
 * 而且题库页选出来的文本常常带一堆换行。所以：
 *   - 短内容正常显示
 *   - 长内容默认折叠成几行，可点开
 */
function UserBubble({ text }: { text: string }): React.ReactElement {
  const [expanded, setExpanded] = useState(false);
  const long = text.length > COLLAPSE_LIMIT;

  return (
    <div className={`qa-bubble ${long && !expanded ? 'qa-bubble-collapsed' : ''}`}>
      <span className="qa-bubble-text">{text}</span>
      {long && (
        <button
          type="button"
          className="qa-bubble-toggle"
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? '收起' : `展开（共 ${text.length} 字）`}
        </button>
      )}
    </div>
  );
}

export function MessageList({
  messages,
  streaming,
  onRetry,
  variant = 'full',
}: Props): React.ReactElement {
  const bottomRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** 用户手动往上滚了就不要强行拉回底部 */
  const stickToBottom = useRef(true);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onScroll = () => {
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
      stickToBottom.current = distance < 80;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottom.current) return;
    bottomRef.current?.scrollIntoView({ block: 'end' });
  }, [messages, streaming]);

  return (
    <div className={`qa-messages qa-messages-${variant}`} ref={scrollRef}>
      {messages.map((msg) => {
        if (msg.role === 'user') {
          return (
            <div className="qa-msg qa-msg-user" key={msg.id}>
              {msg.referenceLabel && <ReferenceChip label={msg.referenceLabel} />}
              {msg.images && msg.images.length > 0 && <ImageChips images={msg.images} />}
              <UserBubble text={msg.content} />
            </div>
          );
        }

        const isLast = msg.id === messages[messages.length - 1]?.id;
        const showCursor = streaming && isLast && !msg.content;
        const showTail = streaming && isLast && !!msg.content;

        return (
          <div className={`qa-msg qa-msg-assistant ${msg.error ? 'is-error' : ''}`} key={msg.id}>
            {msg.reasoning && <Reasoning text={msg.reasoning} streaming={streaming && isLast} />}
            {msg.content && <div className="qa-answer">{renderMarkdown(msg.content)}</div>}
            {showCursor && (
              <div className="qa-typing">
                <span />
                <span />
                <span />
              </div>
            )}
            {showTail && <span className="qa-caret" />}
            {msg.error && (
              <button type="button" className="qa-retry" onClick={onRetry}>
                重试
              </button>
            )}
            {!streaming && msg.elapsedMs !== undefined && !msg.error && (
              <div className="qa-meta">{formatElapsed(msg.elapsedMs)}</div>
            )}
          </div>
        );
      })}
      <div ref={bottomRef} />
    </div>
  );
}

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(1)} s`;
}
