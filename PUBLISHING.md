# 将展示页发布到 GitHub Pages

仅将本目录作为公开仓库。正式工作台及其数据目录留在本地。展示页是静态 HTML、CSS 和 JavaScript，所有资源使用相对路径，适用于仓库的子路径。GitHub Pages 提供展示和下载；正式记录由读者自己启动的本机工作台保存。

1. 打开 [LumyQAQ/Lab-Note](https://github.com/LumyQAQ/Lab-Note) 仓库，按本目录的文件清单，把程序及展示页连同 `.gitignore` 和 `docs/.nojekyll` 提交到 `main` 分支。
2. 打开仓库的 **Settings → Pages**。在 **Build and deployment** 中选 **Deploy from a branch**，分支选 **main**，目录选 **/docs**，保存。
3. 部署完成后，在 Pages 设置中打开 **Visit site** 获得分享地址。分别检查 Windows 预览版和 macOS 正式版的下载、对应签名以及空白孔板的选孔交互。
4. 将真实 Pages 链接添加到仓库 **About → Website**。默认的 GitHub 项目站点地址下，展示页会自动显示返回该仓库的 GitHub 链接。

本地预览可直接打开 `docs/index.html`，或在本目录执行 `python3 -m http.server 8900 --bind 127.0.0.1 --directory docs`，然后打开 <http://127.0.0.1:8900/>。更新应用后，执行 `python3 scripts/build_release.py` 重制下载包。新增程序文件时，先更新脚本中的打包清单，再验证解压后的启动入口并提交新版本。

[GitHub 官方发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

重新发布时，按 [软件署名与发布校验](AUTHORS.md) 为确切版本的 ZIP 生成签名，再提交下载包、校验和和签名。

Windows 与 macOS 共用主分支的应用源码。Windows 预览包由 `packaging/build_windows_local.py` 使用校验过的 Python x64 嵌入包构建，以 GitHub Release 的预发布附件分发。两平台分别签署 ZIP，并在 Windows 附件发布后运行仓库的 Windows 自检工作流。
