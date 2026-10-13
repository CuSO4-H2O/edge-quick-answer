/**
 * 提取器的离线自测（不依赖浏览器、不依赖 API）。
 *
 * 目的：DOM 提取是本项目最容易糊的一环，必须能脱离浏览器反复验证。
 * 运行：
 *   npx esbuild scripts/test-extract.ts --bundle --platform=node --format=esm --outfile=.tmp/test-extract.mjs
 *   node .tmp/test-extract.mjs
 * 注意：extract.ts 自身不引用任何 chrome.* API，所以能在 Node 里直接跑。
 */

// 注意：Node 原生类型剥离要求显式写 .ts 扩展名
import { cleanExtractedText, extractPageContext } from '../src/content/extract.ts';

interface Fixture {
  name: string;
  html: string;
  /** 必须出现的关键片段 */
  mustInclude: string[];
  /** 不应出现的噪声 */
  mustExclude?: string[];
}

const fixtures: Fixture[] = [
  {
    name: '典型题库页（题干 + 四个选项）',
    html: `
      <html><body>
        <nav><a href="/">首页</a><a href="/a">课程</a><a href="/b">题库</a><a href="/c">我的</a></nav>
        <div class="wrapper">
          <div class="question-card">
            <h3>1. 下列关于 HTTP/3 的说法，正确的是？</h3>
            <ul class="options">
              <li>A. HTTP/3 基于 TCP 协议</li>
              <li>B. HTTP/3 使用 QUIC 作为传输层协议</li>
              <li>C. HTTP/3 与 HTTP/2 完全相同</li>
              <li>D. HTTP/3 不支持多路复用</li>
            </ul>
          </div>
        </div>
        <footer>版权所有 2026</footer>
        <script>var leak = "SECRET_SCRIPT_TEXT";</script>
      </body></html>`,
    mustInclude: [
      'HTTP/3',
      '下列关于 HTTP/3 的说法，正确的是？',
      'A. HTTP/3 基于 TCP 协议',
      'B. HTTP/3 使用 QUIC 作为传输层协议',
      'D. HTTP/3 不支持多路复用',
    ],
    mustExclude: ['SECRET_SCRIPT_TEXT', '版权所有'],
  },
  {
    name: 'SPA 单选按钮式选项',
    html: `
      <html><body>
        <main>
          <h1>第 2 题：以下哪种数据结构最适合实现 LRU 缓存？</h1>
          <div role="radiogroup">
            <label role="radio"><input type="radio" name="q2" value="A">A. 数组</label>
            <label role="radio"><input type="radio" name="q2" value="B">B. 哈希表 + 双向链表</label>
            <label role="radio"><input type="radio" name="q2" value="C">C. 二叉搜索树</label>
            <label role="radio"><input type="radio" name="q2" value="D">D. 栈</label>
          </div>
        </main>
      </body></html>`,
    mustInclude: ['LRU', 'A. 数组', 'B. 哈希表 + 双向链表', 'D. 栈'],
  },
  {
    name: '判断题（无选项列表）',
    html: `
      <html><body><article>
        <p>第 3 题：在 TCP 三次握手中，第三次握手可以携带数据。</p>
        <p>请判断上述说法是否正确。</p>
      </article></body></html>`,
    mustInclude: ['TCP 三次握手', '请判断上述说法是否正确'],
  },
  {
    name: 'label 包裹 input 的选项（很多在线判题系统这样写）',
    html: `
      <html><body><div class="exam">
        <p>5、下面哪个不是 HTTP 状态码？</p>
        <label><input type="radio" name="q5" value="A"> 200</label>
        <label><input type="radio" name="q5" value="B"> 404</label>
        <label><input type="radio" name="q5" value="C"> 999</label>
        <label><input type="radio" name="q5" value="D"> 302</label>
      </div></body></html>`,
    // 关键：字母必须被补出来，否则模型无法回答"选 B"
    mustInclude: ['不是 HTTP 状态码', 'A. 200', 'B. 404', 'C. 999', 'D. 302'],
  },
  {
    name: '连续多题（两组 radio，需分组编号）',
    html: `
      <html><body><div class="exam">
        <p>6、TCP 是面向连接的协议。</p>
        <label><input type="radio" name="q6" value="T"> 正确</label>
        <label><input type="radio" name="q6" value="F"> 错误</label>
        <p>7、HTTP 默认端口是 80。</p>
        <label><input type="radio" name="q7" value="T"> 正确</label>
        <label><input type="radio" name="q7" value="F"> 错误</label>
      </div></body></html>`,
    // 关键：value="T"/"F" 是判断题真值、不是选项字母，必须按顺序编成 A/B；
    // 这里曾经把「错误」标成 F（采信了 value），是个已修复的真实 bug。
    // 首题不加表头，故断言从「第 2 题」开始。
    mustInclude: ['第 2 题', 'A. 正确', 'B. 错误'],
    mustExclude: ['T. 正确', 'F. 错误'],
  },
  {
    name: '正文里夹着大量导航链接',
    html: `
      <html><body>
        <div class="sidebar">
          <a href="/1">链接一</a><a href="/2">链接二</a><a href="/3">链接三</a>
          <a href="/4">链接四</a><a href="/5">链接五</a>
        </div>
        <main>
          <p>第 4 题：以下哪个是幂等操作？</p>
          <p>A. 转账　B. 查询余额　C. 下单　D. 扣库存</p>
        </main>
      </body></html>`,
    mustInclude: ['幂等操作'],
    mustExclude: ['链接一'],
  },
];

