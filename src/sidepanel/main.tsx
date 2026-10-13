import { createRoot } from 'react-dom/client';
import { App } from './App';
import { injectSharedStyles } from '../shared/injectStyles';

// 侧边栏自己就是个扩展页面，把共享样式注入 document 即可
injectSharedStyles(document);

const container = document.getElementById('root');
if (!container) throw new Error('找不到 #root 挂载点');

// 刻意不使用 StrictMode：它会在开发模式下双调用 effect，
// 导致与 background 的 port 连接建立两次、可能重复触发同一次提问。
createRoot(container).render(<App />);
