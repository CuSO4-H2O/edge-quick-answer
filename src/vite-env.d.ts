/// <reference types="vite/client" />

/** Vite 的 `?inline` 后缀：把 CSS 作为字符串导入，不产出独立样式文件 */
declare module '*.css?inline' {
  const css: string;
  export default css;
}
