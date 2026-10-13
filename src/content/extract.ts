/**
 * 页面正文提取（content script 内运行）。
 *
 * 目标：把网页正文压成一段干净的纯文本，喂给模型当题干上下文。
 * 策略是"够用就好"的启发式，不做通用 Readability：
 *   1. 先找最可能的题目容器（h1/main/article/[class*=question]…）
 *   2. 容器内按块级元素抽文本，标题加粗、列表加短横线
 *   3. 丢弃导航/页脚/脚本等噪声，去重，截断
 *
 * 注意：这里刻意不抓取 input 的 value 与用户输入框内容，避免把密码之类的东西带走。
 */

const BLOCK_SELECTOR = [
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'dt',
  'dd',
  'pre',
  'blockquote',
  'td',
  'th',
  'label',
  'figcaption',
  'summary',
].join(',');

/** 明显是噪声的容器，整块跳过 */
const NOISE_SELECTOR = [
  'nav',
  'footer',
  'aside',
  'script',
  'style',
  'noscript',
  'iframe',
  'svg',
  'canvas',
  'form',
  'template',
  '[role="navigation"]',
  '[role="banner"]',
  '[role="contentinfo"]',
  '[role="search"]',
  '[aria-hidden="true"]',
  '[hidden]',
].join(',');

const DEFAULTS = {
  maxChars: 2600,
  maxLines: 120,
};

/** 折叠所有空白，去掉零宽字符 */
function normalize(text: string): string {
  return text
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 一行里链接文字占比过高 → 多半是导航，丢掉 */
function looksLikeNav(el: Element, line: string): boolean {
  if (line.length < 2) return true;
  const links = el.querySelectorAll('a');
  if (links.length === 0) return false;
  let linkChars = 0;
  links.forEach((a) => {
    linkChars += normalize(a.textContent ?? '').length;
  });
  return linkChars / Math.max(line.length, 1) > 0.6 && links.length > 2;
}

/** 是否像题目/题干文本 */
function looksLikeQuestion(text: string): boolean {
  return /(第\s*[0-9一二三四五六七八九十]+\s*[题问]|[0-9]{1,3}\s*[.、．)）]\s*\S|^\s*[（(]\s*[0-9]{1,3}\s*[)）]|\?\s*$|？\s*$|以下.*(正确|错误)|下列.*(是|有)|单选|多选|判断|填空|question\s*\d)/im.test(
    text,
  );
}

/**
 * 选项行：A. xxx / A、xxx / （A）xxx
 *
 * 刻意不用 A-H 这类字符范围正则：实测本机 Node 24.19 上范围会匹配到范围外的字母
 * （[A-H] 能匹配 G/Q），而这正是"选项字母"判断的核心，错了就全盘错。
 * 这里改用码点判断，语义完全确定。
 */
