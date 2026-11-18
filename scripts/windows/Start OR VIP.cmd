@echo off
rem Starts OR VIP ERP (the same as the OR VIP desktop icon).
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0start-or-vip.ps1" %*
