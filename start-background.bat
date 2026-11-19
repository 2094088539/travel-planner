@echo off
chcp 65001 >nul
cd /d "%~dp0"

set "NODE=node"
where node >nul 2>&1
if errorlevel 1 set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "C:\Program Files\nodejs\node.exe" if errorlevel 1 set "NODE=%LOCALAPPDATA%\Programs\nodejs\node.exe"

%NODE% launch.js
if errorlevel 1 (
  echo.
  echo 启动失败。可能没装 Node.js。
  echo 不想装的话，直接双击 travel-planner.html 用单文件版，功能一样。
  echo.
  pause
  exit /b 1
)

timeout /t 2 >nul
start "" "http://127.0.0.1:8787/"
exit /b 0
