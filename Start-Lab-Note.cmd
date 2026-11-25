@echo off
setlocal DisableDelayedExpansion
chcp 65001 >nul
pushd "%~dp0" || exit /b 1
if exist "runtime\python.exe" goto bundled
py -3 -c "import sys; sys.exit(sys.version_info[:2] < (3, 9))" >nul 2>&1
if not errorlevel 1 goto launcher
python -c "import sys; sys.exit(sys.version_info[:2] < (3, 9))" >nul 2>&1
if not errorlevel 1 goto systempython
echo Python 3.9+ was not found. Extract the full Lab Note Windows x64 ZIP and try again.
set "result=1"
goto finish
:bundled
"runtime\python.exe" -X utf8 -B "app\launch.py" %*
set "result=%errorlevel%"
goto finish
:launcher
py -3 -X utf8 -B "app\launch.py" %*
set "result=%errorlevel%"
goto finish
:systempython
python -X utf8 -B "app\launch.py" %*
set "result=%errorlevel%"
:finish
popd
if not "%result%"=="0" if "%~1"=="" pause
exit /b %result%
