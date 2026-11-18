#Requires -Version 5.1
<#
.SYNOPSIS
  Creates the "OR VIP" desktop icon and an "OR VIP" Start menu folder (Start, Stop, Restart,
  Logs, Setup) for the current Windows user, with the official OR VIP icon. Shortcuts contain no
  passwords or secrets - only the path of the launcher script.

.PARAMETER StartWithWindows
  Also start OR VIP when this user signs in to Windows (no browser is opened then).
.PARAMETER RemoveStartWithWindows
  Remove that sign-in entry again.
.PARAMETER DesktopFolder / StartMenuFolder
  Other target folders (used by the automated tests).
#>
[CmdletBinding()]
param(
    [switch]$StartWithWindows,
    [switch]$RemoveStartWithWindows,
    [string]$DesktopFolder = [Environment]::GetFolderPath('Desktop'),
    [string]$StartMenuFolder = (Join-Path ([Environment]::GetFolderPath('Programs')) 'OR VIP')
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking
Initialize-OrVip -LogName 'setup'

$root = Get-OrVipRoot
$icon = Join-Path $PSScriptRoot 'assets\or-vip.ico'
if (-not (Test-Path -LiteralPath $icon)) {
    # Recreate the icon from the OR VIP emblem if the .ico file was lost.
    Add-Type -AssemblyName System.Drawing
    $mark = Join-Path $root 'public\brand\mark.png'
    $bmp = New-Object System.Drawing.Bitmap((New-Object System.Drawing.Bitmap($mark)), 256, 256)
    $handle = $bmp.GetHicon()
    $ico = [System.Drawing.Icon]::FromHandle($handle)
    $fs = [System.IO.File]::Create($icon); $ico.Save($fs); $fs.Close()
    Write-OrVipLog 'INFO' 'recreated assets\or-vip.ico from public\brand\mark.png'
}

# Files downloaded as a ZIP are marked as coming from the internet; clear that mark on our own
# scripts so Windows does not block them.
Get-ChildItem -LiteralPath $PSScriptRoot -Recurse -File | Unblock-File -ErrorAction SilentlyContinue

$powershell = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$shell = New-Object -ComObject WScript.Shell

function New-OrVipShortcut([string]$Path, [string]$Script, [string]$ExtraArgs, [string]$Description, [string]$Target = $powershell, [string]$Arguments = '', [int]$WindowStyle = 7) {
    $dir = Split-Path $Path -Parent
    if (-not (Test-Path -LiteralPath $dir)) { New-Item -ItemType Directory -Path $dir -Force | Out-Null }
    $lnk = $shell.CreateShortcut($Path)
    $lnk.TargetPath = $Target
    if ($Script) {
        $lnk.Arguments = ('-NoProfile -ExecutionPolicy Bypass -STA -WindowStyle Hidden -File "{0}" {1}' -f (Join-Path $PSScriptRoot $Script), $ExtraArgs).Trim()
    } else {
        $lnk.Arguments = $Arguments
    }
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = $icon + ',0'
    $lnk.Description = $Description
    # 7 = minimized: the hidden PowerShell host never flashes up; only the OR VIP window shows.
    $lnk.WindowStyle = $WindowStyle
    $lnk.Save()
    # Read it back to prove it was written correctly.
    $check = $shell.CreateShortcut($Path)
    if (-not (Test-Path -LiteralPath $Path) -or $check.TargetPath -ne $Target) { throw ('Could not create the shortcut ' + $Path) }
    Write-OrVipLog 'INFO' ('shortcut: {0} -> {1} {2}' -f $Path, $check.TargetPath, $check.Arguments)
    Write-Host ('  created: ' + $Path)
}

Write-Host 'Creating OR VIP shortcuts...'
New-OrVipShortcut (Join-Path $DesktopFolder 'OR VIP.lnk') 'start-or-vip.ps1' '' 'Start OR VIP ERP and open it in the browser'
New-OrVipShortcut (Join-Path $StartMenuFolder 'OR VIP.lnk') 'start-or-vip.ps1' '' 'Start OR VIP ERP and open it in the browser'
New-OrVipShortcut (Join-Path $StartMenuFolder 'Stop OR VIP.lnk') 'stop-or-vip.ps1' '' 'Stop the OR VIP application server (data is kept)'
New-OrVipShortcut (Join-Path $StartMenuFolder 'Restart OR VIP.lnk') 'restart-or-vip.ps1' '' 'Restart the OR VIP application server'
New-OrVipShortcut (Join-Path $StartMenuFolder 'OR VIP logs.lnk') '' '' 'Open the OR VIP diagnostic logs' (Join-Path $env:SystemRoot 'explorer.exe') ('"{0}"' -f (Get-OrVipLogDir)) 1
New-OrVipShortcut (Join-Path $StartMenuFolder 'OR VIP setup.lnk') '' '' 'Check and repair the OR VIP installation' (Join-Path $env:SystemRoot 'System32\cmd.exe') ('/c ""{0}""' -f (Join-Path $PSScriptRoot 'Setup OR VIP.cmd')) 1

$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'OR VIP.lnk'
if ($StartWithWindows) {
    New-OrVipShortcut $startup 'start-or-vip.ps1' '-NoBrowser' 'Start OR VIP ERP when Windows starts'
} elseif ($RemoveStartWithWindows -and (Test-Path -LiteralPath $startup)) {
    Remove-Item -LiteralPath $startup -Force
    Write-Host ('  removed: ' + $startup)
}
Write-Host 'Done. Double-click "OR VIP" on the desktop to start.'
