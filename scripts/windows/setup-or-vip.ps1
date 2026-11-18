#Requires -Version 5.1
<#
.SYNOPSIS
  First-time setup of OR VIP ERP on this Windows computer (safe to run again at any time to
  check or repair an installation).

  1. Checks Windows, Node.js and Docker Desktop and guides the installation of what is missing.
  2. Creates the .env configuration (an existing .env is never overwritten without typing YES;
     it is then backed up first).
  3. Starts the database, installs the program components, applies database updates (never
     resets or seeds; existing records are kept).
  4. Creates the first Admin account if the database has none.
  5. Builds the program, creates the OR VIP desktop icon and Start menu entries.
  6. Starts OR VIP once to prove that everything works.

.PARAMETER NonInteractive
  No questions (automation). Inputs come from environment variables:
  ORVIP_SETUP_DATABASE_URL (external database only), ORVIP_ADMIN_EMAIL, ORVIP_ADMIN_NAME,
  ORVIP_ADMIN_PASSWORD (only used if the database has no Admin yet).
.PARAMETER DatabaseMode
  docker (default when Docker Desktop is installed) or external (your own PostgreSQL server).
.PARAMETER StartWithWindows
  Also start OR VIP when this Windows user signs in.
#>
[CmdletBinding()]
param(
    [switch]$NonInteractive,
    [ValidateSet('', 'docker', 'external')][string]$DatabaseMode = '',
    [switch]$StartWithWindows,
    [switch]$SkipShortcut,
    [switch]$NoBrowser
)

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking
Initialize-OrVip -LogName 'setup'
try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
$root = Get-OrVipRoot

function Write-Section([string]$Text) { Write-Host ''; Write-Host ('== ' + $Text) -ForegroundColor Cyan; Write-OrVipLog 'INFO' ('setup: ' + $Text) }
function Ask-YesNo([string]$Question, [bool]$Default = $true) {
    if ($NonInteractive) { return $Default }
    $suffix = if ($Default) { '[Y/n]' } else { '[y/N]' }
    $a = Read-Host ('{0} {1}' -f $Question, $suffix)
    if ([string]::IsNullOrWhiteSpace($a)) { return $Default }
    return $a.Trim().ToLowerInvariant().StartsWith('y')
}
function Update-SessionPath {
    $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
    $user = [Environment]::GetEnvironmentVariable('Path', 'User')
    $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}
function Install-WithWinget([string]$Id, [string]$Name, [string]$Url) {
    $winget = Find-OrVipTool 'winget.exe'
    if ($winget -and -not $NonInteractive -and (Ask-YesNo ("Install $Name now with Windows Package Manager (winget)?"))) {
        Write-Host ("Installing $Name... Windows may ask for permission.")
        & $winget install --id $Id --exact --accept-package-agreements --accept-source-agreements | Out-Host
        Update-SessionPath
        return $true
    }
    Write-Host ("Please install $Name from $Url, then run 'Setup OR VIP' again.") -ForegroundColor Yellow
    if (-not $NonInteractive -and (Ask-YesNo 'Open the download page now?')) { Start-Process $Url | Out-Null }
    return $false
}
function Stop-Setup([int]$Code) {
    Write-Host ''
    Write-Host ('Setup log: ' + (Get-OrVipLogFile))
    exit $Code
}
$codes = Get-OrVipExitCodes

$title = Get-OrVipText 'setup.title'
Write-Host $title.en -ForegroundColor Cyan
Write-Host $title.ar -ForegroundColor Cyan
Write-Host ('Program folder: ' + $root)

# ------------------------------------------------------------------------------------------------
Write-Section '1/7 Checking this computer'
$win = Get-OrVipWindowsInfo
Write-Host ('Windows: ' + $win.Text)
if ($win.Build -lt 19041) {
    $t = Get-OrVipText 'error.windowsVersion' @{ version = $win.Text }
    Write-Host $t.en -ForegroundColor Red; Write-Host $t.ar -ForegroundColor Red
    Stop-Setup $codes.Requirements
}

