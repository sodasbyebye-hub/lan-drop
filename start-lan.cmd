@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
title 局域网快传

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo [错误] 没有找到 Node.js，请先安装 Node.js 22 或更高版本。
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

echo 正在构建局域网快传...
call npm.cmd run build
if errorlevel 1 goto :failed

echo.
call npm.cmd start
exit /b %errorlevel%

:failed
echo.
echo 启动准备失败，请检查上方提示。
pause
exit /b 1