function looksLikeOption(text: string): boolean {
  // 去掉前导空白与可能包裹的括号
  const s = text.replace(/^\s*[（(]?\s*/, '');
  if (s.length < 2) return false;
  const code = s.toUpperCase().charCodeAt(0);
  if (code < 65 || code > 72) return false; // 必须是 A..H
  // 字母后必须紧跟分隔符：. 、 ． ) ） : ：
  return '.、．)）:：'.includes(s.charAt(1));
}

/**
 * 很多判题系统把选项写成 `<label><input type="radio" value="B"> 哈希表</label>`，
 * textContent 里并没有字母。模型看不到字母就无法回答"选B"，所以这里补出来。
 *
 * 规则：
 *   1. 文本里已经画了字母（"A. 数组"）→ 不重复加
 *   2. 否则一律按组内出现顺序编 A/B/C…
 *
 * 刻意**不采信 input 的 value**：判断题常写 value="T"/"F"（真值），
 * 采信它会把「错误」标成 F 而不是 B —— 这是实测踩到的真实 bug。
 * 只要字母与文字一一对应，模型就能正确作答，站点的 value 语义不可靠。
 *
 * 返回 null 表示这不是一个选项容器。
 */
function optionLetterFor(
  el: Element,
  text: string,
  indexInGroup: number,
): { letter: string; alreadyLabelled: boolean } | null {
  const hasInput = el.matches('input')
    ? true
    : el.querySelector('input[type="radio"], input[type="checkbox"]') !== null;
  if (!hasInput) return null;

  // 文本自带字母（"A. 数组"）就别重复加
  if (looksLikeOption(text)) {
    return { letter: '', alreadyLabelled: true };
  }

  // 按组内顺序编号（0 → A，1 → B …）
  const letter = String.fromCharCode(65 + Math.max(0, indexInGroup));

  // 兜底校验：只允许 A–H，否则宁可不标也不标错
  if (letter < 'A' || letter > 'H') return null;
  return { letter, alreadyLabelled: false };
}

/**
 * 挑选最像正文的容器。找不到就退回 body。
 */
function pickRoot(doc: Document): Element {
  const candidates: Element[] = [];
  const push = (el: Element | null) => {
    if (el && !candidates.includes(el)) candidates.push(el);
  };

  push(doc.querySelector('main'));
  push(doc.querySelector('[role="main"]'));
  push(doc.querySelector('article'));
  push(doc.querySelector('#content, #main, .content, .main, .article'));
  push(
    doc.querySelector(
      '[class*="question" i], [class*="exam" i], [class*="quiz" i], [class*="problem" i], [id*="question" i], [id*="exam" i]',
    ),
  );

  // 兜底：选文字最多的 <div>/<section>
  let best: Element | null = null;
  let bestLen = 0;
  doc.querySelectorAll('div, section').forEach((el) => {
    const len = normalize(el.textContent ?? '').length;
    // 太小的容器没意义，太大的容器多半是整页
    if (len > bestLen && len < 20000) {
      bestLen = len;
      best = el;
    }
  });
  push(best);

  // 优先返回"像题目"的候选，否则返回第一个够大的候选
  for (const el of candidates) {
    const t = normalize(el.textContent ?? '');
    if (t.length >= 20 && looksLikeQuestion(t)) return el;
  }
  for (const el of candidates) {
    if (normalize(el.textContent ?? '').length >= 40) return el;
  }
  return doc.body;
}

export interface ExtractOptions {
  maxChars?: number;
  maxLines?: number;
}

/**
 * 提取当前页面正文。返回空串表示没提到有用的东西。
 */
export function extractPageContext(
  doc: Document = document,
  options: ExtractOptions = {},
): string {
  const { maxChars, maxLines } = { ...DEFAULTS, ...options };
  const root = pickRoot(doc);
  if (!root) return '';

  const lines: string[] = [];
  const seen = new Set<string>();

  const addLine = (raw: string, prefix = '') => {
    const text = normalize(raw);
    if (!text) return;
    const line = prefix + text;
    // 去重键必须用"带前缀的完整行"：否则多题页面上
    // 两道题的同一个选项（如"正确/错误"）会被误判为重复而丢掉
    const key = line.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    lines.push(line);
  };

  // 多题场景：每遇到一组新的单选/复选按钮就记一道题，并给组内选项编 A/B/C…
  const seenGroups = new Set<string>();
  const groupCounters = new Map<string, number>();
  let questionCount = 0;

  /** 识别 <label> 包裹的 <input> 选项，返回组标识 */
  const radioGroupOf = (el: Element, childIndex: number): string | null => {
    const input = el.matches('input')
      ? el
      : el.querySelector('input[type="radio"], input[type="checkbox"]');
    if (!input) return null;
    const i = input as HTMLInputElement;
    const name = i.getAttribute('name');
    if (name) return `name:${name}`;
    // 没有 name 的（少见）按父容器位置分组
    return `pos:${childIndex}`;
  };

  const walk = (el: Element, depth: number) => {
    if (depth > 12 || lines.length >= maxLines) return;
    if (el.matches(NOISE_SELECTOR)) return;

    let childIndex = -1;
    for (const child of Array.from(el.children)) {
      childIndex += 1;
      if (lines.length >= maxLines) return;
      if (child.matches(NOISE_SELECTOR)) continue;

      const tag = child.tagName.toLowerCase();

      // 目录/表格这类块级容器：继续下钻
      if (!child.matches(BLOCK_SELECTOR) && child.children.length > 0) {
        walk(child, depth + 1);
        continue;
      }

      const text = normalize(child.textContent ?? '');
      if (!text) continue;
      if (looksLikeNav(child, text)) continue;

      // 选项容器（label/div 包着 radio）：补出选项字母
      const group = radioGroupOf(child, childIndex);
      if (group) {
        if (!seenGroups.has(group)) {
          seenGroups.add(group);
          questionCount += 1;
          // 只给第 2 题及以后加表头。
          // 第 1 题不加：表头会插在题干之前，反而把首题题干挤到上一题末尾；
          // 而后续题的题干天然出现在自己选项之前，加表头是为了把它们分开。
          if (seenGroups.size > 1) addLine(`【第 ${questionCount} 题】`);
        }
        // 每组的组内序号各自独立计数
        const indexInGroup = groupCounters.get(group) ?? 0;
        groupCounters.set(group, indexInGroup + 1);

        const letter = optionLetterFor(child, text, indexInGroup);
        if (letter) {
          addLine(
            letter.alreadyLabelled || !letter.letter ? text : `${letter.letter}. ${text}`,
          );
        }
        continue;
      }

      if (/^h[1-6]$/.test(tag)) {
        addLine(text, '## ');
      } else if (tag === 'li') {
        // 选项行用原样保留（A. / B、），普通列表项加短横线
        addLine(text, looksLikeOption(text) ? '' : '- ');
      } else if (tag === 'pre') {
        addLine(text, '```\n');
      } else {
        addLine(text);
      }

      // 有些站点把题干和选项混在一个大 div 里，块级元素内部仍有子块
      if (child.children.length > 0 && text.length > 400) {
        walk(child, depth + 1);
      }
    }
  };

  walk(root, 0);

  // 正文没提到东西时，退回 body 的纯文本
  if (lines.length === 0) {
    const fallback = normalize(doc.body?.innerText ?? '');
    if (fallback) lines.push(fallback);
  }

  let out = lines.join('\n');
  // 统一清洗：题库常把标点放在独立元素里，抽出来会是 "A\n.\n100"
  out = cleanExtractedText(out, maxChars);
  return out;
}

/**
 * 把一段文本清洗成"人看着正常、模型看着也正常"的样子。
 *
 * 为什么需要：不少题库把选项字母、句点、选项文字拆在三个元素里，
 * 选中后拿到的是 "A\n.\n100\nB\n.\n20"，直接渲染或喂给模型都很糟
 * （面板里会变成每个字符一行的观感）。
 *
 * 处理内容：
 *   1. 行首尾去空白，丢掉空行
 *   2. 把落单的标点并回上一行（"." 直接贴，"？" 之类的加个空格）
 *   3. 行内连续空白压成一个空格
 *
 * 代码块（``` 围起来的）整段保留原始排版，不做上述处理。
 */
export function cleanExtractedText(input: string, maxChars = 3000): string {
  if (!input) return '';

  const FENCE = /^\s*```/;
  const LETTER_TAIL = /(^|\s)[A-Za-z]$/; // 以孤立字母结尾："A" / "选项 B"
  const OPTION_TAIL = /(^|\s)[A-Za-z][.、．)）:：]$/; // "A." / "B、"

  const out: string[] = [];
  const seen = new Set<string>();
  let inCode = false;

  /** 相邻重复行（题目 + 侧栏重复出现）只留一条 */
  const pushUnique = (line: string) => {
    const key = line.slice(0, 80);
    if (seen.has(key)) return;
    seen.add(key);
    out.push(line);
  };

  for (const raw of input.replace(/\r\n?/g, '\n').split('\n')) {
    if (FENCE.test(raw)) {
      inCode = !inCode;
      out.push(raw.trim());
      continue;
    }

    if (inCode) {
      out.push(raw.replace(/\s+$/, '')); // 代码保留原样
      continue;
    }

    const line = raw.replace(/[ \t\u00a0\u3000]+/g, ' ').trim();
    if (!line) continue;

    const prev = out.length > 0 ? out[out.length - 1] : undefined;
    const canMerge = prev !== undefined && !FENCE.test(prev);

    // 1) 孤立字母 + 紧跟的标点 → 合成选项前缀 "A."
    if (canMerge && /^[.。、,，:：)）]{1,2}$/.test(line) && LETTER_TAIL.test(prev)) {
      out[out.length - 1] = prev + line;
      continue;
    }

    // 2) "A." 后面那行的文字 → 并成 "A. 100"
    if (canMerge && OPTION_TAIL.test(prev) && line.length <= 40) {
      out[out.length - 1] = `${prev} ${line}`;
      continue;
    }

    // 3) 其他落单标点：能贴就贴，贴不上就丢弃（它本属于上一行的结尾）
    if (/^[.。、,，:：;；·…\-—!！?？]{1,3}$/.test(line)) {
      if (canMerge) {
        out[out.length - 1] = /^[.。、,，:：;；·…]+$/.test(line) ? prev + line : `${prev} ${line}`;
      }
      continue;
    }

    pushUnique(line);
  }

  const text = out.join('\n').trim();
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n…（内容过长，已截断）`;
}
