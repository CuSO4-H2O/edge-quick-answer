/**
 * 在网页上高亮"答案对应的选项"。
 *
 * 不做自动勾选（用户明确不要）：只做视觉标注，勾不勾由用户决定。
 * 这也让风险低得多 —— 不改页面状态，就不会静默改错答案。
 *
 * 实现要点：
 *   - 标注元素挂在 **Shadow DOM** 里，不受宿主页面 CSS 影响；定位用 absolute，
 *     坐标由 getBoundingClientRect 算出，**不修改任何页面元素的样式或结构**
 *   - 选项来源分两类：原生 input[type=radio|checkbox]，以及用
 *     role=radio / .option-item 之类的 div 模拟的选项（不少在线判题系统这么做）
 *   - 页面上有多道题时，用选中文字定位到用户正在做的那一组
 */

const MARKER_HOST_ID = 'qa-highlight-host';

/**
 * 字母的来源，可信度从高到低。
 *
 * 为什么需要分级：同一个字母上可能出现多个候选。实测某在线考试系统里，
 * 除了 4 个选项，还有一个 `name="confirm" value="on"` 的确认复选框，
 * 它会被"按组内顺序"编成字母 A —— 与真正的选项 A 撞车。
 * 按来源分级后，有明确字母的选项会胜出，这类杂项自然被淘汰。
 */
type LetterSource = 'drawn' | 'value' | 'positional';

/** 一个候选选项 */
interface OptionCandidate {
  letter: string;
  /** 字母是怎么来的 */
  source: LetterSource;
  /** 原生 input；div 模拟的选项没有 */
  input: HTMLInputElement | null;
  /** 可标注的最小容器 */
  box: HTMLElement;
}

let markerHost: HTMLDivElement | null = null;
/** 当前已标注的选项字母 */
let markedIds: string[] = [];
/** 已标注的元素，用于滚动/缩放后重新定位 */
let markedElements: HTMLElement[] = [];
let repositionScheduled = false;
/** 滚动/缩放监听只能挂一次，否则会不断累积 */
let listenersAttached = false;

/* ------------------------------------------------------------------ *
 * 答案解析
 * ------------------------------------------------------------------ */

/** 从模型回答里解析出选项字母，支持多选 */
export function parseAnswerLetters(text: string): string[] {
  // 容忍 Markdown 加粗与空白：模型很爱输出 "**答案：** B" / "答案 ： B"
  const m = /(?:\*\*)?\s*答案\s*[:：]?\s*(?:\*\*)?\s*([A-Ha-h][\s,，、/A-Ha-h]*)/.exec(text);
  if (!m) return [];
  const letters = m[1].toUpperCase().match(/[A-H]/g) ?? [];
  return [...new Set(letters)];
}

/* ------------------------------------------------------------------ *
 * 选项定位
 * ------------------------------------------------------------------ */

/** 从容器文本里识别选项字母（"B. xxx" / "（B）xxx"） */
function letterFromText(el: Element): string | null {
  const text = (el.textContent ?? '').trim();
  const m = /^[（(]?\s*([A-Ha-h])\s*[)）.、．:：]/.exec(text);
  return m ? m[1].toUpperCase() : null;
}

/**
 * 判断一个值是不是"A–H 的单个字母"。
 *
 * 用码点比较而不是字符范围正则：这直接决定选项字母对不对，错了就整题错。
 *
 * ⚠️ 注意：单个 value 是 A–H 字母**不足以**说明它就是选项字母。
 * 判断题常写 value="T"/"F"，其中 "F" 恰好落在 A–H 里，但它是"错误"的真值。
 * 所以采信与否要看**整组**，见 groupUsesValueLetters()。
 */
function asOptionLetter(value: string): string | null {
  const raw = value.trim();
  if (raw.length !== 1) return null;
  const code = raw.toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 72 ? raw.toUpperCase() : null;
}

/**
 * 整组的 value 是否就是选项字母。
 *
 * 判据：组内每个 value 都是单个 A–H 字母，且**按 DOM 顺序恰好是 A、B、C…**。
 * 是 → 站点在明确标注字母，采信它（比按顺序猜更可靠）。
 * 否（例如 T/F、1/2/3）→ 那些值是别的含义，改用组内顺序编号。
 */
function groupUsesValueLetters(list: HTMLInputElement[]): boolean {
  if (list.length < 2) return false;
  return list.every((input, i) => asOptionLetter(input.value) === String.fromCharCode(65 + i));
}

