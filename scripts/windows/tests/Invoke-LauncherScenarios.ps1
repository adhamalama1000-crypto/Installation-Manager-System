#Requires -Version 5.1
<#
  End-to-end scenarios for the OR VIP Windows launcher, run by .github/workflows/windows-launcher.yml
  on a real Windows machine against a real PostgreSQL server ("external database" mode, because
  Docker Desktop cannot run on the hosted Windows runners).

  Needs: Node.js, a PostgreSQL server with an empty database, and
    ORVIP_TEST_DATABASE_URL  connection string of that database
    ORVIP_TEST_PG_SERVICE    Windows service name of that PostgreSQL server (to simulate outages)

  Never runs a destructive database command: the database is only migrated forward, and the
  test checks that its rows survive every stop, restart and failure.
#>
$ErrorActionPreference = 'Stop'
$root = (Resolve-Path (Join-Path $PSScriptRoot '..\..\..')).Path
$win = Join-Path $root 'scripts\windows'
$ps = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$dbUrl = $env:ORVIP_TEST_DATABASE_URL
if (-not $dbUrl) { throw 'Set ORVIP_TEST_DATABASE_URL' }
$env:ORVIP_DATABASE_MODE = 'external'
$envFile = Join-Path $root '.env'
$state = Join-Path $root '.orvip\server.json'
$results = New-Object System.Collections.ArrayList
$failed = 0
Set-Location $root

function Invoke-Launcher([string]$Script, [string[]]$Arguments = @()) {
    $out = & $ps -NoProfile -ExecutionPolicy Bypass -File (Join-Path $win $Script) @Arguments 2>&1 | Out-String
    $code = $LASTEXITCODE
    Write-Host $out
    return @{ Code = $code; Output = $out }
}
function Check([string]$Scenario, [bool]$Condition, [string]$What) {
    $ok = if ($Condition) { 'PASS' } else { 'FAIL' }
    if (-not $Condition) { $script:failed++ }
    [void]$results.Add([pscustomobject]@{ Scenario = $Scenario; Result = $ok; Check = $What })
    Write-Host ('[{0}] {1}: {2}' -f $ok, $Scenario, $What) -ForegroundColor $(if ($Condition) { 'Green' } else { 'Red' })
}
function Get-Health {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -Uri 'http://127.0.0.1:3000/api/health' -TimeoutSec 5
        return ($r.Content | ConvertFrom-Json)
    } catch { return $null }
}
function Get-ServerPid { if (Test-Path $state) { return [int]((Get-Content $state -Raw | ConvertFrom-Json).pid) } return $null }
function Test-PortFree { -not (Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue) }
function Get-RowCounts {
    $out = & node (Join-Path $PSScriptRoot 'row-counts.mjs') 2>&1
    return [string]($out | Select-Object -Last 1)
}
function Write-Env([string]$Url) {
    $text = (Get-Content (Join-Path $root '.env.example') -Raw) -replace '(?m)^DATABASE_URL=.*$', ('DATABASE_URL="' + $Url + '"')
    [System.IO.File]::WriteAllText($envFile, $text)
}

# 1. Missing .env ---------------------------------------------------------------------------------
Remove-Item $envFile -Force -ErrorAction SilentlyContinue
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Missing .env' ($r.Code -eq 11) "exit code 11 (got $($r.Code))"
Check 'Missing .env' ($r.Output -match 'configuration file \(\.env\) is missing') 'explains what to do'

# 2. Incorrect configuration ------------------------------------------------------------------------
Write-Env 'mysql://someone:pw@localhost/db'
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Invalid DATABASE_URL' ($r.Code -eq 11) "exit code 11 (got $($r.Code))"
Check 'Invalid DATABASE_URL' ($r.Output -match 'must start with postgresql://') 'names the problem'
Remove-Item $envFile -Force

