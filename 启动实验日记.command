#!/bin/zsh
cd -- "${0:A:h}/app"
if ! command -v python3 >/dev/null 2>&1; then
  print "找不到 Python 3。请安装 Python 3.9 或更高版本。"
  read -r "?按回车退出"
  exit 1
fi
python3 launch.py "$@"
result=$?
if (( result != 0 )); then
  read -r "?按回车退出"
fi
exit $result
