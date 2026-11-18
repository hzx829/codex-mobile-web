# Cowork 浏览器桥接

在 Windows 电脑上运行更新后的连接器，然后在 Chrome 或 Edge 加载本仓库的 Cowork 扩展。

1. 在仓库根目录运行 `node --import tsx scripts/prepare-cowork-extension.ts`。
2. 打开浏览器的扩展管理页。如已加载旧版 **Mobile Web Browser Bridge**，先停用它。启用开发者模式，选择“加载已解压的扩展程序”，并选中脚本输出的 `.local/cowork-extension` 目录。
3. 打开已登录的 Claude 网页，点击 **Cowork Bridge for Codex Mobile Web**，选择“连接当前页面”，并允许读取 `claude.ai`。
4. 保持标签页打开，在手机端切到 **Cowork**，刷新项目与会话。浏览器重启或所选标签页关闭后需要重新连接。

手机端可以查看 Claude 网页已载入的项目、会话和文字历史。扩展通过电脑本机的 WebSocket 与连接器配对。默认端口为 3342，可通过连接器配置 `coworkPort` 修改。改端口后请重启连接器，重新运行准备脚本，再重新加载扩展。
