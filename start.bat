@echo off
chcp 65001 >nul
cd /d "%~dp0"

REM Key 从同目录的 key.txt 读取（只放一行 Key 即可）；也可在这里 set TMAP_KEY=...

REM 个人 Key 的 QPS 很低，请求间隔别低于 250ms，否则会报「每秒请求量已达上限」
set TMAP_INTERVAL=260

node server.js
pause