$node = Get-OrVipNode
if (-not $node -or -not $node.Version -or $node.Version -lt [version]'20.9.0') {
    Write-Host 'Node.js LTS (20.9 or newer) is required.' -ForegroundColor Yellow
    if (Install-WithWinget 'OpenJS.NodeJS.LTS' 'Node.js LTS' 'https://nodejs.org') { $node = Get-OrVipNode }
    if (-not $node -or -not $node.Version -or $node.Version -lt [version]'20.9.0') {
        Write-Host 'If Node.js was just installed, close this window and run Setup OR VIP again.' -ForegroundColor Yellow
        Stop-Setup $codes.Requirements
    }
}
Write-Host ('Node.js: {0}' -f $node.VersionText)

$composeDb = Get-OrVipComposeDatabase
$hasDocker = [bool](Get-OrVipDockerDesktopPath) -or [bool](Get-OrVipDockerCli)
$config = Get-OrVipConfig
if (-not $DatabaseMode) {
    if ($config.databaseMode -eq 'docker' -or $config.databaseMode -eq 'external') { $DatabaseMode = $config.databaseMode }
    elseif ($hasDocker -or $NonInteractive) { $DatabaseMode = 'docker' }
    else {
        Write-Host ''
        Write-Host 'OR VIP keeps its data in a PostgreSQL database. Choose how to run it:'
        Write-Host '  1  Docker Desktop (recommended, installed and managed for you)'
        Write-Host '  2  My own PostgreSQL server (advanced)'
        $choice = Read-Host 'Choice [1]'
        $DatabaseMode = if ($choice -eq '2') { 'external' } else { 'docker' }
    }
}
if ($DatabaseMode -eq 'docker' -and -not $hasDocker) {
    Write-Host 'Docker Desktop is required for the bundled database.' -ForegroundColor Yellow
    [void](Install-WithWinget 'Docker.DockerDesktop' 'Docker Desktop' 'https://www.docker.com/products/docker-desktop/')
    Write-Host 'After installing Docker Desktop, restart Windows if asked, open Docker Desktop once to accept its terms, then run Setup OR VIP again.' -ForegroundColor Yellow
    Stop-Setup $codes.Docker
}
Write-Host ('Database: ' + $(if ($DatabaseMode -eq 'docker') { 'Docker Desktop (bundled PostgreSQL)' } else { 'your own PostgreSQL server' }))
$config.databaseMode = $DatabaseMode
Save-OrVipConfig $config

# ------------------------------------------------------------------------------------------------
Write-Section '2/7 Configuration (.env)'
$envPath = Join-Path $root '.env'
$writeEnv = $false
if (Test-Path -LiteralPath $envPath) {
    try {
        $existing = Test-OrVipEnvironment
        Write-Host ('Existing .env is valid. DATABASE_URL: ' + $existing.Db.Masked) -ForegroundColor Green
        if ($DatabaseMode -eq 'docker' -and $existing.Db.IsLocal -and $existing.Db.Port -ne $composeDb.Port) {
            Write-Host ('Note: DATABASE_URL uses port {0}, the bundled database uses port {1}.' -f $existing.Db.Port, $composeDb.Port) -ForegroundColor Yellow
        }
    } catch {
        $f = Resolve-OrVipFailure $_
        Write-Host $f.Text.en -ForegroundColor Yellow
        if (-not $NonInteractive) {
            $answer = Read-Host 'Replace .env with a new one? The current file is backed up first. Type YES to replace'
            $writeEnv = ($answer -ceq 'YES')
        }
        if (-not $writeEnv) { Write-Host 'The existing .env was left unchanged. Fix it and run setup again.'; Stop-Setup $codes.Environment }
    }
} else { $writeEnv = $true }

