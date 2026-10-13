/**
 * 权限说明页的交互。
 *
 * 只有一个按钮：关掉这个标签页。不引入 React —— 一个静态说明页不值得多一份运行时。
 */

const closeButton = document.getElementById('close');

closeButton?.addEventListener('click', () => {
  // 直接关标签页；如果这个页面不是脚本打开的（关不掉），就退回到打开设置页
  window.close();
  window.setTimeout(() => {
    void chrome.tabs.create({ url: 'edge://extensions' }).catch(() => {
      /* 打不开就算了，用户自己会去 */
    });
  }, 120);
});
