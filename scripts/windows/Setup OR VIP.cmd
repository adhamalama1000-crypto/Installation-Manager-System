@echo off
rem First-time setup of OR VIP ERP (safe to run again to check or repair the installation).
title OR VIP ERP - Setup
"%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -File "%~dp0setup-or-vip.ps1" %*
echo.
pause
