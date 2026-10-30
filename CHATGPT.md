# ChatGPT 聊天

手机首页的 **ChatGPT** 入口连接普通 ChatGPT 聊天。使用电脑 Chrome / Edge（120+）中选定的账号和标签页，支持侧栏列表、读取文字、文字续聊、停止生成。Codex 的项目和 thread 使用原来的入口。

一次安装：

1. 在项目目录执行 `node --import tsx scripts/prepare-chatgpt-extension.ts`。
2. 打开 `chrome://extensions` 或 `edge://extensions`，启用开发者模式，点击“加载已解压的扩展程序”，选择输出的 `.local/chatgpt-extension` 目录。
3. 在浏览器打开 `https://chatgpt.com/`，登录要使用的账号，打开侧栏。点击 **ChatGPT Mobile Bridge** 扩展，选择“连接当前 ChatGPT 页面”。建议使用专门的标签页，保持电脑、浏览器、连接器运行。
4. 刷新手机网页，打开首页 **ChatGPT**。可以加载侧栏更多聊天，或直接粘贴已有 ChatGPT 聊天链接。

浏览器重启后需重新选择标签页。更新扩展时重新运行第 1 步，在扩展管理页点击重新加载，然后重新连接页面。端口默认 `127.0.0.1:3342`，可在连接器配置中设置 `chatgptPort`，修改后需重启连接器并重新准备扩展。

扩展只操作选定页面的 DOM，不读取 Cookie、登录 Token 或调用 ChatGPT 私有接口。登录账号以浏览器为准，不继承 Codex 登录；请确认是你希望接入的账号。配对密钥保存在本机 `.local/` 中，请勿分享或提交该目录。聊天文字经过你自己的中继，手机连接 Token 持有者可以访问它。

页面正在生成或有草稿时不会切换聊天。发送有持久回执，超时或断线不会自动重发；手机提示待核实时，请先刷新聊天并核对电脑页面。页面脚本可能随 ChatGPT 更新而变化，无法识别时会报错。

首版只展示网页当前已载入的文字，不保证侧栏就是全部聊天，也不包括归档聊天、图片原件、工具卡片或未加载的历史。手机搜索筛选已经载入的侧栏条目，完整检索和多模态操作仍在 ChatGPT 原页面完成。

自动检查覆盖本地配对、重连、请求路由、重复发送保护、页面 DOM 样例和构建。真实账号的登录、侧栏、续聊和停止生成由使用者在手机和电脑上验收。

扩展后台按 [Chrome 官方 WebSocket 生命周期说明](https://developer.chrome.com/docs/extensions/how-to/web-platform/websockets)保持连接；页面脚本使用 [隔离的 content script](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts)。
