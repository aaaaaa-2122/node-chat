@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"

echo ============================================
echo   Node Chat 桌面端构建
echo ============================================

where dotnet >nul 2>nul
if errorlevel 1 (
  echo [错误] 没有找到 dotnet。请安装 .NET SDK 6 或更高版本。
  exit /b 1
)

echo [1/3] 编译（目标 .NET Framework 4.8，Windows 10/11 自带运行时）...
dotnet build -c Release -v:m
if errorlevel 1 (
  echo [错误] 编译失败
  exit /b 1
)

echo [2/3] 收集产物到 dist ...
if not exist dist mkdir dist
copy /y "bin\Release\net48\NodeChat.exe" "dist\NodeChat.exe" >nul

echo [3/3] 完成
echo.
for %%i in ("dist\NodeChat.exe") do echo   产物: %%~fi  (%%~zi 字节)
echo   直接双击 dist\NodeChat.exe 即可运行
endlocal
