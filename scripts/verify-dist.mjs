/**
 * 产物校验：构建完成后确认 dist/ 真的能作为扩展加载。
 *
 * 检查的都是"出错了不会报错、只会静默失效"的点，例如：
 *   - content.js 里混进 ESM 语法 → 内容脚本不加载，划词毫无反应
 *   - manifest 引用了不存在的文件 → 扩展加载失败
 *   - 面板样式没被内联 → Shadow DOM 里的浮层完全没样式
 *
 * 用法：node scripts/verify-dist.mjs
 */

import { existsSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = resolve(root, 'dist');

let failed = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'OK  ' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

const read = (rel) => {
  const p = resolve(dist, rel);
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8');
};

/** esbuild 会把非 ASCII 转成 \uXXXX，所以检查中文前先反转义 */
const unescapeJs = (code) =>
  code.replace(/\\u([0-9a-fA-F]{4})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

console.log('=== manifest 与引用完整性 ===');

const manifestRaw = read('manifest.json');
check('dist/manifest.json 存在', !!manifestRaw);
if (!manifestRaw) process.exit(1);

const manifest = JSON.parse(manifestRaw);
const referenced = [
  manifest.side_panel?.default_path,
  manifest.background?.service_worker,
  ...(manifest.content_scripts ?? []).flatMap((cs) => cs.js ?? []),
  ...Object.values(manifest.icons ?? {}),
  ...Object.values(manifest.action?.default_icon ?? {}),
].filter(Boolean);

const missing = referenced.filter((p) => !existsSync(resolve(dist, p)));
check(
  `manifest 引用的 ${referenced.length} 个文件都存在`,
  missing.length === 0,
  missing.join(', '),
);

for (const p of referenced) {
  const size = existsSync(resolve(dist, p)) ? readFileSync(resolve(dist, p)).length : 0;
  check(`  ${p}（${size} 字节）`, size > 0);
}

console.log('\n=== 内容脚本（必须自包含） ===');

const content = read('content.js');
check('dist/content.js 存在', !!content);

if (content) {
  const esm = /^\s*(?:import|export)\s/m.exec(content);
  check(
    '不包含 ESM 语法',
    !esm,
    esm ? `发现 "${esm[0].trim()}"，内容脚本会加载失败` : '',
  );

  const decoded = unescapeJs(content);
  check('React 已内联', /react/i.test(content));
  check('面板样式已内联（Shadow DOM 需要）', content.includes('qa-panel-root'));
  check('流式客户端已内联', content.includes('chat/completions'));
  check('「做题」按钮文案', decoded.includes('做题'));
  check('「问 AI」按钮文案', decoded.includes('问 AI'));
  check('引用说明文案', decoded.includes('引用网页正文'));
  check('答案行样式', content.includes('qa-answer-line'));
  // 本轮新增
  check('截图框选遮罩样式', content.includes('qa-shot-overlay'));
  check('截图请求协议', content.includes('qa:capture-region'));
  check('拖动把手样式', content.includes('qa-grip'));
  check('置顶按钮与持久化字段', content.includes('panelPinned'));
  // CSS 里是 "min-height: 0;"，别把空格写死
  check(
    '设置面板高度链修复（min-height）',
    /min-height:\s*0/.test(content),
    '没有它，设置面板的保存按钮会被顶出容器',
  );
  // 本轮新增
  check('选项标注模块', content.includes('qa-mark'));
  check(
    'div/role 模拟选项的识别',
    content.includes('option-item') || content.includes('radiogroup'),
    '只认 input[type=radio] 时，div 写的选项一个都标不上',
  );
  check('构建指纹（过期脚本自检）', content.includes('checkBuildFreshness'));
  check('自定义复选框样式', content.includes('appearance'));
  check('长消息折叠样式', content.includes('qa-bubble-collapsed'));
}

console.log('\n=== 构建指纹写入 ===');

const buildId = manifest.dshBuildId;
check('manifest 含 dshBuildId', typeof buildId === 'string' && buildId.length > 0, buildId ?? '');
check(
  'version_name 与之对应（edge://extensions 里可见）',
  manifest.version_name === buildId,
  manifest.version_name ?? '',
);

console.log('\n=== 权限与说明页 ===');

const hosts = manifest.host_permissions ?? [];
check(
  '声明了 <all_urls>（截图 API 需要，否则网页内截图会被拒）',
  hosts.includes('<all_urls>'),
  hosts.join(', '),
);
check(
  '仍然保留 API 域名（不能因为加了 all_urls 就漏掉）',
  hosts.some((h) => h.includes('api.deepseek.com')),
);
check('权限列表里没有多余的 tabs 之外的高危项', !(manifest.permissions ?? []).includes('webRequest'));

check('权限说明页存在', existsSync(resolve(dist, 'src/welcome/index.html')));
check('说明页脚本存在', existsSync(resolve(dist, 'welcome.js')));
check(
  '说明页被列为 web_accessible_resource',
  (manifest.web_accessible_resources ?? []).some((r) =>
    (r.resources ?? []).includes('src/welcome/index.html'),
  ),
);

console.log('\n=== 侧边栏与 service worker ===');

const sidepanel = read('sidepanel.js');
check('dist/sidepanel.js 存在', !!sidepanel);
if (sidepanel) {
  check(
    '共享样式以字符串形式内联（?inline 生效）',
    sidepanel.includes('qa-answer-line'),
  );
}

check('dist/background.js 存在', !!read('background.js'));

console.log(failed === 0 ? '\n全部通过' : `\n有 ${failed} 项未通过`);
process.exit(failed === 0 ? 0 : 1);