/** 用 jsdom 构造真实 DOM，让 extract 在 Node 里跑得起来 */
async function makeDocument(html: string): Promise<Document> {
  const { JSDOM } = await import('jsdom');
  return new JSDOM(html).window.document as unknown as Document;
}

async function main(): Promise<void> {
  let pass = 0;
  let fail = 0;

  for (const fixture of fixtures) {
    let doc: Document;
    try {
      doc = await makeDocument(fixture.html);
    } catch (err) {
      console.error(`SKIP ${fixture.name}: ${(err as Error).message}`);
      return;
    }

    const out = extractPageContext(doc, { maxChars: 2000, maxLines: 60 });

    const missing = fixture.mustInclude.filter((s) => !out.includes(s));
    const leaked = (fixture.mustExclude ?? []).filter((s) => out.includes(s));

    if (missing.length === 0 && leaked.length === 0) {
      pass += 1;
      console.log(`PASS  ${fixture.name}  (${out.length} 字符)`);
    } else {
      fail += 1;
      console.log(`FAIL  ${fixture.name}`);
      if (missing.length) console.log(`      缺失: ${missing.join(' | ')}`);
      if (leaked.length) console.log(`      泄漏噪声: ${leaked.join(' | ')}`);
    }
    console.log(`      ---- 提取结果 ----\n${out.split('\n').map((l) => `      ${l}`).join('\n')}`);
  }

  const cleaned = cleanExtractedText(
      [
        '执行后，b的值是（  ）',
        '单选题（2分）',
        'A',
        '.',
        '100',
        'B',
        '.',
        '20',
        '',
        '',
        '单选题（2分）', // 重复行应去掉
      ].join('\n'),
    );
  console.log(`\ncleanExtractedText 清洗效果:\n${cleaned.split('\n').map((l) => `      ${l}`).join('\n')}`);

  const cleanChecks: [string, boolean][] = [
    ['标点并回上一行（A. 100）', cleaned.includes('A. 100')],
    ['第二个选项也正确（B. 20）', cleaned.includes('B. 20')],
    ['不再有单独成行的标点', !cleaned.split('\n').some((l) => l.trim() === '.')],
    ['重复行被去掉', cleaned.split('单选题（2分）').length === 2],
  ];
  for (const [name, ok] of cleanChecks) {
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
    if (ok) pass += 1;
    else fail += 1;
  }

  // 代码块必须保留原始排版
  const codeKept = cleanExtractedText(['```', 'def f(x):', '    return x  # 缩进保留', '```'].join('\n'));
  const codeOk = codeKept.includes('    return x');
  console.log(`${codeOk ? 'PASS' : 'FAIL'}  代码块缩进被保留`);
  if (codeOk) pass += 1;
  else fail += 1;

  console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
  process.exitCode = fail === 0 ? 0 : 1;
}

void main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