# 3. First launch: non-interactive first-time setup (no node_modules, empty database) -------------
Check 'First launch' (-not (Test-Path (Join-Path $root 'node_modules'))) 'starts without node_modules'
$env:ORVIP_SETUP_DATABASE_URL = $dbUrl
$env:ORVIP_ADMIN_EMAIL = 'owner@orvip.test'
$env:ORVIP_ADMIN_NAME = 'Owner'
$env:ORVIP_ADMIN_PASSWORD = 'Launcher-Test-2026'
$started = Get-Date
$r = Invoke-Launcher 'setup-or-vip.ps1' @('-NonInteractive', '-DatabaseMode', 'external', '-NoBrowser')
Remove-Item Env:ORVIP_ADMIN_PASSWORD
Check 'First launch' ($r.Code -eq 0) "setup exit code 0 (got $($r.Code)) in $([int]((Get-Date) - $started).TotalSeconds) s"
Check 'First launch' (Test-Path $envFile) '.env created'
Check 'First launch' (Test-Path (Join-Path $root 'node_modules\next\dist\bin\next')) 'dependencies installed'
Check 'First launch' (Test-Path (Join-Path $root '.next\BUILD_ID')) 'production build created'
$h = Get-Health
Check 'First launch' ($h -and $h.status -eq 'ok' -and $h.database -eq 'ok') 'health endpoint answers ok'
Check 'First launch' ($r.Output -match 'Admin account ready: owner@orvip.test') 'first Admin account created'
$desktop = Join-Path ([Environment]::GetFolderPath('Desktop')) 'OR VIP.lnk'
Check 'Desktop shortcut' (Test-Path $desktop) "created $desktop"
if (Test-Path $desktop) {
    $lnk = (New-Object -ComObject WScript.Shell).CreateShortcut($desktop)
    Check 'Desktop shortcut' ($lnk.TargetPath -match 'powershell\.exe$') 'runs Windows PowerShell'
    Check 'Desktop shortcut' ($lnk.Arguments -match 'start-or-vip\.ps1' -and $lnk.Arguments -match '-WindowStyle Hidden') 'starts the launcher hidden'
    Check 'Desktop shortcut' ($lnk.IconLocation -match 'or-vip\.ico') 'uses the OR VIP icon'
    Check 'Desktop shortcut' ($lnk.Arguments -notmatch 'Launcher-Test-2026|postgresql://') 'contains no secrets'
}
foreach ($n in @('OR VIP', 'Stop OR VIP', 'Restart OR VIP', 'OR VIP logs', 'OR VIP setup')) {
    Check 'Start menu' (Test-Path (Join-Path ([Environment]::GetFolderPath('Programs')) ("OR VIP\$n.lnk"))) "$n shortcut"
}
$rows = Get-RowCounts
Write-Host "row counts (users, customers, statuses): $rows"
$pid1 = Get-ServerPid

# 4. Already running: a second double-click opens the running system --------------------------------
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Already running' ($r.Code -eq 0 -and $r.Output -match 'already running') 'exit 0, reports already running'
Check 'Already running' ((Get-ServerPid) -eq $pid1) 'no second server started'