/**
 * 取选项的最小可标注容器。
 *
 * 优先 label（点它能选中）。但有些站点把**多个选项塞进同一个 label**，
 * 那时圈整块没有意义，就退回 input —— 不过只圈 input 又太小（只有一个小圆点），
 * 所以再尝试向上找一个"只包住这一个选项"的最近祖先。
 */
function smallestOptionBox(input: HTMLElement): HTMLElement {
  const label = input.closest('label');
  if (label) {
    const inside = label.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inside.length === 1) return label;
  }
  return nearestOwnWrapper(input);
}

/**
 * 向上找最近的、只包含这一个 input 且有自己文字的祖先。
 *
 * 用于"多个选项共用一个 label"的版式：这样标注会落在选项那一行上，
 * 而不是缩成 input 的小圆点。
 */
function nearestOwnWrapper(input: HTMLElement): HTMLElement {
  let node: HTMLElement | null = input.parentElement;
  let depth = 0;

  while (node && depth < 5) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;

    const inputCount = node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
    // 只包住这一个 input，并且自己直接带了点文字（不是靠后代撑起来的空壳）
    const hasOwnText = Array.from(node.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
    if (inputCount === 1 && hasOwnText) return node;

    node = node.parentElement;
    depth += 1;
  }
  return input;
}

/** 原生 input 形式的选项 */
function collectInputOptions(): OptionCandidate[] {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
  );

  const groups = new Map<string, HTMLInputElement[]>();
  inputs.forEach((input, i) => {
    const key = input.name || `__pos_${i}`;
    const list = groups.get(key);
    if (list) list.push(input);
    else groups.set(key, [input]);
  });

  const found: OptionCandidate[] = [];
  for (const list of groups.values()) {
    // 先判断整组的 value 是不是就是选项字母（T/F、1/2/3 都不是）
    const trustValue = groupUsesValueLetters(list);

    list.forEach((input, indexInGroup) => {
      if (!input.isConnected) return;
      const box = smallestOptionBox(input);

      // 优先级：文本里画出来的字母 > 整组可信的 value > 组内顺序
      const drawn = letterFromText(box);
      if (drawn) {
        found.push({ letter: drawn, source: 'drawn', input, box });
        return;
      }
      if (trustValue) {
        const fromValue = asOptionLetter(input.value);
        if (fromValue) {
          found.push({ letter: fromValue, source: 'value', input, box });
          return;
        }
      }
      found.push({
        letter: String.fromCharCode(65 + indexInGroup),
        source: 'positional',
        input,
        box,
      });
    });
  }
  return found;
}

/** div/role 模拟的选项（不少在线判题系统这么写） */
function collectRoleOptions(): OptionCandidate[] {
  const nodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"], [role="option"], [data-option], .option-item, .choice-item',
    ),
  );

  const found: OptionCandidate[] = [];
  const counters = new Map<string | null, number>();

  for (const node of nodes) {
    const text = (node.textContent ?? '').trim();
    if (!text || text.length > 400) continue;

    const drawn = letterFromText(node);
    const groupName = node.getAttribute('name') ?? node.closest('[role="radiogroup"]')?.id ?? null;

    let letter = drawn;
    let source: LetterSource = 'drawn';
    if (!letter) {
      // 没画字母的必须有明确的 role 才认，否则容易把普通容器误判成选项
      const role = node.getAttribute('role');
      if (!role) continue;
      const index = counters.get(groupName) ?? 0;
      letter = String.fromCharCode(65 + index);
      source = 'positional';
    }
    counters.set(groupName, (counters.get(groupName) ?? 0) + 1);

    found.push({ letter, source, input: null, box: node });
  }

  return found;
}

/** 合并两种来源；原生 input 优先，避免同一批选项被重复收集 */
function collectOptions(): OptionCandidate[] {
  const byInput = collectInputOptions();
  const nativeBoxes = new Set(byInput.map((o) => o.box));

  const role = collectRoleOptions().filter((o) => {
    // 已经被原生选项覆盖的容器不再重复收集
    if (nativeBoxes.has(o.box)) return false;
    return !o.box.querySelector('input[type="radio"], input[type="checkbox"]');
  });

  return [...byInput, ...role];
}

