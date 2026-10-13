/**
 * Content script 的实现入口。
 *
 * 单独一个文件的原因：这个模块由 **esbuild** 打成一个完全自包含的 IIFE
 * （见 scripts/build-content.mjs），把 React、浮层、提取器全部内联进去。
 * Vite 那边只负责侧边栏与 service worker。
 *
 * 为什么不用 Vite 打内容脚本：Vite 是多入口 + 代码分割，产物里必然会留下
 * `import "./chunks/xxx.js"`，而 Chrome 不能把 ESM 当内容脚本加载 ——
 * 加载会失败且**不报错**，只是功能静默消失。
 */

import '../content/impl';
