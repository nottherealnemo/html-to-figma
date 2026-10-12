@echo off
rem Double-click me to connect HTML to Figma to the AI apps on this PC.
cd /d "%~dp0"
title HTML to Figma installer
echo HTML to Figma installer
echo.
where node >nul 2>nul
if errorlevel 1 goto nonode
node "mcp-server\html-to-figma-mcp.mjs" setup %*
echo.
pause
exit /b 0
:nonode
echo One thing first: this needs Node.js, a free helper program.
echo Opening the download page now. Choose the Windows installer, click through it,
echo then double-click this file again.
start "" "https://nodejs.org/en/download"
echo.
pause
exit /b 1
