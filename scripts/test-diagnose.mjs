/**
 * 选项识别诊断工具（diagnose.ts）的测试。
 *
 * 这个工具是给"标注不生效"这类问题用的：把页面里选项识别的真实情况
 * 打印/复制出来，避免靠猜页面结构。所以测试要覆盖：
 *   - 正常结构能识别
 *   - div 模拟的选项能识别
 *   - **完全认不出的写法**能明确指出问题（这是它最重要的用途）
 *
 * 用法：node scripts/test-diagnose.mjs     前置：pnpm build
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const { build } = await import('esbuild');
const outDir = mkdtempSync(join(tmpdir(), 'qa-diagnose-'));
const outFile = join(outDir, 'diagnose.mjs');

await build({
  entryPoints: [resolve(root, 'src/content/diagnose.ts')],
  outfile: outFile,
  bundle: true,
  format: 'esm',
  platform: 'node',
  logLevel: 'warning',
});

/** 在给定 HTML 上跑诊断 */
async function diagnose(html) {
  const dom = new JSDOM(html, { url: 'https://example.edu/exam/1', pretendToBeVisual: true });
  globalThis.window = dom.window;
  globalThis.document = dom.window.document;
  // 代码里用到 Node.TEXT_NODE；浏览器里是全局的，Node 环境下要显式挂上
  globalThis.Node = dom.window.Node;
  globalThis.console = console;

  // 每次换新 DOM 就重新导入模块（模块内无状态，但 window 引用要更新）
  const mod = await import(`${pathToFileURL(outFile).href}?v=${Math.random()}`);
  return mod.diagnoseOptions();
}

// 让 console.table 不刷屏
const realTable = console.table;
console.table = () => {};
console.log('%c', ''); // no-op

console.log('=== 场景一：标准 label + radio ===');

{
  const r = await diagnose(`<!doctype html><html><body>
    <p>1. 下列哪个是幂等操作？</p>
    <label><input type="radio" name="q1" value="A"> A. 转账</label>
    <label><input type="radio" name="q1" value="B"> B. 查询余额</label>
    <label><input type="radio" name="q1" value="C"> C. 下单</label>
  </body></html>`);

  check('识别到 3 个原生 input', r.nativeInputs === 3, `实际 ${r.nativeInputs}`);
  check('解析出示例答案字母 B', r.answerParsed.join('') === 'B', JSON.stringify(r.answerParsed));
  check('三个选项都从文本取到字母', r.options.every((o) => o.letterSource === '文本里的字母'));
  check('没有报告问题', r.problems.length === 0, r.problems.join(' | '));
}

console.log('\n=== 场景二：value 是 T/F 的判断题 ===');

{
  const r = await diagnose(`<!doctype html><html><body>
    <p>2. TCP 是面向连接的协议。</p>
    <label><input type="radio" name="q2" value="T"> 正确</label>
    <label><input type="radio" name="q2" value="F"> 错误</label>
  </body></html>`);

  check('两个选项按组内顺序编 A/B', r.options.map((o) => o.letter).join('') === 'AB', JSON.stringify(r.options.map((o) => o.letter)));
  check(
    '报告了"字母来自组内顺序"这一点',
    r.options.every((o) => o.letterSource === '组内顺序'),
  );
  check('提示可能错位（组内顺序的来源）', r.problems.some((p) => p.includes('组内顺序')));
}

console.log('\n=== 场景三：div 模拟的选项 ===');

{
  const r = await diagnose(`<!doctype html><html><body>
    <p>3. 下面哪个是 div 模拟的？</p>
    <div role="radiogroup">
      <div class="option-item" role="radio">A. 用 div 写的选项</div>
      <div class="option-item" role="radio">B. 也是 div</div>
    </div>
  </body></html>`);

  check('识别到 role/div 候选', r.roleOptions >= 2, `实际 ${r.roleOptions}`);
  check(
    '从文本取出字母 A/B',
    r.options.map((o) => o.letter).join('') === 'AB',
    JSON.stringify(r.options.map((o) => o.letter)),
  );
}

