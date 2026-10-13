import { useCallback, useEffect, useRef, useState } from 'react';
import { MSG, type SelectionPayload } from '../shared/constants';
import { useChat } from '../shared/useChat';
import { Composer } from './Composer';
import { MessageList } from './MessageList';
import { SettingsPanel } from './SettingsPanel';

export function App(): React.ReactElement {
  const chat = useChat({ contextLabel: '当前网页正文' });
  const [showSettings, setShowSettings] = useState(false);
  /** 首次打开且没配 Key 时自动进设置 */
  const autoOpenedSettings = useRef(false);
  /** background 暂存的选区只消费一次，避免后续重连时重复提问 */
  const consumedPayload = useRef(false);

  useEffect(() => {
    if (!chat.settings || autoOpenedSettings.current) return;
    autoOpenedSettings.current = true;
    if (!chat.hasApiKey) setShowSettings(true);
  }, [chat.settings, chat.hasApiKey]);

  /** 处理来自 content script 的选区：正文作为引用发走，不进对话 */
  const handlePayload = useCallback(
    (payload: SelectionPayload) => {
      chat.askFromPayload(payload);
    },
    [chat],
  );

  /* ---------------------------------------------------------------- *
   * 与 background 的连接：接收选区
   * ---------------------------------------------------------------- */
  useEffect(() => {
    let port: chrome.runtime.Port | null = null;
    try {
      port = chrome.runtime.connect({ name: 'qa-sidepanel' });
      port.onMessage.addListener((msg: { type?: string; payload?: SelectionPayload }) => {
        if (msg?.type === MSG.BROADCAST && msg.payload) {
          consumedPayload.current = true;
          handlePayload(msg.payload);
        }
      });
    } catch {
      /* port 建不起来就靠下面的 TAKE_PENDING */
    }

    // 兜底：连上之前 background 可能已经把选区暂存了
    chrome.runtime
      .sendMessage({ type: MSG.TAKE_PENDING })
      .then((res: { payload?: SelectionPayload } | undefined) => {
        if (res?.payload && !consumedPayload.current) {
          consumedPayload.current = true;
          handlePayload(res.payload);
        }
      })
      .catch(() => {
        /* background 正在重启，忽略 */
      });

    return () => {
      try {
        port?.disconnect();
      } catch {
        /* 已断开 */
      }
    };
  }, [handlePayload]);

  if (showSettings && chat.settings) {
    return (
      <div className="qa-app">
        <SettingsPanel
          settings={chat.settings}
          onSave={chat.saveSettings}
          onClose={() => setShowSettings(false)}
        />
      </div>
    );
  }

  return (
    <div className="qa-app">
      <header className="qa-header">
        <div className="qa-header-title">
          <span className="qa-dot" />
          划词答题助手
        </div>
        <div className="qa-header-actions">
          <button
            type="button"
            className="qa-icon-btn"
            title="清空对话"
            onClick={chat.reset}
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
        </div>
      </header>

      {chat.notice && <div className="qa-notice">{chat.notice}</div>}

      {chat.messages.length === 0 ? (
        <div className="qa-empty">
          <div className="qa-empty-icon">✦</div>
          <p className="qa-empty-title">在网页上选中文字，点「做题」</p>
          <ul className="qa-empty-tips">
            <li>
              快捷键 <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> 直接问当前页面
            </li>
            <li>右键菜单也可呼出</li>
            <li>也可以直接在下面输入问题</li>
          </ul>
        </div>
      ) : (
        <MessageList
          messages={chat.messages}
          streaming={chat.streaming}
          onRetry={chat.retry}
          variant="full"
        />
      )}

      <Composer
        disabled={chat.streaming}
        streaming={chat.streaming}
        hasApiKey={chat.hasApiKey}
        onSend={(text) => chat.ask(text)}
        onStop={chat.stop}
        onOpenSettings={() => setShowSettings(true)}
        variant="full"
      />

      <footer className="qa-foot">答案由 AI 生成，请自行核对关键结论</footer>
    </div>
  );
}
