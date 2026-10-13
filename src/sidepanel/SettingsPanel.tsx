import { useState } from 'react';
import { MODELS, type ModelId, type Settings } from '../shared/constants';

interface Props {
  settings: Settings;
  onSave: (patch: Partial<Settings>) => void;
  onClose: () => void;
  /**
   * 用户**没有保存**就退出（点 ✕ 或取消）。
   * 与 onClose 分开：调用方可能要据此决定是否整体关闭容器
   * （例如"还没配 Key"时把浮层一起关掉，而不是又把设置弹回来）。
   */
  onDismiss?: () => void;
}

/**
 * 设置面板。除了常规项，特意保留"自定义系统提示词"——
 * 答题风格因人而异（只要答案 / 要完整解析），硬编码一种必然有人不满意。
 */
export function SettingsPanel({
  settings,
  onSave,
  onClose,
  onDismiss,
}: Props): React.ReactElement {
  const [draft, setDraft] = useState<Settings>(settings);
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle');
  const [testMsg, setTestMsg] = useState('');

  const patch = (p: Partial<Settings>) => setDraft((d) => ({ ...d, ...p }));

  const dismiss = () => {
    onClose();
    onDismiss?.();
  };

  const save = () => {
    onSave(draft);
    onClose();
  };

  /** 用一次最小请求验证 key 是否可用 */
  const testConnection = async () => {
    setTestState('testing');
    setTestMsg('');
    try {
      if (!draft.apiKey.trim()) throw new Error('请先填写 API Key');
      const res = await fetch('https://api.deepseek.com/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${draft.apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: draft.model,
          messages: [{ role: 'user', content: '回复"ok"两个字符即可' }],
          max_tokens: 8,
          thinking: { type: 'disabled' },
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${text.slice(0, 200)}`);
      }
      setTestState('ok');
      setTestMsg('连接正常，Key 可用');
    } catch (err) {
      setTestState('fail');
      setTestMsg((err as Error).message);
    }
  };

  const isVisionModel = MODELS.find((m) => m.id === draft.model)?.vision ?? false;

  return (
    <div className="qa-settings">
      <div className="qa-settings-head">
        <span>设置</span>
        <button type="button" className="qa-icon-btn" onClick={dismiss} title="关闭">
          ✕
        </button>
      </div>

      <div className="qa-settings-body">
        <label className="qa-field">
          <span className="qa-label">DeepSeek API Key</span>
          <input
            className="qa-text"
            type="password"
            placeholder="sk-..."
            value={draft.apiKey}
            onChange={(e) => patch({ apiKey: e.target.value })}
          />
          <span className="qa-help">
            在 platform.deepseek.com 创建。Key 只存在本机扩展存储里，不会发给第三方；
            建议只充小额并设置用量上限。
          </span>
        </label>

        <div className="qa-field">
          <button
            type="button"
            className="qa-secondary"
            onClick={() => void testConnection()}
            disabled={testState === 'testing'}
          >
            {testState === 'testing' ? '测试中…' : '测试连接'}
          </button>
          {testMsg && (
            <span className={`qa-test-msg ${testState === 'ok' ? 'ok' : 'fail'}`}>{testMsg}</span>
          )}
        </div>

        <label className="qa-field">
          <span className="qa-label">模型</span>
          <select
            className="qa-select"
            value={draft.model}
            onChange={(e) => patch({ model: e.target.value as ModelId })}
          >
            {MODELS.map((m) => (
              <option value={m.id} key={m.id}>
                {m.label}
              </option>
            ))}
          </select>
          {!isVisionModel && (
            <span className="qa-help warn">
              当前模型不支持图片输入，截图提问会失败。
            </span>
          )}
        </label>

        <label className="qa-field qa-field-row">
          <input
            type="checkbox"
            checked={draft.thinking}
            onChange={(e) => patch({ thinking: e.target.checked })}
          />
          <span>
            开启思考模式
            <span className="qa-help block">
              默认关闭以换取最快首字响应。遇到需要推理的难题再打开。
            </span>
          </span>
        </label>

        {draft.thinking && (
          <label className="qa-field">
            <span className="qa-label">推理强度</span>
            <select
              className="qa-select"
              value={draft.reasoningEffort}
              onChange={(e) =>
                patch({ reasoningEffort: e.target.value as Settings['reasoningEffort'] })
              }
            >
              <option value="low">low — 快</option>
              <option value="high">high — 默认</option>
              <option value="max">max — 最深入</option>
            </select>
          </label>
        )}

        <label className="qa-field qa-field-row">
          <input
            type="checkbox"
            checked={draft.highlightAnswer}
            onChange={(e) => patch({ highlightAnswer: e.target.checked })}
          />
          <span>
            在网页上标注答案选项
            <span className="qa-help block">
              回答完成后，把「答案：B」对应的选项在页面上圈出来。
              <strong>只做标注，不会替你勾选</strong>，避免误改答案。
            </span>
          </span>
        </label>

        <label className="qa-field qa-field-row">
          <input
            type="checkbox"
            checked={draft.attachPageContext}
            onChange={(e) => patch({ attachPageContext: e.target.checked })}
          />
          <span>
            提问时附带网页正文
            <span className="qa-help block">
              能显著提升选择题准确率（模型能看到全部选项），但会增加 token 消耗。
            </span>
          </span>
        </label>

        <label className="qa-field">
          <span className="qa-label">自定义系统提示词</span>
          <textarea
            className="qa-textarea"
            rows={6}
            placeholder="留空则使用内置的答题提示词"
            value={draft.systemPrompt}
            onChange={(e) => patch({ systemPrompt: e.target.value })}
          />
        </label>
      </div>

      <div className="qa-settings-foot">
        <button type="button" className="qa-secondary" onClick={dismiss}>
          取消
        </button>
        <button type="button" className="qa-primary" onClick={save}>
          保存
        </button>
      </div>
    </div>
  );
}
