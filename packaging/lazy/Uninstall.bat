@echo off
rem Resolve PowerShell by absolute path: a broken PATH can hide powershell.exe.
setlocal
"%SystemRoot%\System32\chcp.com" 65001 >nul 2>nul
cd /d "%~dp0"

set "PS=%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" set "PS=%SystemRoot%\Sysnative\WindowsPowerShell\v1.0\powershell.exe"
if not exist "%PS%" goto no_powershell

"%PS%" -NoProfile -ExecutionPolicy Bypass -File "%~dp0uninstall.ps1" %*
if errorlevel 1 pause
endlocal
exit /b 0

:no_powershell
echo.
echo [ERROR] Windows PowerShell was not found on this computer.
echo Expected: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe
echo.
echo Enable "Windows PowerShell" in Windows optional features,
echo or right-click uninstall.ps1 and choose "Run with PowerShell".
echo.
pause
endlocal
exit /b 1