# 5. Two launches at the same time ---------------------------------------------------------------
$a = Start-Process $ps -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $win 'start-or-vip.ps1')), '-NoGui', '-NoBrowser' -PassThru -WindowStyle Hidden
$b = Start-Process $ps -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ('"{0}"' -f (Join-Path $win 'start-or-vip.ps1')), '-NoGui', '-NoBrowser' -PassThru -WindowStyle Hidden
$a.WaitForExit(300000) | Out-Null; $b.WaitForExit(300000) | Out-Null
Check 'Repeated launches' ($a.ExitCode -eq 0 -and $b.ExitCode -eq 0) "both exit 0 (got $($a.ExitCode), $($b.ExitCode))"
Check 'Repeated launches' ((Get-ServerPid) -eq $pid1) 'still exactly one server'
$listeners = @(Get-NetTCPConnection -LocalPort 3000 -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
Check 'Repeated launches' ($listeners.Count -eq 1) "one process listens on 3000 (got $($listeners.Count))"

# 6. Stop ---------------------------------------------------------------------------------------
$r = Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui')
Check 'Stop' ($r.Code -eq 0 -and $r.Output -match 'is stopped') 'exit 0, reports stopped'
Check 'Stop' (Test-PortFree) 'port 3000 is free'
Check 'Stop' (-not (Test-Path $state)) 'server record removed'
Check 'Stop' (-not (Get-Process -Id $pid1 -ErrorAction SilentlyContinue)) 'launcher-started process ended'
Check 'Stop keeps data' ((Get-RowCounts) -eq $rows) "rows unchanged ($rows)"
$r = Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui')
Check 'Stop twice' ($r.Code -eq 0 -and $r.Output -match 'not running') 'second stop is harmless'

# 7. Normal subsequent launch (nothing to install or build) -----------------------------------------
$logBefore = (Get-ChildItem (Join-Path $root '.orvip\logs') -Filter 'launcher-*.log' | Get-Content -Raw) -join ''
$started = Get-Date
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
$seconds = [int]((Get-Date) - $started).TotalSeconds
$logAfter = ((Get-ChildItem (Join-Path $root '.orvip\logs') -Filter 'launcher-*.log' | Get-Content -Raw) -join '').Substring($logBefore.Length)
Check 'Normal launch' ($r.Code -eq 0) "exit 0 in $seconds s"
Check 'Normal launch' ($logAfter -match 'skipped npm ci') 'did not reinstall dependencies'
Check 'Normal launch' ($logAfter -match 'skipped next build') 'did not rebuild'
Check 'Normal launch' ($logAfter -match 'migration state: UpToDate') 'no database update needed'
$pid2 = Get-ServerPid

# 8. Restart ------------------------------------------------------------------------------------
$r = Invoke-Launcher 'restart-or-vip.ps1' @('-NoGui', '-NoBrowser')
$pid3 = Get-ServerPid
Check 'Restart' ($r.Code -eq 0 -and $pid3 -and $pid3 -ne $pid2) "exit 0, new server process ($pid2 -> $pid3)"
Check 'Restart' (-not (Get-Process -Id $pid2 -ErrorAction SilentlyContinue)) 'old server process ended'
Check 'Restart keeps data' ((Get-RowCounts) -eq $rows) 'rows unchanged'

# 9. Windows restart recovery: the server is gone and its process id now belongs to someone else -----
& (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $pid3 /T /F | Out-Null
Start-Sleep -Seconds 2
$innocent = Start-Process (Join-Path $env:SystemRoot 'System32\PING.EXE') -ArgumentList '-n', '600', '127.0.0.1' -PassThru -WindowStyle Hidden
@{ pid = $innocent.Id; created = '638000000000000000'; childPid = $null; childCreated = $null; port = 3000 } | ConvertTo-Json | Set-Content $state
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Recovery after restart' ($r.Code -eq 0) "exit 0 (got $($r.Code))"
Check 'Recovery after restart' (-not $innocent.HasExited) 'did not kill the process that re-used the old id'
Check 'Recovery after restart' ((Get-Health).status -eq 'ok') 'server healthy again'
$r = Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui')
Check 'Stop only our processes' (-not $innocent.HasExited) 'unrelated process still running after stop'
Stop-Process -Id $innocent.Id -Force

# 10. Port 3000 used by another program ------------------------------------------------------------
$foreign = Start-Process node -ArgumentList ('"{0}"' -f (Join-Path $PSScriptRoot 'fake-app.mjs')) -PassThru -WindowStyle Hidden
Start-Sleep -Seconds 2
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Port 3000 occupied' ($r.Code -eq 70) "exit 70 (got $($r.Code))"
Check 'Port 3000 occupied' ($r.Output -match 'already used by another program \(node\.exe\)') 'names the program using the port'
$r = Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui')
Check 'Port 3000 occupied' (-not $foreign.HasExited) 'the other program was not stopped'
Stop-Process -Id $foreign.Id -Force

# 11. OR VIP started by hand (not by the launcher) is used but never stopped ------------------------
$manual = Start-Process node -ArgumentList ('"{0}"' -f (Join-Path $root 'node_modules\next\dist\bin\next')), 'start', '-p', '3000', '-H', '127.0.0.1' -WorkingDirectory $root -PassThru -WindowStyle Hidden
$deadline = (Get-Date).AddSeconds(60); while (-not (Get-Health) -and (Get-Date) -lt $deadline) { Start-Sleep 1 }
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Server started by hand' ($r.Code -eq 0 -and $r.Output -match 'not started by this launcher') 'reuses it and says so'
$r = Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui')
Check 'Server started by hand' (-not $manual.HasExited -and $r.Output -match 'not started by this launcher') 'stop leaves it running'
& (Join-Path $env:SystemRoot 'System32\taskkill.exe') /PID $manual.Id /T /F | Out-Null
Start-Sleep -Seconds 2

# 12. Wrong database password ------------------------------------------------------------------------
Copy-Item $envFile "$envFile.good" -Force
$bad = $dbUrl -replace '://([^:]+):[^@]+@', '://$1:Wrong-Pass-123@'
(Get-Content $envFile -Raw) -replace '(?m)^DATABASE_URL=.*$', ('DATABASE_URL="' + $bad + '"') | Set-Content $envFile -NoNewline
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Wrong database password' ($r.Code -eq 30) "exit 30 (got $($r.Code))"
Check 'Wrong database password' ($r.Output -match 'refused the user name or password') 'readable message'
Check 'Wrong database password' ($r.Output -notmatch 'Wrong-Pass-123') 'password not shown'
Copy-Item "$envFile.good" $envFile -Force; Remove-Item "$envFile.good"

# 13. Database unavailable -----------------------------------------------------------------------
'{ "databaseTimeoutSec": 15 }' | Set-Content (Join-Path $root '.orvip\config.json')
Stop-Service -Name $env:ORVIP_TEST_PG_SERVICE -Force
$started = Get-Date
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
$seconds = [int]((Get-Date) - $started).TotalSeconds
Check 'Database unavailable' ($r.Code -eq 30) "exit 30 (got $($r.Code))"
Check 'Database unavailable' ($r.Output -match 'did not answer within 15 seconds') 'readable message'
Check 'Database unavailable' ($seconds -lt 90) "gave up after $seconds s (no endless waiting)"
Start-Service -Name $env:ORVIP_TEST_PG_SERVICE
Remove-Item (Join-Path $root '.orvip\config.json')
Check 'Database back' ((Get-RowCounts) -eq $rows) 'rows unchanged after the outage'

# 14. Application startup failure ------------------------------------------------------------------
$crash = Join-Path $env:TEMP 'orvip-crash.js'
'console.error("simulated startup failure"); process.exit(1);' | Set-Content $crash
$env:ORVIP_SERVER_ENTRY = $crash
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Remove-Item Env:ORVIP_SERVER_ENTRY
Check 'Application startup failure' ($r.Code -eq 71) "exit 71 (got $($r.Code))"
Check 'Application startup failure' ($r.Output -match 'simulated startup failure') 'shows the end of the server log'
Check 'Application startup failure' (-not (Test-Path $state) -and (Test-PortFree)) 'nothing left behind'

# 15. Missing / broken dependencies are repaired ---------------------------------------------------------
Remove-Item (Join-Path $root 'node_modules\next') -Recurse -Force
$r = Invoke-Launcher 'start-or-vip.ps1' @('-NoGui', '-NoBrowser')
Check 'Missing dependencies' ($r.Code -eq 0) "reinstalled and started, exit 0 (got $($r.Code))"
Check 'Missing dependencies' ((Get-Health).status -eq 'ok') 'server healthy'
Invoke-Launcher 'stop-or-vip.ps1' @('-NoGui') | Out-Null

# 16. Prerequisite report and the OR VIP window ------------------------------------------------------
$r = Invoke-Launcher 'check-prerequisites.ps1'
Check 'Prerequisite check' ($r.Code -eq 0) "exit 0 (got $($r.Code))"
$png = Join-Path $root '.orvip\logs\launcher-window.png'
$r = Invoke-Launcher 'start-or-vip.ps1' @('-GuiPreview', $png)
Check 'OR VIP window' ($r.Code -eq 0 -and (Test-Path $png) -and (Get-Item $png).Length -gt 10000) 'window renders (see launcher-window.png)'

# 17. No secrets in any log ------------------------------------------------------------------------------
$password = ([regex]::Match($dbUrl, '://[^:]+:([^@]+)@')).Groups[1].Value
$leaks = Get-ChildItem (Join-Path $root '.orvip\logs') -File | Where-Object { (Get-Content $_.FullName -Raw) -match [regex]::Escape($password) -or (Get-Content $_.FullName -Raw) -match 'Launcher-Test-2026' }
Check 'No secrets in logs' (@($leaks).Count -eq 0) ('no password in ' + (Get-ChildItem (Join-Path $root '.orvip\logs') -File).Count + ' log files')
Check 'Data kept' ((Get-RowCounts) -eq $rows) "final rows unchanged ($rows)"

$results | Format-Table -AutoSize | Out-String -Width 220 | Write-Host
Write-Host ('{0} checks, {1} failed' -f $results.Count, $failed)
if ($failed -gt 0) { exit 1 }
exit 0
