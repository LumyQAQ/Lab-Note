#!/bin/zsh
set -u
python3 -B "${0:A:h}/app/mac_update.py" "$@"
result=$?
if [[ -t 0 ]]; then
  read -r "?按回车退出"
fi
exit $result
