#Requires -Version 5.1
<#
.SYNOPSIS
  Stops the OR VIP application server that the launcher started. The database and all data are
  kept; the database container keeps running unless -StopDatabase is given (it is then stopped,
  never removed).

  Only the process tree recorded by the launcher is stopped (checked by process id and start
  time), never other Node.js or Docker processes.

.PARAMETER NoGui
  Print the result instead of showing a message box.
.PARAMETER StopDatabase
  Also stop the OR VIP database container (docker compose stop db). Data is kept.
#>
[CmdletBinding()]
param([switch]$NoGui, [switch]$StopDatabase)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking
Initialize-OrVip -LogName 'launcher'
Write-OrVipLog 'INFO' 'stop requested'

$exitCode = 0
try {
    $result = Stop-OrVipSystem -StopDatabase:$StopDatabase
    $key = switch ($result) { 'stopped' { 'status.stopped' } 'not-ours' { 'error.notStartedByLauncher' } default { 'status.notRunning' } }
    $text = Get-OrVipText $key
    $icon = if ($result -eq 'not-ours') { 'Warning' } else { 'Information' }
} catch {
    $f = Resolve-OrVipFailure $_
    $text = $f.Text
    $icon = 'Error'
    $exitCode = $f.ExitCode
}

if ($NoGui) {
    Write-Host $text.en
    Write-Host $text.ar
} else {
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show(($text.en + [Environment]::NewLine + [Environment]::NewLine + $text.ar), 'OR VIP ERP', 'OK', $icon)
}
exit $exitCode
