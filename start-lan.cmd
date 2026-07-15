@echo off
setlocal EnableExtensions
chcp 65001 >nul
cd /d "%~dp0"
title 局域网聊天启动器

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 未找到 Node.js。请先安装 Node.js 22 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

if not exist "node_modules" (
  echo 正在准备首次运行环境，请稍候...
  call npm.cmd install
  if errorlevel 1 goto :failed
)

echo 正在构建局域网聊天...
call npm.cmd run build
if errorlevel 1 goto :failed

echo 正在启动后台常驻服务...
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\start-background.ps1" -Root "%CD%"
if errorlevel 1 goto :failed

echo.
echo 服务会在后台持续运行，关闭本窗口不会中断聊天和文件传输。
echo 同一局域网的设备请打开： http://192.168.5.170:3000
echo 日志保存在 data\server.log；需要停止时双击 stop-lan.cmd。
echo.
pause
exit /b 0

:failed
echo.
echo 启动失败，请检查上方提示或 data\server-error.log。
pause
exit /b 1
