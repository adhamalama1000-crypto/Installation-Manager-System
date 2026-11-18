#Requires -Version 5.1
<#
.SYNOPSIS
  Read-only report of everything OR VIP needs on this computer. Changes nothing.
  Exit code 0 when everything required is present, 10 otherwise.
#>
[CmdletBinding()]
param()

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking
Initialize-OrVip -LogName 'check'

$rows = New-Object System.Collections.ArrayList
$missing = 0
function Add-Row([string]$Item, [string]$State, [string]$Detail) {
    [void]$rows.Add([pscustomobject]@{ Check = $Item; Result = $State; Detail = $Detail })
    if ($State -eq 'MISSING') { $script:missing++ }
    Write-OrVipLog 'INFO' ('check {0}: {1} {2}' -f $Item, $State, $Detail)
}

$win = Get-OrVipWindowsInfo
Add-Row 'Windows' $(if ($win.Build -ge 19041) { 'OK' } else { 'MISSING' }) ($win.Text + $(if ($win.Build -lt 19041) { ' - needs Windows 10 2004 (19041) or newer' } else { '' }))

$node = Get-OrVipNode
if (-not $node) { Add-Row 'Node.js' 'MISSING' 'install Node.js LTS (20.9+) from https://nodejs.org' }
elseif ($node.Version -lt [version]'20.9.0') { Add-Row 'Node.js' 'MISSING' ($node.VersionText + ' is too old - install Node.js LTS 20.9+') }
else { Add-Row 'Node.js' 'OK' ($node.VersionText + ' ' + $node.Node) }
if ($node) { Add-Row 'npm' $(if ($node.Npm) { 'OK' } else { 'MISSING' }) $(if ($node.Npm) { $node.Npm } else { 'reinstall Node.js' }) }

$root = Get-OrVipRoot
$projectOk = $true
foreach ($f in @('package.json', 'package-lock.json', 'prisma\schema.prisma', 'next.config.ts', 'docker-compose.yml')) {
    if (-not (Test-Path -LiteralPath (Join-Path $root $f))) { $projectOk = $false }
}
Add-Row 'Program folder' $(if ($projectOk) { 'OK' } else { 'MISSING' }) $root

$mode = 'auto'
try {
    $environment = Test-OrVipEnvironment
    $config = Get-OrVipConfig
    $mode = Resolve-OrVipDatabaseMode $config $environment.Db
    Add-Row '.env' 'OK' ('DATABASE_URL ' + $environment.Db.Masked)
    Add-Row 'Database mode' 'OK' $mode
} catch {
    $f = Resolve-OrVipFailure $_
    Add-Row '.env' 'MISSING' $f.Text.en
    $config = Get-OrVipConfig
}

$desktop = Get-OrVipDockerDesktopPath
$cli = Get-OrVipDockerCli
$needDocker = ($mode -ne 'external')
$dockerState = if ($desktop -or $cli) { 'OK' } elseif ($needDocker) { 'MISSING' } else { 'not needed' }
Add-Row 'Docker Desktop' $dockerState $(if ($desktop) { $desktop } elseif ($needDocker) { 'install from https://www.docker.com/products/docker-desktop/' } else { 'external database' })
if ($cli) {
    $engine = Get-OrVipDockerEngine $cli
    Add-Row 'Docker engine' $(if ($engine -eq 'linux') { 'OK' } elseif ($engine) { 'WARN' } else { 'not running' }) $(if ($engine -eq 'windows') { 'switch Docker Desktop to Linux containers' } elseif ($engine) { 'Linux containers' } else { 'the launcher starts Docker Desktop when needed' })
}

$deps = Join-Path $root 'node_modules'
Add-Row 'Dependencies' $(if ((Test-Path -LiteralPath $deps) -and (Test-OrVipKeyModules)) { 'OK' } else { 'not installed' }) 'installed automatically by setup / start (npm ci)'
Add-Row 'Production build' $(if (Test-Path -LiteralPath (Join-Path $root '.next\BUILD_ID')) { 'OK' } else { 'not built' }) 'built automatically when needed'

$situation = Get-OrVipServerSituation $config
$portDetail = switch ($situation.Situation) {
    'free' { 'free' } 'ours' { 'OR VIP is running (started by the launcher)' } 'ours-starting' { 'OR VIP server started by the launcher is not answering yet' }
    'foreign-orvip' { 'OR VIP is running (started outside the launcher)' } default { 'used by ' + $situation.Owner.Name }
}
Add-Row ('Port ' + $config.appPort) $(if ($situation.Situation -eq 'busy') { 'WARN' } else { 'OK' }) $portDetail
Add-Row 'Git (optional)' $(if (Find-OrVipTool 'git.exe') { 'OK' } else { 'not installed' }) 'only needed to download updates'

$rows | Format-Table -AutoSize | Out-String -Width 200 | Write-Host
Write-Host ('Log: ' + (Get-OrVipLogFile))
if ($missing -gt 0) { exit 10 }
exit 0
