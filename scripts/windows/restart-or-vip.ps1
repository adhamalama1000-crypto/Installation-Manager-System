#Requires -Version 5.1
<#
.SYNOPSIS
  Restarts the OR VIP application server: stops the server the launcher started (data is kept)
  and runs the normal start sequence again.
#>
[CmdletBinding()]
param([switch]$NoGui, [switch]$NoBrowser)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking
Initialize-OrVip -LogName 'launcher'
Write-OrVipLog 'INFO' 'restart requested'
try {
    $result = Stop-OrVipSystem
    if ($result -eq 'not-ours') {
        $t = Get-OrVipText 'error.notStartedByLauncher'
        if ($NoGui) { Write-Host $t.en; Write-Host $t.ar }
        else {
            Add-Type -AssemblyName System.Windows.Forms
            [void][System.Windows.Forms.MessageBox]::Show(($t.en + [Environment]::NewLine + [Environment]::NewLine + $t.ar), 'OR VIP ERP', 'OK', 'Warning')
        }
        exit 0
    }
} catch {
    exit (Write-OrVipFailure $_)
}
& (Join-Path $PSScriptRoot 'start-or-vip.ps1') -NoGui:$NoGui -NoBrowser:$NoBrowser
exit $LASTEXITCODE