/**
 * 同一个字母上只保留最可信的候选。
 *
 * 页面里常有与选项无关的 input（确认框、全选框等），它们拿不到明确字母时
 * 会占掉 A/B/C…，与真正的选项撞车。这里按来源分级把它们挤掉：
 * 只要该字母存在"文本里画了字母"的候选，就丢弃同字母的低可信候选。
 */
function preferTrustworthySources(candidates: OptionCandidate[]): OptionCandidate[] {
  const rank: Record<LetterSource, number> = { drawn: 0, value: 1, positional: 2 };

  const bestRankByLetter = new Map<string, number>();
  for (const c of candidates) {
    const current = bestRankByLetter.get(c.letter);
    if (current === undefined || rank[c.source] < current) {
      bestRankByLetter.set(c.letter, rank[c.source]);
    }
  }

  // 有并列最优的（例如多选里两个选项同字母）就都保留，只挤掉更差的
  return candidates.filter((c) => rank[c.source] === bestRankByLetter.get(c.letter));
}

/* ------------------------------------------------------------------ *
 * 多题页面：定位到用户正在做的那一组
 * ------------------------------------------------------------------ */

/** 向上找能覆盖整组选项的容器 */
function groupContainerOf(opt: OptionCandidate): HTMLElement {
  const name = opt.input?.getAttribute('name');
  let node: HTMLElement | null = opt.box.parentElement;
  while (node && node !== document.body) {
    const inputs = Array.from(
      node.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
    );
    if (inputs.length > 1) {
      // 不用 CSS.escape 拼选择器：name 里可能有特殊字符，且个别环境没有它
      const sameGroup = name ? inputs.some((i) => i.getAttribute('name') === name) : true;
      if (sameGroup) return node;
    }
    node = node.parentElement;
  }
  return opt.box.parentElement ?? opt.box;
}

/**
 * 找出"用户正在做的那一组"。
 *
 * 页面上常有多组题（本题 + 下一题），只按字母匹配会把两组都标上，
 * 用户会误以为两题答案相同。
 */
function pickBestGroup(options: OptionCandidate[], questionText: string): OptionCandidate[] {
  if (!questionText.trim() || options.length === 0) return options;

  const needle = questionText.replace(/\s+/g, '').slice(0, 80);
  if (!needle) return options;

  const scored = options.map((opt) => {
    const containerText = (groupContainerOf(opt).textContent ?? '').replace(/\s+/g, '');
    let hits = 0;
    for (const ch of needle) {
      if (containerText.includes(ch)) hits += 1;
    }
    return { opt, score: hits / needle.length };
  });

  const best = scored.reduce((a, b) => (b.score > a.score ? b : a));
  // 匹配度过低说明定位不可靠，宁可全标也不漏标
  if (best.score < 0.35) return options;

  const bestName = best.opt.input?.getAttribute('name');
  const bestContainer = groupContainerOf(best.opt);

  return options.filter((o) => {
    if (bestName) return o.input?.getAttribute('name') === bestName;
    return groupContainerOf(o) === bestContainer;
  });
}

/* ------------------------------------------------------------------ *
 * 标注元素
 * ------------------------------------------------------------------ */

const MARKER_CSS = `
  :host { all: initial; }
  .qa-mark {
    position: absolute;
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 3px 10px;
    border-radius: 999px;
    background: #16a34a;
    color: #fff;
    font: 500 12px/1.5 -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif;
    box-shadow: 0 3px 10px rgba(22, 163, 74, .35);
    white-space: nowrap;
    pointer-events: none;
    z-index: 1;
  }
  .qa-ring {
    position: absolute;
    border: 2px solid #16a34a;
    border-radius: 8px;
    box-shadow: 0 0 0 3px rgba(22, 163, 74, .16);
    pointer-events: none;
    z-index: 0;
  }
`;

function ensureMarkerHost(): ShadowRoot {
  if (markerHost?.isConnected) return markerHost.shadowRoot!;

  const host = document.createElement('div');
  host.id = MARKER_HOST_ID;
  host.style.cssText =
    'all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483646;';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = document.createElement('style');
  style.textContent = MARKER_CSS;
  shadow.appendChild(style);
  document.documentElement.appendChild(host);
  markerHost = host;
  return shadow;
}

