@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ==============================================
echo  NodeChatCli 构建
echo ==============================================

dotnet build -c Release --nologo
if errorlevel 1 (
  echo.
  echo [x] 构建失败
  exit /b 1
)

if not exist dist mkdir dist
copy /y "bin\Release\net48\NodeChatCli.exe" "dist\NodeChatCli.exe" >nul

echo.
echo [ok] 产物: %cd%\dist\NodeChatCli.exe
endlocal
