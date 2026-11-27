Lab Note · 实验笔记
Windows x64 本地预览版 1.7.0-preview.1
软件作者：LumyQAQ    https://github.com/LumyQAQ
本包仅供本地试用。GitHub v1.0.0 为之前发布的版本。

在「数据与备份」可查看安装版本和 Windows x64 新版。升级前请下载完整备份，在旧程序目录双击 Stop-Lab-Note.cmd，随后将新 ZIP 解压到独立目录并启动。

启动
1. 在 Windows 10/11 的 Intel 或 AMD 64 位电脑上，右键 ZIP 选择“全部解压”。建议放在本地磁盘。
2. 打开解压后的 Lab-Note 文件夹，双击 Start-Lab-Note.cmd。包内含 Python，无需安装 Python、配置 PATH 或下载依赖。
3. 默认浏览器打开本机工作台。首次运行是空白数据库，可从“当前培养 → 新增容器”开始记录。
4. 浏览器关闭后后台服务继续运行。双击 Stop-Lab-Note.cmd 可停止服务。在移动、替换或删除程序文件夹之前，请先停止服务。

端口与命令（在解压目录打开 PowerShell）
  .\Start-Lab-Note.cmd --version
  .\Start-Lab-Note.cmd -h
  .\Start-Lab-Note.cmd --no-open --port auto
  .\Start-Lab-Note.cmd --port 8890
  .\Start-Lab-Note.cmd --status
  .\Start-Lab-Note.cmd --data-dir "D:\Lab Notes" --port 8890
  .\Stop-Lab-Note.cmd --data-dir "D:\Lab Notes"
默认先尝试 8875；被占用时会另选空闲端口，并打印实际网址。显式指定端口时，绑定失败会提示原因。重复启动同一数据目录会复用已有服务。若要更改运行中服务的端口，先停止，再用新端口启动。自定义数据目录时，查询和停止也使用同一 --data-dir。

也可用随包解释器直接运行：
  .\runtime\python.exe -X utf8 .\app\launch.py -h
  .\runtime\python.exe -X utf8 .\app\launch.py --port 8890
使用自己已安装的 Python 3.9 或更新版本时，python .\app\launch.py 接受相同参数。

存储与诊断
数据和 server.log 默认位于 %LOCALAPPDATA%\Lab Note。浏览器只访问 127.0.0.1。备份在工作台“数据与备份”中导出；按北京时间 22:00 自动留档需要服务运行。程序目录与个人记录分开。
遇到问题先执行 --status 查看路径，也可在 PowerShell 中读取本次启动日志：
  Get-Content "$env:LOCALAPPDATA\Lab Note\server.log" -Tail 20 -Encoding UTF8
旧 v1.0 在 Windows 上手动运行时，日志可能位于 %USERPROFILE%\Library\Application Support\Culture Notes Share\server.log。此包不会自动搬移旧目录。更换目录前请先备份。

Windows 现场自检
双击 Check-Lab-Note.cmd。它使用新的临时目录，验证北京时间、启动、端口复用、空白数据库、备份完整性和停止；完成后清理临时数据。

手机与平板：在电脑工作台打开「设备」，选择本机局域网或 Tailscale 地址并开启共享，然后按页面提示配对。关闭共享后可继续在电脑本机使用。
