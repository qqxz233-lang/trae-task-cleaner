@echo off
setlocal
title Trae CN Task Auto Cleaner

REM ==================== CONFIG ====================
REM Trae CN executable path (used to auto restart with debug port)
set "TRAE_EXE=D:\Program Files\Trae CN\Trae CN.exe"
REM Node path fallback (used only if 'node' is not in PATH)
set "NODE_FALLBACK=D:\Program Files\nodejs\node.exe"
REM ================================================

cd /d "%~dp0"

echo ==================================================
echo   Trae CN Task Auto Cleaner
echo   Project list: trae-projects.txt (one per line)
echo   Only cleans projects whose windows are open.
echo   Keeps newest 20 tasks per project.
echo ==================================================
echo.

set "NODE_EXE=node"
where node >nul 2>&1 || set "NODE_EXE=%NODE_FALLBACK%"

REM ---- Check Trae debug port ----
curl -s -o nul -m 3 http://127.0.0.1:9222/json/version
if %errorlevel%==0 goto :run

echo [!] Cannot reach Trae debug port 9222.
echo     Trae is not running, or not started with debug port.
echo.
choice /c YN /n /m "Restart Trae with debug port? [Y=continue, N=exit]"
if errorlevel 2 goto :end

echo.
echo [1/2] Closing Trae gracefully (window state preserved) ...
powershell -NoProfile -Command "$p = Get-Process | Where-Object { $_.Path -like 'D:\Program Files\Trae CN\*' -and $_.MainWindowHandle -ne 0 }; $p | ForEach-Object { [void]$_.CloseMainWindow() }; Start-Sleep 12; $l = @(Get-Process | Where-Object { $_.Path -like 'D:\Program Files\Trae CN\*' }).Count; if ($l -gt 0) { Start-Sleep 8 }"

echo [2/2] Starting Trae with debug port, waiting 60s for windows ...
start "" "%TRAE_EXE%" --remote-debugging-port=9222
timeout /t 60 /nobreak >nul

curl -s -o nul -m 3 http://127.0.0.1:9222/json/version
if not %errorlevel%==0 (
    echo.
    echo [!] Debug port still not ready. Trae may still be starting.
    echo     Wait until Trae fully opens, then run this script again.
    goto :end
)

:run
echo.
"%NODE_EXE%" trae-task-cleaner.mjs auto %*
set EXITCODE=%errorlevel%

echo.
echo ==================================================
if "%EXITCODE%"=="0" (echo [OK] Done.) else (echo [ERR] Exit code %EXITCODE%)
echo ==================================================
REM Project list output may contain Chinese; switch code page for display
chcp 65001 >nul
pause
exit /b %EXITCODE%

:end
pause
exit /b 1