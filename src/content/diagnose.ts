/**
 * 选项识别的诊断工具。
 *
 * 为什么需要它：不同题库的选项写法差别极大（原生 radio、value="T"/"F"、
 * div 模拟、字母画在别处……）。靠猜页面结构效率很低，
 * 这里直接输出"识别到了什么、为什么"，一眼就能看出问题在哪。
 *
 * 用法（在题目页面按 F12 → 控制台 → 粘贴）：
 *   __qaDebugOptions()
 */

import { parseAnswerLetters } from './highlight';

const STYLE = 'color:#4d6bfe;font-weight:600';
const WARN = 'color:#dc2626;font-weight:600';
const OK = 'color:#16a34a;font-weight:600';

/**
 * 判断一个值是不是"A–H 的单个字母"。
 *
 * 用码点比较而不是字符范围正则：这直接决定选项字母对不对，错了就整题错。
 *
 * ⚠️ 单个 value 是 A–H 字母**不足以**说明它是选项字母：判断题的 value="F"
 * 是"错误"的真值，恰好落在 A–H 里。所以采信与否要看整组。
 */
function asOptionLetter(value: string): string | null {
  const raw = value.trim();
  if (raw.length !== 1) return null;
  const code = raw.toUpperCase().charCodeAt(0);
  return code >= 65 && code <= 72 ? raw.toUpperCase() : null;
}

/**
 * 整组的 value 是否就是选项字母（按 DOM 顺序恰好 A、B、C…）。
 * 与 highlight.ts 保持同一规则。
 */
function groupUsesValueLetters(list: HTMLInputElement[]): boolean {
  if (list.length < 2) return false;
  return list.every((input, i) => asOptionLetter(input.value) === String.fromCharCode(65 + i));
}

/**
 * 同一个字母上只保留最可信的候选（与 highlight.ts 同规则）。
 *
 * 页面里常有与选项无关的 input（确认框、全选框），它们拿不到明确字母时
 * 会占掉 A/B/C…，与真正的选项撞车。实测某考试系统的 `name="confirm"` 就是这样。
 */
function preferTrustworthySources<T extends { letter: string; letterSource: string }>(
  candidates: T[],
): { kept: T[]; dropped: number } {
  const rank = (source: string) =>
    source === '文本里的字母' ? 0 : source === 'input.value' ? 1 : 2;

  const best = new Map<string, number>();
  for (const c of candidates) {
    const r = rank(c.letterSource);
    const cur = best.get(c.letter);
    if (cur === undefined || r < cur) best.set(c.letter, r);
  }
  const kept = candidates.filter((c) => rank(c.letterSource) === best.get(c.letter));
  return { kept, dropped: candidates.length - kept.length };
}

/** 取选项的最小可标注容器（与 highlight.ts 同规则） */
function smallestOptionBox(input: HTMLElement): HTMLElement {
  const label = input.closest('label');
  if (label) {
    const inside = label.querySelectorAll('input[type="radio"], input[type="checkbox"]');
    if (inside.length === 1) return label;
  }
  return nearestOwnWrapper(input);
}

/** 向上找最近的、只包含这一个 input 且有自己文字的祖先 */
function nearestOwnWrapper(input: HTMLElement): HTMLElement {
  let node: HTMLElement | null = input.parentElement;
  let depth = 0;
  while (node && depth < 5) {
    const tag = node.tagName.toLowerCase();
    if (tag === 'body' || tag === 'html') break;
    const inputCount = node.querySelectorAll('input[type="radio"], input[type="checkbox"]').length;
    const hasOwnText = Array.from(node.childNodes).some(
      (n) => n.nodeType === Node.TEXT_NODE && (n.textContent ?? '').trim().length > 0,
    );
    if (inputCount === 1 && hasOwnText) return node;
    node = node.parentElement;
    depth += 1;
  }
  return input;
}

function letterFromText(el: Element): string | null {
  const text = (el.textContent ?? '').trim();
  const m = /^[（(]?\s*([A-Ha-h])\s*[)）.、．:：]/.exec(text);
  return m ? m[1].toUpperCase() : null;
}

/** 描述一个元素，便于在控制台里核对 */
function describe(el: Element): string {
  const tag = el.tagName.toLowerCase();
  const cls = el.className && typeof el.className === 'string' ? `.${el.className.split(/\s+/)[0]}` : '';
  const id = el.id ? `#${el.id}` : '';
  const text = (el.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 60);
  return `<${tag}${id}${cls}> "${text}"`;
}

export interface OptionDiagnosis {
  nativeInputs: number;
  roleOptions: number;
  groups: number;
  matchedLetters: string[];
  options: {
    letter: string;
    letterSource: string;
    box: string;
    inputValue: string;
    inputName: string;
    boxArea: number;
  }[];
  /** 因字母来源不可信而被挤掉的候选数（确认框、全选框等杂项） */
  filteredOut: number;
  answerParsed: string[];
  problems: string[];
}

/**
 * 诊断选项识别。
 * @param sampleAnswer 可选：拿来试解析的回答文本，例如 "答案：B"
 */