console.log('\n=== 场景四：完全认不出的写法（诊断工具最重要的用途）===');

{
  // 纯 div + click 事件，没有任何 role / class 线索
  const r = await diagnose(`<!doctype html><html><body>
    <p>4. 这种写法插件认不出来</p>
    <div><div onclick="pick(1)">A. 选项一</div><div onclick="pick(2)">B. 选项二</div></div>
  </body></html>`);

  check(
    '明确指出"没找到任何选项控件"',
    r.problems.some((p) => p.includes('没有找到任何 radio/checkbox')),
    r.problems.join(' | '),
  );
  check('仍然报告了 input 数量为 0', r.nativeInputs === 0);
}

console.log('\n=== 场景五：多个选项共用一个 label ===');

{
  const r = await diagnose(`<!doctype html><html><body>
    <p>5. 多个选项塞在同一个 label 里</p>
    <label style="display:block">
      <div><input type="radio" name="q5" value="1"> A. 选项一</div>
      <div><input type="radio" name="q5" value="2"> B. 选项二</div>
    </label>
  </body></html>`);

  check('识别到 2 个选项', r.options.length === 2, `实际 ${r.options.length}`);
  // 关键：容器必须落在"选项那一行"，不能是外层大 label，也不能缩成 input 自身
  check(
    '容器取到选项所在的那一行（不是外层 label、也不是 input 本身）',
    r.options.every((o) => o.box.includes('<div>')),
    r.options.map((o) => o.box).join(' | '),
  );
  check(
    '字母来自组内顺序（value 是 1/2 不是字母）',
    r.options.map((o) => o.letter).join('') === 'AB',
    JSON.stringify(r.options.map((o) => o.letter)),
  );
}

console.log('\n=== 场景六：真实考试系统结构（含无关的 confirm 复选框）===');

{
  // 取自用户实际页面的诊断数据：4 个选项 + 1 个 name="confirm" 的确认框。
  // 确认框拿不到字母，会被"按组内顺序"编成 A，与真正的选项 A 撞车。
  const r = await diagnose(`<!doctype html><html><body>
    <div class="subject">
      <p>1. 关于 Python 中的注释方式，以下哪项正确描述了井号与三引号注释的主要区别？</p>
      <label><input type="radio" name="63" value="7118142"> A. 井号用于单行注释，三引号可用于多行注释。</label>
      <label><input type="radio" name="65" value="7118145"> B. 井号注释可以跨多行使用，而三引号只能用于单行说明。</label>
      <label><input type="radio" name="67" value="7118148"> C. 只有三引号能被解释器识别为注释，井号仅用于标记代码。</label>
      <label class="answered-option"><input type="radio" name="69" value="7118151"> D. 井号和三引号都可以自由用于任意位置，功能完全相同。</label>
    </div>
    <label><input type="checkbox" name="confirm" value="on"> 我确认已检查本题</label>
  </body></html>`);

  check('识别到 5 个原生 input', r.nativeInputs === 5, `实际 ${r.nativeInputs}`);
  check(
    '确认框被挤掉，只留 4 个真选项',
    r.options.length === 4,
    `实际 ${r.options.length}: ${r.options.map((o) => o.letter + '/' + o.inputName).join(', ')}`,
  );
  check('淘汰了 1 个不可信候选', r.filteredOut === 1, `实际 ${r.filteredOut}`);
  check(
    '四个选项字母正好是 A/B/C/D',
    r.options.map((o) => o.letter).join('') === 'ABCD',
    JSON.stringify(r.options.map((o) => o.letter)),
  );
  check(
    '字母 A 落在真正的选项上（不是 confirm 框）',
    r.options[0].inputName === '63',
    `实际 name=${r.options[0].inputName}`,
  );
  check(
    '不再有多余的"按组内顺序编号"告警',
    !r.problems.some((p) => p.includes('组内顺序')),
    r.problems.join(' | '),
  );
  check('示例答案 B 可解析', r.answerParsed.join('') === 'B');
}

console.table = realTable;
console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
