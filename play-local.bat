@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo.
echo   FOREIGN / 异物  -  本地启动
echo   ================================
echo.

if not exist "dist\index.html" (
  echo   [1/2] 没有找到已构建的 dist，正在构建...
  call npm run build
  if errorlevel 1 (
    echo.
    echo   构建失败。请把上面的错误发给我。
    pause
    exit /b 1
  )
) else (
  echo   [1/2] 使用已构建的 dist
)

echo   [2/2] 启动本地服务器 http://127.0.0.1:4173/
echo.
echo   浏览器打开后：
echo     - 点「进入现场」开始
echo     - WASD 移动 / Shift 疾走 / 鼠标转头
echo     - 左键标记可疑的东西 / Esc 暂停
echo.
echo   关闭这个窗口就会停止服务器。
echo.

start "" http://127.0.0.1:4173/
call npm run preview
pause
