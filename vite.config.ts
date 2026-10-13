import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { copyFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';

const root = __dirname;

/**
 * 把 manifest.json 和 icons/ 原样拷进 dist。
 * manifest 放在仓库根目录（方便查看/编辑），所以在这里手动拷贝，不依赖 publicDir。
 */
function copyExtensionShell() {
  return {
    name: 'copy-extension-shell',
    apply: 'build' as const,
    closeBundle() {
      const dist = resolve(root, 'dist');
      mkdirSync(dist, { recursive: true });
      copyFileSync(resolve(root, 'manifest.json'), join(dist, 'manifest.json'));

      const iconsSrc = resolve(root, 'icons');
      if (existsSync(iconsSrc)) {
        const iconsDist = join(dist, 'icons');
        mkdirSync(iconsDist, { recursive: true });
        for (const f of readdirSync(iconsSrc)) {
          copyFileSync(join(iconsSrc, f), join(iconsDist, f));
        }
      }
    },
  };
}

/**
 * 这里只构建"可以是 ESM"的部分：侧边栏页面与 service worker。
 *
 * 内容脚本**不在**这里构建 —— 它必须是自包含的普通脚本，
 * 由 scripts/build-content.mjs 用 esbuild 单独打包。
 * 原因见 src/entries/content.ts 的注释。
 */
export default defineConfig({
  plugins: [react(), copyExtensionShell()],
  publicDir: false,
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // 扩展调试需要能直接看懂产物，关掉压缩便于排查
    minify: false,
    target: 'chrome114',
    modulePreload: { polyfill: false },
    rollupOptions: {
      input: {
        sidepanel: resolve(root, 'src/sidepanel/index.html'),
        background: resolve(root, 'src/background/index.ts'),
        // 首次安装的权限说明页
        welcome: resolve(root, 'src/welcome/index.html'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: 'chunks/[name].js',
        assetFileNames: 'assets/[name][extname]',
      },
      preserveEntrySignatures: 'strict',
    },
  },
});
