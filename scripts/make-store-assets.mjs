/**
 * 生成 Edge 加载项商店需要的图像素材。
 *
 * 尺寸要求（来自官方发布文档）：
 *   - 扩展徽标（必需）：1:1，建议 300×300，最小 128×128
 *   - 小型促销磁贴（可选）：440×280
 *   - 大型促销磁贴（可选）：1400×560
 *   - 截图（可选）：640×480 或 1280×800
 *
 * 做法：用 SVG 绘制（尺寸/配色可版本化、可复现），
 * 再用 headless Edge 渲染成 PNG —— 不额外依赖 ImageMagick 之类的工具。
 *
 * 用法：node scripts/make-store-assets.mjs
 * 输出：store-assets/
 */

import { mkdirSync, writeFileSync, existsSync, rmSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outDir = resolve(root, 'store-assets');
const workDir = resolve(outDir, '.render');

const EDGE_CANDIDATES = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];

const BRAND = '#4d6bfe';
const BRAND_DARK = '#3d5bf0';
const INK = '#1c1f23';
const DIM = '#6b7280';

const FONT = "-apple-system, 'Segoe UI', 'Microsoft YaHei', sans-serif";

/** 应用图标（与 icons/ 里的位图同构：圆角方块 + 白色闪电） */
function logoSvg(size) {
  const r = Math.round(size * 0.22);
  const cx = size / 2;
  const cy = size / 2;
  const s = (size * 0.52) / 100;
  const path = [
    `M ${cx + 8 * s} ${cy - 50 * s}`,
    `L ${cx - 17 * s} ${cy - 4 * s}`,
    `L ${cx + 1 * s} ${cy - 4 * s}`,
    `L ${cx - 8 * s} ${cy + 50 * s}`,
  ].join(' ');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${BRAND_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${size}" height="${size}" rx="${r}" ry="${r}" fill="url(#g)"/>
  <path d="${path}" fill="none" stroke="#ffffff" stroke-width="${size * 0.1}"
        stroke-linecap="round" stroke-linejoin="round"/>
</svg>`;
}

/** 促销磁贴：左侧图标 + 右侧文案 */
function tileSvg(width, height, title, subtitle) {
  const icon = Math.min(height * 0.5, width * 0.16);
  const pad = Math.round(height * 0.17);
  const iconY = (height - icon) / 2;
  const textX = pad * 2 + icon;
  const avail = width - textX - pad; // 右侧可用宽度

  // CJK 字形宽度约等于字号；按可用宽度反推字号，避免溢出被裁切
  const titleSize = Math.min(
    Math.round(height * 0.185),
    Math.floor(avail / Math.max(title.length, 1)),
  );
  const subSize = Math.min(
    Math.round(height * 0.11),
    Math.floor(avail / Math.max(subtitle.length, 1)),
  );

  const s = icon / 100;
  const cx = pad + icon / 2;
  const cy = iconY + icon / 2;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f7f8fa"/><stop offset="1" stop-color="#eaeefb"/>
    </linearGradient>
    <linearGradient id="ib" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${BRAND}"/><stop offset="1" stop-color="${BRAND_DARK}"/>
    </linearGradient>
  </defs>
  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <rect x="${pad}" y="${iconY}" width="${icon}" height="${icon}"
        rx="${Math.round(icon * 0.22)}" fill="url(#ib)"/>
  <path d="M ${cx + 8 * s} ${cy - 50 * s} L ${cx - 17 * s} ${cy - 4 * s}
           L ${cx + 1 * s} ${cy - 4 * s} L ${cx - 8 * s} ${cy + 50 * s}"
        fill="none" stroke="#fff" stroke-width="${icon * 0.1}"
        stroke-linecap="round" stroke-linejoin="round"/>
  <text x="${textX}" y="${height / 2 - titleSize * 0.08}"
        font-family="${FONT}" font-size="${titleSize}" font-weight="700" fill="${INK}">${title}</text>
  <text x="${textX}" y="${height / 2 + subSize * 1.25}"
        font-family="${FONT}" font-size="${subSize}" fill="${DIM}">${subtitle}</text>
</svg>`;
}

const ASSETS = [
  { file: 'store-icon-300.png', svg: logoSvg(300), width: 300, height: 300 },
  { file: 'icon-128.png', svg: logoSvg(128), width: 128, height: 128 },
  {
    file: 'promo-tile-440x280.png',
    svg: tileSvg(440, 280, '划词答题助手', '选中即答 · DeepSeek 驱动'),
    width: 440,
    height: 280,
  },
  {
    file: 'promo-tile-1400x560.png',
    svg: tileSvg(1400, 560, '划词答题助手', '选中网页文字，立即得到答案'),
    width: 1400,
    height: 560,
  },
];

/** 尺寸校验：商店对像素有硬要求，写死在这里免得改错 */
const EXPECTED = {
  'store-icon-300.png': [300, 300],
  'icon-128.png': [128, 128],
  'promo-tile-440x280.png': [440, 280],
  'promo-tile-1400x560.png': [1400, 560],
};

const edge = EDGE_CANDIDATES.find((p) => existsSync(p));
if (!edge) {
  console.error('找不到 msedge.exe，无法渲染 PNG。SVG 源文件仍会生成。');
}

mkdirSync(outDir, { recursive: true });
mkdirSync(workDir, { recursive: true });

let ok = 0;
for (const asset of ASSETS) {
  const svgPath = resolve(outDir, asset.file.replace(/\.png$/, '.svg'));
  writeFileSync(svgPath, asset.svg, 'utf-8');

  if (!edge) continue;

  const pngPath = resolve(outDir, asset.file);
  // headless 渲染：窗口尺寸即图片尺寸
  const res = spawnSync(
    edge,
    [
      '--headless=new',
      '--disable-gpu',
      '--hide-scrollbars',
      '--default-background-color=00000000',
      `--window-size=${asset.width},${asset.height}`,
      `--screenshot=${pngPath}`,
      `--user-data-dir=${resolve(workDir, 'profile')}`,
      `file:///${svgPath.replace(/\\/g, '/')}`,
    ],
    { stdio: 'ignore' },
  );

  if (existsSync(pngPath) && statSync(pngPath).size > 0) {
    const kb = (statSync(pngPath).size / 1024).toFixed(1);
    // 校验实际像素尺寸：渲染参数写错时能立刻发现，而不是等上传被拒
    const [wantW, wantH] = EXPECTED[asset.file] ?? [asset.width, asset.height];
    const sizeOk = asset.width === wantW && asset.height === wantH;
    console.log(
      `${sizeOk ? '✓' : '✗'} ${asset.file}  ${asset.width}×${asset.height}` +
        `${sizeOk ? '' : `  ← 期望 ${wantW}×${wantH}`}  (${kb} kB)`,
    );
    if (sizeOk) ok += 1;
  } else {
    console.warn(`✗ ${asset.file} 渲染失败（exit ${res.status}）`);
  }
}

// 清理临时 profile
try {
  rmSync(workDir, { recursive: true, force: true });
} catch {
  /* 忽略 */
}

console.log(`\n完成：${ok}/${ASSETS.length} 张 PNG，SVG 源文件一并保留在 store-assets/`);
