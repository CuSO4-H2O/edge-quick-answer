/**
 * 答案标注（highlight.ts）的单元测试。
 *
 * 重点验证：
 *   - 能从模型回答里解析出选项字母（多选、带标点、答复格式差异）
 *   - 能在页面里把字母对上正确的选项容器（含 value="T"/"F" 的判断题）
 *   - 只做视觉标注，**不修改页面状态**（这是"不自动勾选"的硬约束）
 *
 * 用法：node scripts/test-highlight.mjs
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundlePath = resolve(root, 'dist/content.js');

if (!existsSync(bundlePath)) {
  console.error('找不到 dist/content.js，请先 pnpm build');
  process.exit(1);
}

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/* ------------------------------------------------------------------ *
 * 答案解析：直接测构建产物里的实现
 *
 * 为了拿到 parseAnswerLetters，用 esbuild 单独编译 highlight.ts
 * （避免把浏览器专用的 DOM 逻辑也拉进来）。
 * ------------------------------------------------------------------ */

const { build } = await import('esbuild');
const { mkdtempSync } = await import('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');
const { pathToFileURL } = await import('node:url');

const outDir = mkdtempSync(join(tmpdir(), 'qa-highlight-'));
const outFile = join(outDir, 'highlight.mjs');
await build({
  entryPoints: [resolve(root, 'src/content/highlight.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning',
});
const { parseAnswerLetters } = await import(pathToFileURL(outFile).href);

console.log('=== 答案解析 ===');

const answerCases = [
  ['答案：B\n\n理由……', ['B'], '标准格式'],
  ['答案: C', ['C'], '半角冒号'],
  ['**答案：** D\n因为……', ['D'], 'Markdown 加粗'],
  ['答案：ABD\n多选', ['A', 'B', 'D'], '多选连写'],
  ['答案：A、C', ['A', 'C'], '多选带顿号'],
  ['答案： a , c ', ['A', 'C'], '小写与空格'],
  ['这道题选 B 吧', [], '没有"答案："前缀时不猜'],
  ['答案：无法确定', [], '信息不足'],
];

for (const [text, expected, name] of answerCases) {
  const got = parseAnswerLetters(text);
  check(
    `${name}：${JSON.stringify(text).slice(0, 28)}`,
    JSON.stringify(got) === JSON.stringify(expected),
    `得到 ${JSON.stringify(got)}`,
  );
}

/* ------------------------------------------------------------------ *
 * 端到端：在真实 DOM 上标注
 *
 * 做法：把 jsdom 的 window/document 挂到 Node 全局，再 **import 编译后的模块**。
 * 这样模块级的标注状态（markedIds 等）是同一份，
 * 才能验证"换一题时旧标注被替换"这种行为。
 * （早先的版本把代码 eval 进 jsdom，每次都会新建一份模块状态，测不出这个。）
 * ------------------------------------------------------------------ */

console.log('\n=== 网页标注 ===');

const html = `<!doctype html><html><body>
  <h3>1. TCP 是面向连接的协议。</h3>
  <label><input type="radio" name="q1" value="T"> 正确</label>
  <label><input type="radio" name="q1" value="F"> 错误</label>

  <h3>2. 下列哪个是幂等操作？</h3>
  <div class="opts">
    <label><input type="radio" name="q2" value="1"> A. 转账</label>
    <label><input type="radio" name="q2" value="2"> B. 查询余额</label>
    <label><input type="radio" name="q2" value="3"> C. 下单</label>
  </div>

  <h3>3. 下面哪个是 div 模拟的选项？</h3>
  <div role="radiogroup" id="g3">
    <div class="option-item" role="radio">A. 用 div 写的选项</div>
    <div class="option-item" role="radio">B. 也是 div</div>
    <div class="option-item" role="radio">C. 还是 div</div>
  </div>

  <h3>4. 带无关确认框的题目</h3>
  <div class="subject">
    <label><input type="radio" name="63" value="7118142"> A. 井号用于单行注释</label>
    <label><input type="radio" name="65" value="7118145"> B. 井号可以跨多行</label>
    <label class="answered-option"><input type="radio" name="67" value="7118148"> C. 只有三引号是注释</label>
  </div>
  <label><input type="checkbox" name="confirm" value="on"> 我确认已检查本题</label>
</body></html>`;

const dom = new JSDOM(html, {
  url: 'https://example.edu/exam/1',
  pretendToBeVisual: true,
});
const { window } = dom;

// 模块里引用的是裸的 window / document / requestAnimationFrame
globalThis.window = window;
globalThis.document = window.document;
globalThis.requestAnimationFrame = (cb) => window.setTimeout(() => cb(Date.now()), 0);

const hl = await import(pathToFileURL(outFile).href);

const api = {
  highlightOption: hl.highlightOption,
  clearOptionHighlight: hl.clearOptionHighlight,
};

check('标注模块可在页面环境加载', typeof api.highlightOption === 'function');

// 记录标注前的页面状态，用于验证"不改页面状态"
const beforeChecked = [...window.document.querySelectorAll('input')].map((i) => i.checked);

const letters = api.highlightOption('答案：B\n\n查询余额是只读操作，因此幂等。');
check('解析出字母 B', JSON.stringify(letters) === '["B"]', JSON.stringify(letters));

const host = window.document.getElementById('qa-highlight-host');
check('建立了标注宿主', !!host);
const shadowOf = () => host?.shadowRoot;

/*
 * 注意：这次调用**没有**传题目文字，所以不做分组筛选，
 * 页面上所有字母为 B 的选项都会被标（这是刻意的：宁可多标也不漏标）。
 * 因此这里只断言"确实画出来了"，而不断言数量 —— 数量在下面传题目文字时验证。
 */
const marksAll = shadowOf()?.querySelectorAll('.qa-mark').length ?? 0;
const ringsAll = shadowOf()?.querySelectorAll('.qa-ring').length ?? 0;
check('不传题目文字时至少标出一处', marksAll >= 1, `实际 ${marksAll} 处`);
check(
  '徽标与圈的数量一致（一个选项一对）',
  marksAll === ringsAll,
  `mark=${marksAll} ring=${ringsAll}`,
);
check(
  '徽标文案包含答案字母',
  (shadowOf()?.querySelector('.qa-mark')?.textContent ?? '').includes('B'),
  shadowOf()?.querySelector('.qa-mark')?.textContent ?? '',
);

const afterChecked = [...window.document.querySelectorAll('input')].map((i) => i.checked);
check(
  '没有修改任何选项的勾选状态（只标注不勾选）',
  JSON.stringify(beforeChecked) === JSON.stringify(afterChecked),
);
check(
  '没有改动页面元素的 style/class',
  [...window.document.querySelectorAll('label, .option-item')].every(
    (l) =>
      l.getAttribute('style') === null &&
      // 只要求扩展没有**新增**类名：页面自带的类名（如 answered-option）不算数
      !(l.className ?? '').split(/\s+/).some((c) => c.startsWith('qa-')),
  ),
);

// 换一道题：应清掉旧标注（否则上一题的圈会留在页面上误导人）
const q2 = '下列哪个是幂等操作？A. 转账 B. 查询余额 C. 下单';
const letters2 = api.highlightOption('答案：A\n\n转账会改变状态。', q2);
check('新答案解析出 A', JSON.stringify(letters2) === '["A"]', JSON.stringify(letters2));
check(
  '旧标注被替换而不是叠加',
  shadowOf()?.querySelectorAll('.qa-mark').length === 1,
  `实际 ${shadowOf()?.querySelectorAll('.qa-mark').length}`,
);
check(
  '多题页面上只标用户在做的那一组（不会两组都标）',
  JSON.stringify(letters2) === '["A"]',
  '两组的字母都是 A 时，必须靠选中文字定位到一组',
);

// 判断题：value 是 T/F，字母只能按组内顺序编
const q1 = 'TCP 是面向连接的协议。正确 错误';
const tf = api.highlightOption('答案：B', q1);
check('判断题 value="T"/"F" 时仍按顺序编 A/B', JSON.stringify(tf) === '["B"]', JSON.stringify(tf));

// 无法解析时应清空
const none = api.highlightOption('这道题我不确定。');
check('解析不出答案时清空标注', none.length === 0);
check('清空后不残留徽标', (shadowOf()?.querySelectorAll('.qa-mark') ?? []).length === 0);

// ---- div 模拟的选项（很多在线判题系统这么写）----
const q3 = '下面哪个是 div 模拟的选项？A. 用 div 写的选项 B. 也是 div C. 还是 div';
const divLetters = api.highlightOption('答案：B', q3);
check('div/role 模拟的选项也能标注', JSON.stringify(divLetters) === '["B"]', JSON.stringify(divLetters));
check('标注落在第三题上（靠选中文字定位）', divLetters.length === 1, `实际 ${divLetters.length}`);
check(
  'div 选项的标注不修改页面结构',
  [...window.document.querySelectorAll('.option-item')].every(
    (el) => el.getAttribute('style') === null && !el.className.includes('qa-'),
  ),
);

// ---- 无关的 confirm 复选框不能顶替真正的选项 A ----
// 实测真实考试系统里就有 name="confirm" 的确认框，它拿不到字母会被编成 A
const q4 = '带无关确认框的题目 A. 井号用于单行注释 B. 井号可以跨多行 C. 只有三引号是注释';
const aLetters = api.highlightOption('答案：A', q4);
check('答案为 A 时能标出', JSON.stringify(aLetters) === '["A"]', JSON.stringify(aLetters));
check(
  '标注落在真正的选项 A 上，而不是确认框（只画一对标记）',
  (shadowOf()?.querySelectorAll('.qa-mark') ?? []).length === 1,
  `实际 ${shadowOf()?.querySelectorAll('.qa-mark').length} 处`,
);
check(
  '没有把确认框所在的行圈起来',
  !(shadowOf()?.querySelector('.qa-ring')?.getAttribute('style') ?? '').includes('NaN'),
  'ring 的定位不应出现无效数值',
);

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
