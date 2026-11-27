# 将展示页发布到 GitHub Pages

仅将本目录作为公开仓库。正式工作台及其数据目录留在本地。展示页是静态 HTML、CSS 和 JavaScript，所有资源使用相对路径，适用于仓库的子路径。GitHub Pages 提供展示和下载；正式记录由读者自己启动的本机工作台保存。

1. 打开 [LumyQAQ/Lab-Note](https://github.com/LumyQAQ/Lab-Note) 仓库，按本目录的文件清单，把程序及展示页连同 `.gitignore` 和 `docs/.nojekyll` 提交到 `main` 分支。
2. 打开仓库的 **Settings → Pages**。在 **Build and deployment** 中选 **Deploy from a branch**，分支选 **main**，目录选 **/docs**，保存。
3. 部署完成后，在 Pages 设置中打开 **Visit site** 获得分享地址。分别检查 Windows 预览版和 macOS 正式版的下载、对应签名以及空白孔板的选孔交互。
4. 将真实 Pages 链接添加到仓库 **About → Website**。默认的 GitHub 项目站点地址下，展示页会自动显示返回该仓库的 GitHub 链接。

本地验证版本时间线时，在本目录执行 `python3 -m http.server 8900 --bind 127.0.0.1 --directory docs`，然后打开 <http://127.0.0.1:8900/>。更新应用后，执行 `python3 scripts/build_release.py` 重制下载包。新增程序文件时，先更新脚本中的打包清单，再验证解压后的启动入口并提交新版本。

[GitHub 官方发布源设置](https://docs.github.com/en/pages/getting-started-with-github-pages/configuring-a-publishing-source-for-your-github-pages-site)

重新发布时，按 [软件署名与发布校验](AUTHORS.md) 为确切版本的 ZIP 生成签名，再提交下载包、校验和和签名。

Windows 与 macOS 共用主分支的应用源码。Windows 预览包由 `packaging/build_windows_local.py` 使用校验过的 Python x64 嵌入包构建，以 GitHub Release 的预发布附件分发。两平台分别签署 ZIP，并在 Windows 附件发布后运行仓库的 Windows 自检工作流。

新增单位字段时，按物理量配置多个常用选项，并保留自定义输入。修改表单后运行 `node tests/test_unit_choices.cjs`，检查空白工作台各实验表单的单位选项。

发布前在仓库根目录运行 `python3 -B -m unittest discover -s tests` 和 `node --test tests/*.cjs`。安装 playwright-core 后，可设置 `LAB_NOTE_BROWSER_TEST=1`、`LAB_NOTE_BROWSER_EXECUTABLE` 和 `LAB_NOTE_APP_ROOT`，对解压后的下载包运行冻存库存浏览器测试。


## 每次发版同步更新 Pages 时间线

1. 在发布改动中同步编辑 `docs/releases.json`，按基础版本号从新到旧排序。每代只有一条记录，包括 `version`、发行日期 `date`、标题 `title` 和逐项列出公开版新增与修复的 `highlights`。后续同代的 Windows 预览包更新在原条目中。
2. 已发布的平台分别填写 `mac` 和 `win` 的 `tag`、`release_url`、`download_url`。说明链接指向该标签的 Release，下载链接指向已签名的 ZIP。尚未发布的平台填 `null`。核对附件大小和 SHA-256，并从下载入口打开对应签名和摘要。
3. 更新 `docs/index.html` 中两个平台的静态版本号和下载入口，并核对 `docs/verification.html` 的版本、文件名、签名和验签命令。保留此前各代的记录和下载链接。
4. 本地启动 HTTP 服务，打开 `/#changelog`，验证最新一代的说明和两个平台的下载，再展开早期版本。分别在 GitHub Releases API 正常及请求被阻断时刷新，核对在线合并和静态归档均能显示。
5. 推送至 `main` 后等待 GitHub Pages 部署成功，到正式安装页复核版本时间线、下载和验签入口。[线上版本演进](https://lumyqaq.github.io/Lab-Note/#changelog)
