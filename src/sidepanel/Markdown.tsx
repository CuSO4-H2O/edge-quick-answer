/**
 * 极简 Markdown → React 节点渲染器。
 *
 * 为什么不用 react-markdown：这个插件的回答结构很固定（短答案 + 几行理由 + 少量列表），
 * 引一个完整的 Markdown 解析器会显著增加体积和依赖，收益很低。
 *
 * 安全设计：全程不碰 dangerouslySetInnerHTML，只构造 React 元素。
 * 模型输出里即使带 <script> 也只会被当成纯文本显示 —— 网页内容会进入模型上下文，
 * 这条防线是必要的，不是过度设计。
 */

import { Fragment, type ReactNode } from 'react';

/** 行内解析：`code`、**粗体** */
function renderInline(text: string, keyPrefix: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  // 用捕获组切分，保留分隔符
  const pattern = /(`[^`\n]+`|\*\*[^*\n]+\*\*)/g;
  const parts = text.split(pattern);

  parts.forEach((part, i) => {
    if (!part) return;
    const key = `${keyPrefix}-${i}`;
    if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      nodes.push(
        <code className="qa-inline-code" key={key}>
          {part.slice(1, -1)}
        </code>,
      );
    } else if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      nodes.push(<strong key={key}>{part.slice(2, -2)}</strong>);
    } else {
      nodes.push(<Fragment key={key}>{part}</Fragment>);
    }
  });

  return nodes;
}

/** 判断是不是"答案行"，用于高亮 */
function isAnswerLine(text: string): boolean {
  return /^\s*(?:\*\*)?\s*答案\s*[:：]/.test(text);
}

/**
 * 把一段 Markdown 文本渲染成节点。
 */
export function renderMarkdown(source: string): ReactNode {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const blocks: ReactNode[] = [];

  let paragraph: string[] = [];
  let listItems: string[] = [];
  let codeLines: string[] = [];
  let inCode = false;

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    const text = paragraph.join('\n');
    const key = `p-${blocks.length}`;
    // 答案行单独高亮：这是本插件最高频的视觉需求
    blocks.push(
      <p className={isAnswerLine(text) ? 'qa-answer-line' : 'qa-p'} key={key}>
        {renderInline(text, key)}
      </p>,
    );
    paragraph = [];
  };

  const flushList = () => {
    if (listItems.length === 0) return;
    const key = `ul-${blocks.length}`;
    blocks.push(
      <ul className="qa-ul" key={key}>
        {listItems.map((item, i) => (
          <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    listItems = [];
  };

  const flushCode = () => {
    if (codeLines.length === 0) return;
    const key = `pre-${blocks.length}`;
    blocks.push(
      <pre className="qa-pre" key={key}>
        <code>{codeLines.join('\n')}</code>
      </pre>,
    );
    codeLines = [];
  };

  for (const line of lines) {
    const fence = line.trim().startsWith('```');

    if (inCode) {
      if (fence) {
        inCode = false;
        flushCode();
      } else {
        codeLines.push(line);
      }
      continue;
    }

    if (fence) {
      flushParagraph();
      flushList();
      inCode = true;
      continue;
    }

    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const bullet = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/.exec(line);

    if (heading) {
      flushParagraph();
      flushList();
      blocks.push(
        <p className="qa-h" key={`h-${blocks.length}`}>
          {renderInline(heading[2], `h-${blocks.length}`)}
        </p>,
      );
      continue;
    }

    if (bullet) {
      flushParagraph();
      listItems.push(bullet[1]);
      continue;
    }

    if (line.trim() === '') {
      flushParagraph();
      flushList();
      continue;
    }

    flushList();
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  flushCode();

  return <>{blocks}</>;
}
