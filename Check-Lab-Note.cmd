@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
"runtime\python.exe" -X utf8 -B "tests\check_local_windows.py"
set "result=%errorlevel%"
popd
if "%~1"=="" pause
exit /b %result%
