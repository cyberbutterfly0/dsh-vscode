@echo off
rem ============================================================
rem  DSH Quick Launcher - background + Edge app window
rem  Double-click to run. You may close this window after it
rem  launches; dsh keeps running in the background.
rem ============================================================
chcp 65001 >nul
setlocal

set "SCRIPT=%~dp0dsh-launch.ps1"

if not exist "%SCRIPT%" (
    echo [ERROR] Cannot find: %SCRIPT%
    echo Put dsh-launch.ps1 and this .bat in the same folder.
    pause
    exit /b 1
)

rem  Extra arguments are passed through, e.g.
rem    dsh-launch.bat -NoRestart     reuse a healthy 3080 instead of restarting
rem    dsh-launch.bat -DryRun        print the plan, touch nothing
rem    dsh-launch.bat -NoOpen        do not open the Edge window
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*

endlocal
