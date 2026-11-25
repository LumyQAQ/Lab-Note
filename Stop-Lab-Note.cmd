@echo off
call "%~dp0Start-Lab-Note.cmd" --stop %*
exit /b %errorlevel%
