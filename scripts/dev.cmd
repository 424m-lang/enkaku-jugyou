@echo off
rem 開発サーバ起動（Claude Codeのpreview/手動デバッグ用。授業本番は「授業サーバを起動.cmd」を使用）
chcp 65001 >nul
set "PATH=C:\Users\Nishioka\AppData\Local\nodejs;%PATH%"
set "PORT=3000"
cd /d "%~dp0.."
npm run dev
