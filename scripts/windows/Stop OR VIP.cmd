@echo off
rem Stops the OR VIP application server. The database and all data are kept.
start "" "%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "%~dp0stop-or-vip.ps1" %*
