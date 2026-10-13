# 隐私政策 · Privacy Policy

**划词答题助手（Edge 扩展）**
最后更新：2026-10-10

---

## 一、一句话概括

本扩展**不收集、不上传、不存储**你的任何个人信息。它只在你主动操作时读取当前网页内容，
并把你指定的内容直接发送到**你自己配置的** DeepSeek API。

---

## 二、扩展会处理哪些数据，为什么

| 数据 | 何时处理 | 用途 | 去向 |
|---|---|---|---|
| 当前网页的**选中文字** | 你划词并点「做题 / 问 AI」时 | 作为问题发给模型 | 仅发往 `api.deepseek.com` |
| 当前网页的**正文文本** | 同上，且你勾选了「引用网页正文」时 | 作为答题参考资料 | 仅发往 `api.deepseek.com` |
| 你**框选的屏幕区域截图** | 你主动点截图并框选时 | 让模型识别图中题目 | 仅发往 `api.deepseek.com` |
| 你输入的追问文字 | 你发送消息时 | 作为问题发给模型 | 仅发往 `api.deepseek.com` |
| **DeepSeek API Key** | 你在设置里填写时 | 用于调用 API 的身份凭据 | 保存在本机扩展存储，仅用于请求头 |

以上都**只在你的主动操作下发生**，扩展不会在后台自动读取任何页面。

## 三、明确不会做的事

- ❌ 不收集浏览历史、不记录你访问过哪些网站
- ❌ 不上传任何数据给本扩展的开发者
- ❌ 不与任何第三方共享数据（除你自行配置的 DeepSeek API 之外）
- ❌ 不含广告、统计埋点、遥测或用户画像
- ❌ 不含远程加载的代码（符合 Manifest V3 要求）
- ❌ 不会自动填写、提交任何表单或答案

## 四、数据存储

- **API Key 与设置**：保存在浏览器的扩展本地存储（`chrome.storage.local`）。
  它只存在于你的设备上，卸载扩展即删除。
- **对话记录**：仅保存在当前标签页的会话存储（`sessionStorage`），
  关闭标签页即清除；按题目分开存放，最多保留 6 组。
- **截图**：仅在你发送提问的这一次请求中使用，不会留存。

## 五、数据流向第三方

当你使用本扩展提问时，相关文字或图片会通过 HTTPS 发送到
**DeepSeek 开放平台**（`https://api.deepseek.com`），由其模型生成回答。
该服务由杭州深度求索人工智能基础技术研究有限公司提供，
其数据处理方式适用 DeepSeek 自己的隐私政策，本扩展无法控制。

如果你不希望任何内容离开本机，请不要使用本扩展的提问功能。

## 六、权限用途说明

| 权限 | 为什么需要 |
|---|---|
| `host_permissions: <all_urls>` | 划词浮标与题干读取需要在你访问的任意网页上运行；`chrome.tabs.captureVisibleTab` 截图接口要求此权限或 `activeTab` |
| `storage` | 在本机保存 API Key 与设置 |
| `contextMenus` | 提供「用 AI 解答选中内容」「截取区域问 AI」右键菜单 |
| `sidePanel` | 提供侧边栏对话界面 |
| `tabs` | 截图时定位当前标签页并取得可见区域 |
| `activeTab` / `scripting` | 在用户主动操作时与当前页面交互 |

本扩展不请求任何与功能无关的权限。

## 七、儿童隐私

本扩展不面向 13 岁以下儿童，也不会有意收集儿童信息。

## 八、政策变更

如本政策有实质变更，会更新本文件顶部的日期并在项目仓库中说明。

## 九、联系方式

如有隐私相关问题，请通过项目仓库的 Issues 提出：

`<在此填入你的仓库地址>`

---

## English Summary

This extension does **not** collect, store, or transmit any personal data to its developer.
It reads the current page only when you explicitly act (selecting text, clicking a button,
or framing a screenshot region), and sends only what you choose to **your own** configured
DeepSeek API endpoint (`https://api.deepseek.com`) to generate an answer.

- No analytics, no telemetry, no ads, no remote code.
- Your API key and settings stay in local extension storage on your device.
- Chat history is kept in the tab's session storage and cleared when the tab closes.
- The only third party involved is DeepSeek, which you configure yourself.

Contact: please open an issue in the project repository.
