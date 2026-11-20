# Lab Note · 实验笔记

软件作者：[LumyQAQ](https://github.com/LumyQAQ) · [官方仓库](https://github.com/LumyQAQ/Lab-Note)

个人使用的细胞培养与实验记录工作台。培养记录按容器和真实孔位组织，可以从某个孔查看培养日龄、操作日志、来源和关联实验。

<!-- repository-only:start -->
![首次启动的空白工作台](docs/assets/workbench.png)

[分享页源文件](docs/index.html) · [下载可运行的本地版 ZIP](docs/downloads/lab-note-v1.0.zip) · [发布 GitHub Pages](PUBLISHING.md)
<!-- repository-only:end -->

[软件署名及发布校验](AUTHORS.md)

## 本机运行

主机需要 macOS 和 Python 3.9 或更新版本。程序使用 Python 标准库和 SQLite。

1. 下载并解压本地版 ZIP，或下载整个仓库。
2. 双击根目录的 **启动实验日记.command**。也可以在仓库或解压目录中运行下面的命令。

   ```sh
   python3 app/launch.py
   ```

3. 打开 [本机工作台](http://127.0.0.1:8875/)。首次打开是空白记录，点击「当前培养 → 新增容器」开始填写。

分享版默认把数据保存在 `~/Library/Application Support/Culture Notes Share/`。服务仅监听本机地址 127.0.0.1，端口为 8875，可以与使用 8765 的桌面版本分别运行。

## 可以记录什么

| 场景 | 功能 |
| --- | --- |
| 每日培养 | 标记容器和孔位、记录 Day 0、培养基、计数、换液或半换液，核对后仍可编辑 |
| 传代与扩孔 | 保存来源到目标孔的对应关系，支持一份来源分到多个条件组 |
| 实验记录 | 流式、Western Blot / 蛋白提取与 BCA、PCR / qPCR、ELISA、发光检测及通用处理观察，可关联细胞来源和原始文件索引 |
| 配制与库存 | 登记药物和试剂的配制、分装与存储 |
| 历史追溯 | 查询追加操作与快照，撤销最近变更，导出日记、CSV 和数据库备份 |

服务按北京时间在 22:00 留存每日快照。Mac 需开机并运行服务；在「数据与备份」可手动下载完整备份。程序只分发空白表单，首页配图取自新建的空白工作台；通用版保留观察记录和来源关联，课题专用的方法及计算模板留在原工作台。

## 文件与验证

- `app/` 包含可运行程序和本地网页。
<!-- repository-only:start -->
- `docs/` 包含 GitHub Pages 展示页、空白孔板模板及下载包。双击 `docs/index.html` 可离线预览。
<!-- repository-only:end -->
- `tests/` 使用独立临时目录核验空白启动、历史初始状态、本机访问限制和网页资源。

```sh
python3 -m unittest discover -s tests -v
```

## 备份与恢复

在「数据与备份」下载 ZIP。解压后，可在解压目录运行 `shasum -a 256 -c original-file.sha256` 核对数据库。将 `culture.sqlite3` 放到单独的恢复目录，用 `python3 app/server.py --data-dir "恢复目录" --port 8890` 打开核验。
