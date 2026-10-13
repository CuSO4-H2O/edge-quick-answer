import { useEffect, useRef, useState } from 'react';

interface Props {
  disabled: boolean;
  streaming: boolean;
  hasApiKey: boolean;
  onSend: (text: string) => void;
  onStop: () => void;
  onOpenSettings: () => void;
  /** compact：页面内的单行紧凑输入条 */
  variant?: 'full' | 'compact';
  placeholder?: string;
}

/**
 * 输入区。交互细节：
 *   - Enter 发送，Shift+Enter 换行（compact 变体固定单行）
 *   - 输入框随内容自增高（最多 160px），侧边栏本来就窄，不能吃掉太多高度
 *   - 流式进行中变成"停止"按钮
 */
export function Composer({
  disabled,
  streaming,
  hasApiKey,
  onSend,
  onStop,
  onOpenSettings,
  variant = 'full',
  placeholder,
}: Props): React.ReactElement {
  const [value, setValue] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (variant === 'compact') return;
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [value, variant]);

  const submit = () => {
    const text = value.trim();
    if (!text || disabled) return;
    onSend(text);
    setValue('');
  };

  const defaultPlaceholder =
    variant === 'compact'
      ? '继续追问，或直接和 AI 对话…'
      : '追问或直接提问（Enter 发送，Shift+Enter 换行）';

  return (
    <div className={`qa-composer qa-composer-${variant}`}>
      {!hasApiKey && (
        <button type="button" className="qa-key-hint" onClick={onOpenSettings}>
          未配置 API Key，点此设置 →
        </button>
      )}
      <div className="qa-composer-inner">
        <textarea
          ref={ref}
          className="qa-input"
          value={value}
          rows={1}
          placeholder={streaming ? '正在回答…' : (placeholder ?? defaultPlaceholder)}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        {streaming ? (
          <button type="button" className="qa-send qa-stop" onClick={onStop}>
            停止
          </button>
        ) : (
          <button
            type="button"
            className="qa-send"
            disabled={disabled || !value.trim()}
            onClick={submit}
          >
            发送
          </button>
        )}
      </div>
    </div>
  );
}