/** 重新计算所有标注的位置（滚动/缩放/布局变化后调用） */
function reposition(): void {
  const shadow = markerHost?.shadowRoot;
  if (!shadow || markedElements.length === 0) return;

  const badges = Array.from(shadow.querySelectorAll<HTMLElement>('.qa-mark'));
  const rings = Array.from(shadow.querySelectorAll<HTMLElement>('.qa-ring'));

  markedElements.forEach((el, i) => {
    const ring = rings[i];
    const badge = badges[i];
    if (!ring || !badge) return;

    const rect = el.getBoundingClientRect();
    // 元素滚出视口就藏起来，避免标注飘在错误位置
    const visible = rect.bottom > 0 && rect.top < window.innerHeight && rect.width > 0;
    if (!visible) {
      ring.style.display = 'none';
      badge.style.display = 'none';
      return;
    }

    // 标注层本身可能被宿主页面的 overflow 裁掉（祖先设了 overflow: hidden
    // 时，fixed 元素在某些布局下也会被裁）。所以宁可把坐标夹到视口内，
    // 也不能让标注跑到看不见的地方。
    const clampX = (v: number, w: number) =>
      Math.min(Math.max(v, 4), Math.max(4, window.innerWidth - w - 4));
    const clampY = (v: number) =>
      Math.min(Math.max(v, 4), Math.max(4, window.innerHeight - 28));

    const ringW = rect.width + 6;
    const ringH = rect.height + 6;
    const ringLeft = clampX(rect.left - 3, ringW);
    const ringTop = clampY(rect.top - 3);

    // 元素本身在视口外时（clamp 后位置会失真），不画
    const fullyOffscreen = rect.bottom < 0 || rect.top > window.innerHeight;
    ring.style.display = fullyOffscreen ? 'none' : 'block';
    badge.style.display = fullyOffscreen ? 'none' : 'flex';

    ring.style.left = `${ringLeft}px`;
    ring.style.top = `${ringTop}px`;
    ring.style.width = `${ringW}px`;
    ring.style.height = `${ringH}px`;

    // 徽标优先贴在选项右侧，右边放不下就翻到左边，再放不下就贴着左边缘
    const badgeW = badge.offsetWidth || 120;
    const rightSide = rect.right + 8;
    const leftSide = rect.left - badgeW - 8;
    const fitsRight = rightSide + badgeW < window.innerWidth - 4;
    badge.style.left = `${fitsRight ? rightSide : Math.max(4, leftSide)}px`;
    badge.style.top = `${clampY(rect.top + rect.height / 2 - 13)}px`;
  });
}

function scheduleReposition(): void {
  if (repositionScheduled) return;
  repositionScheduled = true;
  requestAnimationFrame(() => {
    repositionScheduled = false;
    reposition();
  });
}

function attachRepositionListeners(): void {
  if (listenersAttached) return;
  listenersAttached = true;
  window.addEventListener('scroll', scheduleReposition, { passive: true, capture: true });
  window.addEventListener('resize', scheduleReposition, { passive: true });
}

export function clearOptionHighlight(): void {
  const shadow = markerHost?.shadowRoot;
  if (shadow) shadow.querySelectorAll('.qa-mark, .qa-ring').forEach((n) => n.remove());
  markedIds = [];
  markedElements = [];
}

/**
 * 在页面上标出答案对应的选项。
 * @param answerText 模型回答全文（从中解析"答案：B"）
 * @param questionText 用户选中的题目文字，用于在多题页面上定位到正确的一组
 * @returns 实际标注到的选项字母（去重）
 */
export function highlightOption(answerText: string, questionText = ''): string[] {
  clearOptionHighlight();

  const letters = parseAnswerLetters(answerText);
  if (letters.length === 0) return [];

  const all = preferTrustworthySources(collectOptions());
  const matched = all.filter((o) => letters.includes(o.letter));
  if (matched.length === 0) return [];

  const target = pickBestGroup(matched, questionText);
  const shadow = ensureMarkerHost();

  for (const opt of target) {
    const ring = document.createElement('div');
    ring.className = 'qa-ring';
    const badge = document.createElement('div');
    badge.className = 'qa-mark';
    badge.textContent = `✓ AI 建议选 ${opt.letter}`;
    shadow.append(ring, badge);
    markedElements.push(opt.box);
    if (!markedIds.includes(opt.letter)) markedIds.push(opt.letter);
  }

  attachRepositionListeners();
  reposition();
  return markedIds;
}

/** 供 UI 查询当前是否已标注 */
export function hasOptionHighlight(): boolean {
  return markedIds.length > 0;
}
