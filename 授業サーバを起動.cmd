@echo off
chcp 65001 >nul
title 遠隔授業サーバ
set "PATH=C:\Users\Nishioka\AppData\Local\nodejs;%PATH%"
set "PORT=3000"
cd /d "%~dp0"
echo.
echo 最新のクライアントをビルドしています（10〜20秒ほどかかります）...
call npm run build
if errorlevel 1 (
  echo.
  echo ビルドに失敗しました。このウィンドウの内容を確認してください。
  pause
  exit /b 1
)
set "IP="
for /f "tokens=2 delims=:" %%a in ('ipconfig ^| findstr "IPv4"') do if not defined IP set "IP=%%a"
set "IP=%IP: =%"
cls
echo ==================================================
echo   遠隔授業サーバ 起動中
echo.
echo   先生用（このPCのブラウザで開く）:
echo     http://localhost:3000
echo.
echo   生徒用（同じWi-Fiの端末で開く）:
echo     http://%IP%:3000/join
echo.
echo   ※ 授業が終わるまでこのウィンドウは閉じないでください
echo   ※ 終了するときは、このウィンドウを閉じるだけでOKです
echo ==================================================
echo.
npm start