if ($writeEnv) {
    if ($DatabaseMode -eq 'docker') {
        if (-not $composeDb.Password) { throw 'docker-compose.yml has no POSTGRES_PASSWORD' }
        # The bundled database's own credentials, read from docker-compose.yml (not stored here).
        $enc = [uri]::EscapeDataString($composeDb.Password)
        $dbUrl = 'postgresql://{0}:{1}@localhost:{2}/{3}?schema=public' -f $composeDb.User, $enc, $composeDb.Port, $composeDb.Database
        $testUrl = 'postgresql://{0}:{1}@localhost:{2}/{3}_test?schema=public' -f $composeDb.User, $enc, $composeDb.Port, $composeDb.Database
    } else {
        $dbUrl = $env:ORVIP_SETUP_DATABASE_URL
        if (-not $dbUrl -and -not $NonInteractive) {
            Write-Host 'Enter the connection string of your PostgreSQL database, for example'
            Write-Host '  postgresql://USER:PASSWORD@SERVER:5432/DATABASE?schema=public'
            $secure = Read-Host 'DATABASE_URL (hidden while typing)' -AsSecureString
            $dbUrl = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($secure))
        }
        $parsed = ConvertFrom-OrVipDatabaseUrl $dbUrl
        if (-not $parsed.Valid) { Write-Host ('DATABASE_URL is not valid: ' + $parsed.Problem) -ForegroundColor Red; Stop-Setup $codes.Environment }
        $testUrl = ''
    }
    $lines = New-Object System.Collections.ArrayList
    foreach ($line in [System.IO.File]::ReadAllLines((Join-Path $root '.env.example'))) {
        if ($line -match '^DATABASE_URL=') { [void]$lines.Add('DATABASE_URL="' + $dbUrl + '"') }
        elseif ($line -match '^TEST_DATABASE_URL=') { if ($testUrl) { [void]$lines.Add('TEST_DATABASE_URL="' + $testUrl + '"') } else { [void]$lines.Add('# ' + $line) } }
        elseif ($line -match '^APP_URL=') { [void]$lines.Add('APP_URL="http://localhost:' + $config.appPort + '"') }
        elseif ($line -match '^SEED_PASSWORD=') { [void]$lines.Add('# ' + $line + '   (demo data only; the launcher never seeds)') }
        else { [void]$lines.Add($line) }
    }
    if (Test-Path -LiteralPath $envPath) {
        $backup = $envPath + '.backup-' + (Get-Date -Format 'yyyyMMdd-HHmmss')
        Copy-Item -LiteralPath $envPath -Destination $backup
        Write-Host ('Backed up the previous .env to ' + $backup)
    }
    [System.IO.File]::WriteAllText($envPath, (($lines -join "`r`n") + "`r`n"), (New-Object System.Text.UTF8Encoding $false))
    Write-Host ('Created .env. DATABASE_URL: ' + (ConvertFrom-OrVipDatabaseUrl $dbUrl).Masked) -ForegroundColor Green
}

