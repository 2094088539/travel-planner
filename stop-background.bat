@echo off
chcp 65001 >nul
cd /d "%~dp0"

if not exist ".server.pid" (
  echo 后台服务没有在运行。
  timeout /t 3 >nul
  exit /b
)

set /p PID=<".server.pid"
taskkill /PID %PID% /F >nul 2>&1
if exist ".server.pid" del ".server.pid"
echo 已停止后台服务（PID %PID%）。
timeout /t 2 >nul
