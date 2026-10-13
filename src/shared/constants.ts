/**
 * 共享常量与类型：content script / background / sidepanel 三处都会用到。
 * 注意：content script 被打成 IIFE，这里只能是纯常量与类型，不要引入副作用。
 */

/**
 * 跨上下文消息类型。
 *
 * ⚠️ 改这里时注意：background 与 sidepanel 共用本文件；
 * content script 侧只用到字符串触发消息（'qa:trigger-ask'），不走本常量。
 */
export const MSG = {
  /** content/bg -> sidepanel：有一段新选中的文字要提问 */
  SELECTION: 'qa:selection',
  /** bg -> sidepanel：广播选区 */
  BROADCAST: 'qa:broadcast',
  /** sidepanel -> bg：取走还没被消费的选区 */
  TAKE_PENDING: 'qa:take-pending',
  /** content -> bg：点浮标了，请打开侧边栏 */
  OPEN_PANEL: 'qa:open-panel',
  /** content -> bg：截取当前可见区域并按给定矩形裁剪，返回图片 data URL */
  CAPTURE_REGION: 'qa:capture-region',
} as const;

export const DEEPSEEK_BASE = 'https://api.deepseek.com';

/** 可选模型：v4-pro 不支持图片输入，标注出来避免误用 */
export const MODELS = [
  { id: 'deepseek-flash', label: 'deepseek-flash（快，支持截图）', vision: true },
  { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro（强，纯文本）', vision: false },
] as const;

export type ModelId = (typeof MODELS)[number]['id'];

export interface Settings {
  apiKey: string;
  model: ModelId;
  /** 是否开启思考模式：答题要快就关，追问深挖再开 */
  thinking: boolean;
  /** 推理强度，仅在 thinking 开启时有意义 */
  reasoningEffort: 'low' | 'high' | 'max';
  /** 提问时是否自动附带页面题干上下文 */
  attachPageContext: boolean;
  /** 浮层固定在最上层：点页面别处也不关闭 */
  panelPinned: boolean;
  /**
   * 回答完成后，在网页上把答案对应的选项圈出来。
   * 只做视觉标注，**不会**替用户勾选任何选项。
   */
  highlightAnswer: boolean;
  /** 自定义系统提示词；留空使用 DEFAULT_SYSTEM_PROMPT */
  systemPrompt: string;
}

export const DEFAULT_SYSTEM_PROMPT = `你是一个网页答题助手，服务对象是正在浏览网页、需要快速得到答案的用户。

输出要求：
- 第一行必须以「答案：」开头，直接给出最终结论（选择题只写选项字母，如「答案：B」；多选写「答案：ABD」；判断题写「答案：正确」或「答案：错误」）。
- 第二行空一行，然后用尽量精炼的中文说明理由，通常不超过 5 句话。
- 如果是选择题，逐项点出错误选项错在哪里。
- 若信息不足以确定答案，第一行写「答案：无法确定」，并说明还缺什么信息。
- 不要复述题目，不要写"好的""下面我来回答"之类的开场白。
- 不要在回答里使用 "json" 这个词。`;

export const SETTINGS_DEFAULTS: Settings = {
  apiKey: '',
  model: 'deepseek-flash',
  thinking: false,
  reasoningEffort: 'low',
  attachPageContext: true,
  panelPinned: false,
  highlightAnswer: true,
  systemPrompt: '',
};

export interface SelectionPayload {
  text: string;
  pageTitle: string;
  pageUrl: string;
  /** 从页面提取的题干上下文，可能为空 */
  context?: string;
  /** 触发方式，用于 UI 展示与埋点 */
  source: 'selection' | 'shortcut' | 'contextMenu';
  createdAt: number;
}

/** 一条消息里可以包含的图片（data URL） */
export interface MessageImage {
  dataUrl: string;
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  /** 思考模式下模型输出的思维链 */
  reasoning?: string;
  images?: MessageImage[];
  /**
   * 引用来源标签（如页面标题）。
   * 只用于在气泡上显示一个可编辑的小 chip，
   * 引用的**正文本身不进对话**——它在发送时直接注入 prompt。
   */
  referenceLabel?: string;
  error?: boolean;
  /** 该条回答所用的耗时（毫秒） */
  elapsedMs?: number;
}

export const uid = (): string =>
  `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