# ------------------------------------------------------------------------------------------------
$report = New-OrVipConsoleReporter
$status = { param($key) & $report 'setup' 'info' $key @{} }
try {
    $req = Test-OrVipRequirements

    Write-Section '3/7 Database'
    $dockerCli = $null; $project = $null
    if ($req.Mode -eq 'docker') {
        $dockerCli = Start-OrVipDocker $req.Config $status
        $project = Start-OrVipDatabaseContainer $dockerCli $req.Config $req.Db $status
    } else {
        Wait-OrVipExternalDatabase $req.Config $req.Db $status
    }
    Write-Host 'Database is answering.' -ForegroundColor Green

    Write-Section '4/7 Program components'
    $situation = Get-OrVipServerSituation $req.Config
    if ($situation.Situation -eq 'ours' -or $situation.Situation -eq 'ours-starting') {
        Write-Host 'Stopping the running OR VIP server first (data is kept)...'
        Stop-OrVipServer $req.Config | Out-Null
    }
    $deps = Update-OrVipDependencies $req.Node $req.Config $status
    Write-Host ('Program components: ' + $deps) -ForegroundColor Green

    Write-Section '5/7 Database structure and first Admin account'
    $db = Update-OrVipDatabase $req.Node $req.Mode $dockerCli $project $req.Db $status
    Write-Host ('Database structure: ' + $db) -ForegroundColor Green
    $count = Invoke-OrVipCommand -FilePath $req.Node.Node -Arguments @((Join-Path $PSScriptRoot 'lib\count-admins.mjs')) -LogName 'setup-commands' -TimeoutSec 120
    $admins = 0
    $m = [regex]::Match($count.Output, 'ADMINS=(\d+)')
    if ($m.Success) { $admins = [int]$m.Groups[1].Value } else { throw ('Could not read the Admin accounts: ' + (Get-OrVipLastLines $count.Output 3)) }
    if ($admins -gt 0) {
        Write-Host ('Admin accounts found: {0}. Existing data was not changed.' -f $admins) -ForegroundColor Green
    } else {
        Write-Host 'The database has no Admin account yet. Create the first one now.'
        $email = $env:ORVIP_ADMIN_EMAIL; $name = $env:ORVIP_ADMIN_NAME; $password = $env:ORVIP_ADMIN_PASSWORD
        if (-not $NonInteractive) {
            while (-not $email) { $email = (Read-Host 'Admin email').Trim() }
            if (-not $name) { $name = (Read-Host 'Admin full name [Administrator]').Trim() }
            while (-not $password) {
                $p1 = Read-Host 'Password (10+ characters, letters and numbers)' -AsSecureString
                $p2 = Read-Host 'Repeat the password' -AsSecureString
                $a = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p1))
                $b = [Runtime.InteropServices.Marshal]::PtrToStringBSTR([Runtime.InteropServices.Marshal]::SecureStringToBSTR($p2))
                if ($a -ne $b) { Write-Host 'The passwords do not match.' -ForegroundColor Yellow; continue }
                if ($a.Length -lt 10 -or $a -notmatch '[A-Za-z]' -or $a -notmatch '\d') { Write-Host 'Use at least 10 characters with letters and numbers.' -ForegroundColor Yellow; continue }
                $password = $a
            }
        }
        if (-not $name) { $name = 'Administrator' }
        if ($email -and $password) {
            $tsx = Join-Path $root 'node_modules\tsx\dist\cli.mjs'
            # The password goes to this one process as an environment variable; it is never written
            # to disk, the command line or a log.
            $create = Invoke-OrVipCommand -FilePath $req.Node.Node -Arguments @($tsx, 'scripts/create-admin.ts') -LogName 'setup-commands' -TimeoutSec 180 -Environment @{ ADMIN_EMAIL = $email; ADMIN_NAME = $name; ADMIN_PASSWORD = $password }
            $password = $null
            if ($create.ExitCode -ne 0) { Write-Host (Get-OrVipLastLines $create.Output 4) -ForegroundColor Red; throw 'Creating the Admin account failed.' }
            Write-Host ('Admin account ready: ' + $email) -ForegroundColor Green
        } else {
            Add-OrVipWarning 'No Admin account was created. Run Setup OR VIP again to create one.'
        }
    }

    Write-Section '6/7 Preparing the program'
    $build = Update-OrVipBuild $req.Node $req.Config $status
    Write-Host ('Production build: ' + $build) -ForegroundColor Green

    Write-Section '7/7 Desktop icon and first start'
    if (-not $SkipShortcut) {
        & (Join-Path $PSScriptRoot 'create-desktop-shortcut.ps1') -StartWithWindows:$StartWithWindows
    }
    $result = Start-OrVipSystem -Report $report -NoBrowser:$NoBrowser
} catch {
    Stop-Setup (Write-OrVipFailure $_)
}

Write-Host ''
foreach ($w in Get-OrVipWarnings) { Write-Host ('NOTE: ' + $w) -ForegroundColor Yellow }
Write-Host ('OR VIP is ready and running at {0}.' -f $result.Url) -ForegroundColor Green
$ready = Get-OrVipText 'setup.ready'
Write-Host $ready.en
Write-Host $ready.ar
Stop-Setup 0