export function diagnoseOptions(sampleAnswer = '答案：B'): OptionDiagnosis {
  const inputs = Array.from(
    document.querySelectorAll<HTMLInputElement>('input[type="radio"], input[type="checkbox"]'),
  );
  const roleNodes = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[role="radio"], [role="checkbox"], [role="option"], [data-option], .option-item, .choice-item',
    ),
  );

  const groups = new Map<string, HTMLInputElement[]>();
  inputs.forEach((input, i) => {
    const key = input.name || `__pos_${i}`;
    const list = groups.get(key);
    if (list) list.push(input);
    else groups.set(key, [input]);
  });

  const viewportArea = window.innerWidth * window.innerHeight;
  const options: OptionDiagnosis['options'] = [];
  const problems: string[] = [];

  for (const list of groups.values()) {
    const trustValue = groupUsesValueLetters(list);

    list.forEach((input, indexInGroup) => {
      const box = smallestOptionBox(input);
      const rect = box.getBoundingClientRect();
      const area = rect.width * rect.height;

      let letter: string;
      let source: string;
      const drawn = letterFromText(box);
      const fromValue = trustValue ? asOptionLetter(input.value) : null;
      if (drawn) {
        letter = drawn;
        source = '文本里的字母';
      } else if (fromValue) {
        letter = fromValue;
        source = 'input.value';
      } else {
        letter = String.fromCharCode(65 + indexInGroup);
        source = '组内顺序';
      }

      options.push({
        letter,
        letterSource: source,
        box: describe(box),
        inputValue: input.value,
        inputName: input.name || '(无 name)',
        boxArea: Math.round((area / Math.max(viewportArea, 1)) * 100),
      });
    });
  }

  for (const node of roleNodes) {
    const text = (node.textContent ?? '').trim();
    if (!text || text.length > 400) continue;
    const drawn = letterFromText(node);
    if (!drawn && !node.getAttribute('role')) continue;
    options.push({
      letter: drawn ?? '(按顺序)',
      letterSource: drawn ? '文本里的字母' : 'role 声明',
      box: describe(node),
      inputValue: '(非 input)',
      inputName: node.getAttribute('name') ?? '(无)',
      boxArea: Math.round(
        ((node.getBoundingClientRect().width * node.getBoundingClientRect().height) /
          Math.max(viewportArea, 1)) *
          100,
      ),
    });
  }

  // 常见问题体检
  if (inputs.length === 0 && roleNodes.length === 0) {
    problems.push(
      '没有找到任何 radio/checkbox，也没有 role=radio 之类的容器 —— ' +
        '选项可能用了别的写法（例如纯 div + 点击事件），请把选项那段 HTML 发给我',
    );
  }
  if (inputs.length > 0 && roleNodes.length === 0 && options.length === 0) {
    problems.push('找到了 input 但没能构造出选项，可能是 label 结构异常');
  }

  const answerParsed = parseAnswerLetters(sampleAnswer);
  if (answerParsed.length === 0) {
    problems.push(`示例回答 "${sampleAnswer}" 里没解析出字母（正常回答必须以"答案："开头）`);
  }

  // 按来源可信度过滤：把确认框/全选框这类"占用了字母的杂项"挤掉。
  // 体检必须在过滤**之后**做，否则会把已淘汰的杂项也算成问题（噪声）。
  const { kept, dropped } = preferTrustworthySources(options);

  const noLetter = kept.filter((o) => o.letterSource === '组内顺序');
  if (noLetter.length > 0 && inputs.length > 0) {
    problems.push(
      `有 ${noLetter.length} 个选项没在文本或 value 里找到字母，只能按组内顺序编号；` +
        '如果页面显示的字母顺序与此不一致，标注会错位',
    );
  }
  const badArea = kept.filter((o) => o.boxArea > 60);
  if (badArea.length > 0) {
    problems.push(
      `有 ${badArea.length} 个"选项容器"占了视口 60% 以上，可能把整块题目当成选项圈起来`,
    );
  }

  const result: OptionDiagnosis = {
    nativeInputs: inputs.length,
    roleOptions: roleNodes.length,
    groups: groups.size,
    matchedLetters: answerParsed,
    options: kept,
    // 被挤掉的杂项一并报出来，便于确认判断是否符合预期
    filteredOut: dropped,
    answerParsed,
    problems,
  };

  /* 输出到控制台 */
  //
  // ⚠️ 内容脚本运行在**扩展的隔离世界**里，它的 console 输出不会出现在
  // 页面自己的控制台过滤器下。用户需要在 DevTools 控制台的
  // 上下文（Console 左上角的下拉框）里选本扩展，或在扩展的
  // "检查视图 → 服务工作进程" 里看。为了不依赖这一点，
  // 下面额外打印一行可复制的 JSON，直接把那一行发给我就行。
  console.log('%c[qa:options] 选项识别诊断', STYLE);
  console.log(
    `  原生 input: ${inputs.length}　role/div 候选: ${roleNodes.length}　分组: ${groups.size}`,
  );
  if (options.length > 0) {
    console.table(
      options.map((o) => ({
        字母: o.letter,
        字母来源: o.letterSource,
        容器: o.box,
        'input.value': o.inputValue,
        'input.name': o.inputName,
        '占视口%': o.boxArea,
      })),
    );
  }
  console.log(`  示例回答解析出的字母: ${JSON.stringify(answerParsed)}`);
  if (problems.length > 0) {
    console.log('%c  发现的问题：', WARN);
    problems.forEach((p) => console.log(`   · ${p}`));
  } else {
    console.log('%c  没发现问题：选项识别看起来是正常的', OK);
  }

  console.log('%c  ↓↓↓ 把下面这一行整行复制发我即可 ↓↓↓', STYLE);
  console.log(`[qa:options-json] ${JSON.stringify(result)}`);

  return result;
}

/**
 * 把诊断函数暴露到内容脚本的隔离世界。
 *
 * 名字用全大写加后缀，避免与页面自身的全局变量冲突，
 * 也便于一眼看出这是插件的调试入口。
 */
export function exposeDiagnostics(): void {
  (window as unknown as Record<string, unknown>).__QA_DEBUG_OPTIONS__ = diagnoseOptions;
  console.log(
    '%c[qa] 可选：在控制台执行 __QA_DEBUG_OPTIONS__() 诊断选项识别',
    'color:#4d6bfe',
  );
}
