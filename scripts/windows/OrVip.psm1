#Requires -Version 5.1
<#
  OR VIP Windows launcher - shared logic.

  Written for Windows PowerShell 5.1 (built into Windows 10 and 11), so nothing extra has to be
  installed; it also runs under PowerShell 7. Every script in this folder imports this module.

  Safety rules this module follows (see docs/OR_VIP_WINDOWS_LAUNCHER.md):
  - Never resets, re-creates or seeds the database. Only `prisma migrate deploy` (forward-only),
    after a backup, and only when migrations are pending.
  - Never runs `docker compose down` or removes volumes. The database container is only started
    (`up -d db`) or, on explicit request, stopped (`stop db`).
  - Stops only the server process tree it started itself, identified by process id AND creation
    time, so a re-used process id after a Windows restart is never killed.
  - Never prints or logs passwords: connection strings are masked before they are written.
#>

Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Stop'

# --------------------------------------------------------------------------------------------
# Paths, exit codes and state
# --------------------------------------------------------------------------------------------

$script:Root = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$script:StateDir = Join-Path $script:Root '.orvip'
$script:LogDir = Join-Path $script:StateDir 'logs'
$script:BackupDir = Join-Path $script:StateDir 'backups'
$script:ServerStateFile = Join-Path $script:StateDir 'server.json'
$script:ConfigFile = Join-Path $script:StateDir 'config.json'
$script:LogFile = $null
$script:Messages = $null
$script:Pump = $null          # GUI mode: a scriptblock that keeps the window responsive.
$script:Mutex = $null
$script:Warnings = New-Object System.Collections.ArrayList

$script:ExitCodes = @{
    Ok = 0; Requirements = 10; Environment = 11; Docker = 20; Database = 30; Dependencies = 40
    Migrations = 50; Build = 60; PortBusy = 70; ServerExited = 71; ServerTimeout = 72
    ServerDatabase = 73; Busy = 80; Unexpected = 90
}

function Get-OrVipRoot { $script:Root }
function Get-OrVipLogFile { $script:LogFile }
function Get-OrVipLogDir { $script:LogDir }
function Get-OrVipExitCodes { $script:ExitCodes }
function Get-OrVipWarnings { return [string[]]@($script:Warnings | Where-Object { $_ }) }

# --------------------------------------------------------------------------------------------
# Messages, errors, logging
# --------------------------------------------------------------------------------------------

function Initialize-OrVip {
    param([scriptblock]$Pump, [string]$LogName = 'launcher')
    foreach ($d in @($script:StateDir, $script:LogDir, $script:BackupDir)) {
        if (-not (Test-Path -LiteralPath $d)) { New-Item -ItemType Directory -Path $d -Force | Out-Null }
    }
    $script:Pump = $Pump
    $script:LogFile = Join-Path $script:LogDir ('{0}-{1}.log' -f $LogName, (Get-Date -Format 'yyyyMMdd'))
    $json = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot 'messages.json'), [System.Text.Encoding]::UTF8)
    $script:Messages = $json | ConvertFrom-Json
    $script:Warnings.Clear()
    # Keep two weeks of logs.
    Get-ChildItem -LiteralPath $script:LogDir -Filter '*.log' -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -lt (Get-Date).AddDays(-14) } |
        Remove-Item -Force -ErrorAction SilentlyContinue
    Write-OrVipLog 'INFO' ('---- {0} (PowerShell {1}) in {2}' -f $LogName, $PSVersionTable.PSVersion, $script:Root)
}

<# Masks the password of any connection string and any KEY=value secret in a text. #>
function Protect-OrVipSecret {
    param([AllowNull()][string]$Text)
    if ([string]::IsNullOrEmpty($Text)) { return $Text }
    $t = [regex]::Replace($Text, '(?i)((?:postgres(?:ql)?|mysql|mongodb(?:\+srv)?)://[^:/@\s"'']+:)[^@\s"'']+@', '${1}****@')
    $t = [regex]::Replace($t, '(?i)\b((?:[A-Z0-9_]*(?:PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)\s*[=:]\s*)("[^"]*"|''[^'']*''|\S+)', '${1}****')
    return $t
}

function Write-OrVipLog {
    param([string]$Level, [AllowNull()][string]$Text)
    if (-not $script:LogFile) { return }
    $line = '{0} [{1}] {2}{3}' -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Level, (Protect-OrVipSecret $Text), [Environment]::NewLine
    try { [System.IO.File]::AppendAllText($script:LogFile, $line, (New-Object System.Text.UTF8Encoding $false)) } catch { }
}

function Add-OrVipWarning {
    param([string]$Text)
    [void]$script:Warnings.Add($Text)
    Write-OrVipLog 'WARN' $Text
}

<# Returns @{ en = '...'; ar = '...' } for a message key, with {placeholders} filled in. #>
function Get-OrVipText {
    param([string]$Key, [hashtable]$Params = @{})
    $entry = $null
    if ($script:Messages) {
        $prop = $script:Messages.PSObject.Properties[$Key]
        if ($prop) { $entry = $prop.Value }
    }
    if (-not $entry) { return @{ en = $Key; ar = $Key } }
    $en = [string]$entry.en
    $ar = [string]$entry.ar
    foreach ($k in $Params.Keys) {
        $v = Protect-OrVipSecret ([string]$Params[$k])
        $en = $en.Replace('{' + $k + '}', $v)
        $ar = $ar.Replace('{' + $k + '}', $v)
    }
    return @{ en = $en; ar = $ar }
}

<# Throws a launcher failure that the UI turns into a bilingual message and an exit code. #>
function Throw-OrVip {
    param([string]$Key, [string]$Exit = 'Unexpected', [hashtable]$Params = @{}, [string]$Detail = '')
    $text = Get-OrVipText $Key $Params
    $ex = New-Object System.Exception ($text.en)
    $ex.Data['OrVipKey'] = $Key
    $ex.Data['OrVipExit'] = $Exit
    $ex.Data['OrVipParams'] = $Params
    $ex.Data['OrVipDetail'] = (Protect-OrVipSecret $Detail)
    Write-OrVipLog 'ERROR' ('{0}: {1} {2}' -f $Key, $text.en, $Detail)
    throw $ex
}

<# Converts any exception into @{ Key; ExitCode; Text = @{en;ar}; Detail }. #>
function Resolve-OrVipFailure {
    param($ErrorRecord)
    $ex = $ErrorRecord
    if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { $ex = $ErrorRecord.Exception }
    while ($ex -and -not $ex.Data.Contains('OrVipKey') -and $ex.InnerException) { $ex = $ex.InnerException }
    if ($ex -and $ex.Data.Contains('OrVipKey')) {
        $exitName = [string]$ex.Data['OrVipExit']
        return @{
            Key = [string]$ex.Data['OrVipKey']; ExitCode = $script:ExitCodes[$exitName]
            Text = (Get-OrVipText ([string]$ex.Data['OrVipKey']) $ex.Data['OrVipParams']); Detail = [string]$ex.Data['OrVipDetail']
        }
    }
    $message = if ($ErrorRecord -is [System.Management.Automation.ErrorRecord]) { "$ErrorRecord" + ' @ ' + $ErrorRecord.InvocationInfo.PositionMessage } else { "$ErrorRecord" }
    Write-OrVipLog 'ERROR' ('unexpected: ' + $message)
    return @{ Key = 'error.unexpected'; ExitCode = $script:ExitCodes.Unexpected; Text = (Get-OrVipText 'error.unexpected' @{ detail = "$ErrorRecord" }); Detail = '' }
}

# --------------------------------------------------------------------------------------------
# Waiting and external commands (never block the window; always bounded by a timeout)
# --------------------------------------------------------------------------------------------

function Invoke-OrVipPump { if ($script:Pump) { & $script:Pump } }

function Wait-OrVip {
    param([int]$Milliseconds)
    $until = (Get-Date).AddMilliseconds($Milliseconds)
    do { Invoke-OrVipPump; Start-Sleep -Milliseconds 100 } while ((Get-Date) -lt $until)
}

function ConvertTo-OrVipArgument {
    param([string]$Value)
    if ($Value -eq '') { return '""' }
    if ($Value -match '[\s"]') { return '"' + $Value.Replace('"', '\"') + '"' }
    return $Value
}

function Stop-OrVipProcessTree {
    param([int]$ProcessId)
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    # Windows PowerShell 5.1 turns a native program's error output into a terminating error when
    # $ErrorActionPreference is Stop; "process not found" (already ended) is fine here.
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { & $taskkill /PID $ProcessId /T /F *> $null } finally { $ErrorActionPreference = $old }
}

<#
  Runs a console program hidden, with its output appended to .orvip\logs\<LogName>.log, and
  waits for it with a timeout while keeping the window responsive. Extra environment variables
  (for example a new admin password) go to that process only and are never written anywhere.
  Returns @{ ExitCode; Output } (Output is this run's text, secrets masked).
#>
function Invoke-OrVipCommand {
    param(
        [Parameter(Mandatory)][string]$FilePath,
        [string[]]$Arguments = @(),
        [string]$LogName = 'commands',
        [int]$TimeoutSec = 300,
        [hashtable]$Environment = @{},
        [string]$WorkingDirectory = $script:Root,
        # Binary-safe: standard output goes to this file and only error output to the log.
        [string]$StdoutFile = ''
    )
    $runLog = Join-Path $script:LogDir ('run-{0}.tmp' -f ([guid]::NewGuid().ToString('N')))
    $argText = ($Arguments | ForEach-Object { ConvertTo-OrVipArgument $_ }) -join ' '
    if ($StdoutFile) { $inner = '"{0}" {1} 1>"{2}" 2>"{3}"' -f $FilePath, $argText, $StdoutFile, $runLog }
    else { $inner = '"{0}" {1} 1>"{2}" 2>&1' -f $FilePath, $argText, $runLog }
    Write-OrVipLog 'INFO' ('run: {0} {1}' -f [System.IO.Path]::GetFileName($FilePath), $argText)

    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\cmd.exe'
    $psi.Arguments = '/d /s /c "' + $inner + '"'
    $psi.WorkingDirectory = $WorkingDirectory
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    foreach ($k in $Environment.Keys) { $psi.EnvironmentVariables[$k] = [string]$Environment[$k] }
    $p = [System.Diagnostics.Process]::Start($psi)

    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $timedOut = $false
    while (-not $p.HasExited) {
        if ((Get-Date) -gt $deadline) { $timedOut = $true; Stop-OrVipProcessTree $p.Id; break }
        Invoke-OrVipPump
        Start-Sleep -Milliseconds 150
    }
    $p.WaitForExit(5000) | Out-Null
    $output = ''
    if (Test-Path -LiteralPath $runLog) {
        $output = Protect-OrVipSecret ([System.IO.File]::ReadAllText($runLog))
        Remove-Item -LiteralPath $runLog -Force -ErrorAction SilentlyContinue
    }
    $logPath = Join-Path $script:LogDir ($LogName + '.log')
    $header = '==== {0} {1} {2}{3}' -f (Get-Date -Format 's'), [System.IO.Path]::GetFileName($FilePath), $argText, [Environment]::NewLine
    [System.IO.File]::AppendAllText($logPath, $header + $output + [Environment]::NewLine, (New-Object System.Text.UTF8Encoding $false))
    $code = if ($timedOut) { -1 } else { $p.ExitCode }
    Write-OrVipLog 'INFO' ('exit {0}{1}' -f $code, $(if ($timedOut) { ' (timed out after ' + $TimeoutSec + ' s)' } else { '' }))
    return @{ ExitCode = $code; Output = $output; TimedOut = $timedOut }
}

function Get-OrVipLastLines {
    param([string]$Text, [int]$Count = 12)
    if (-not $Text) { return '' }
    $lines = $Text -split "`r?`n" | Where-Object { $_.Trim() -ne '' }
    return (($lines | Select-Object -Last $Count) -join [Environment]::NewLine)
}

# --------------------------------------------------------------------------------------------
# Configuration (.orvip\config.json) and the .env file
# --------------------------------------------------------------------------------------------

function Get-OrVipConfig {
    $config = @{
        databaseMode = 'auto'        # auto | docker | external
        appPort = 3000
        listenOnNetwork = $false     # true: other computers on the network can open OR VIP
        composeProject = $null       # remembered so moving the folder keeps the same data volume
        dockerTimeoutSec = 240
        databaseTimeoutSec = 90
        serverTimeoutSec = 120
        dependencyTimeoutSec = 1200
        buildTimeoutSec = 1500
    }
    if (Test-Path -LiteralPath $script:ConfigFile) {
        try {
            $saved = [System.IO.File]::ReadAllText($script:ConfigFile) | ConvertFrom-Json
            foreach ($p in $saved.PSObject.Properties) { $config[$p.Name] = $p.Value }
        } catch { Add-OrVipWarning ('Ignoring an unreadable .orvip\config.json: ' + $_.Exception.Message) }
    }
    if ($env:ORVIP_DATABASE_MODE) { $config.databaseMode = $env:ORVIP_DATABASE_MODE }
    if ($env:ORVIP_APP_PORT) { $config.appPort = [int]$env:ORVIP_APP_PORT }
    $config.appPort = [int]$config.appPort
    return $config
}

function Save-OrVipConfig {
    param([hashtable]$Config)
    $json = $Config | ConvertTo-Json -Depth 4
    [System.IO.File]::WriteAllText($script:ConfigFile, $json, (New-Object System.Text.UTF8Encoding $false))
}

<# Reads KEY=value / KEY="value" lines; comments and blank lines are ignored. #>
function Read-OrVipEnvFile {
    param([string]$Path = (Join-Path $script:Root '.env'))
    $values = @{}
    foreach ($raw in [System.IO.File]::ReadAllLines($Path)) {
        $line = $raw.Trim()
        if ($line -eq '' -or $line.StartsWith('#')) { continue }
        if ($line.StartsWith('export ')) { $line = $line.Substring(7).Trim() }
        $eq = $line.IndexOf('=')
        if ($eq -lt 1) { continue }
        $key = $line.Substring(0, $eq).Trim()
        $value = $line.Substring($eq + 1).Trim()
        if ($value.Length -ge 2 -and (($value.StartsWith('"') -and $value.EndsWith('"')) -or ($value.StartsWith("'") -and $value.EndsWith("'")))) {
            $value = $value.Substring(1, $value.Length - 2)
        } else {
            $hash = $value.IndexOf(' #')
            if ($hash -ge 0) { $value = $value.Substring(0, $hash).Trim() }
        }
        $values[$key] = $value
    }
    return $values
}

<#
  Parses a PostgreSQL connection string. Returns @{ Valid; Problem; User; Password; Host; Port;
  Database; Masked; IsLocal }. The password is only kept in memory and never shown (Masked).
#>
function ConvertFrom-OrVipDatabaseUrl {
    param([AllowNull()][string]$Url)
    $r = @{ Valid = $false; Problem = ''; User = ''; Password = ''; Host = ''; Port = 5432; Database = ''; Masked = ''; IsLocal = $false }
    if ([string]::IsNullOrWhiteSpace($Url)) { $r.Problem = 'DATABASE_URL is empty'; return $r }
    if ($Url -notmatch '^(?i)postgres(ql)?://') { $r.Problem = 'DATABASE_URL must start with postgresql://'; return $r }
    $m = [regex]::Match($Url, '^(?i)postgres(?:ql)?://(?:(?<user>[^:@/]*)(?::(?<pass>[^@]*))?@)?(?<host>\[[^\]]+\]|[^:/?]+)(?::(?<port>[^/?]*))?(?:/(?<db>[^?]*))?(?:\?.*)?$')
    if (-not $m.Success) { $r.Problem = 'DATABASE_URL is not a valid connection string'; return $r }
    $r.User = [uri]::UnescapeDataString($m.Groups['user'].Value)
    $r.Password = [uri]::UnescapeDataString($m.Groups['pass'].Value)
    $r.Host = $m.Groups['host'].Value
    $portText = $m.Groups['port'].Value
    if ($portText -ne '') {
        $port = 0
        if (-not [int]::TryParse($portText, [ref]$port) -or $port -lt 1 -or $port -gt 65535) { $r.Problem = 'the port in DATABASE_URL is not a number between 1 and 65535'; return $r }
        $r.Port = $port
    }
    $r.Database = [uri]::UnescapeDataString($m.Groups['db'].Value)
    if ($r.User -eq '') { $r.Problem = 'DATABASE_URL has no user name'; return $r }
    if ($r.Database -eq '') { $r.Problem = 'DATABASE_URL has no database name'; return $r }
    $r.IsLocal = @('localhost', '127.0.0.1', '[::1]', '::1') -contains $r.Host.ToLowerInvariant()
    $r.Masked = 'postgresql://{0}:****@{1}:{2}/{3}' -f $r.User, $r.Host, $r.Port, $r.Database
    $r.Valid = $true
    return $r
}

<# Validates .env; returns @{ Env; Db }. Throws error.envMissing / error.envInvalid. #>
function Test-OrVipEnvironment {
    $path = Join-Path $script:Root '.env'
    if (-not (Test-Path -LiteralPath $path)) { Throw-OrVip 'error.envMissing' 'Environment' }
    $envValues = Read-OrVipEnvFile $path
    if (-not $envValues.ContainsKey('DATABASE_URL')) { Throw-OrVip 'error.envInvalid' 'Environment' @{ detail = 'DATABASE_URL is missing' } }
    $db = ConvertFrom-OrVipDatabaseUrl $envValues['DATABASE_URL']
    if (-not $db.Valid) { Throw-OrVip 'error.envInvalid' 'Environment' @{ detail = $db.Problem } }
    if ($envValues.ContainsKey('APP_URL') -and $envValues['APP_URL'] -notmatch '^https?://') {
        Throw-OrVip 'error.envInvalid' 'Environment' @{ detail = 'APP_URL must start with http:// or https://' }
    }
    Write-OrVipLog 'INFO' ('database: ' + $db.Masked)
    return @{ Env = $envValues; Db = $db }
}

<# The user, password and database of the bundled PostgreSQL container (docker-compose.yml). #>
function Get-OrVipComposeDatabase {
    $file = Join-Path $script:Root 'docker-compose.yml'
    $r = @{ Exists = $false; User = 'ims'; Password = ''; Database = 'installation_manager'; Port = 5433 }
    if (-not (Test-Path -LiteralPath $file)) { return $r }
    $r.Exists = $true
    $text = [System.IO.File]::ReadAllText($file)
    $u = [regex]::Match($text, '(?m)^\s*POSTGRES_USER:\s*"?([^"\r\n]+?)"?\s*$'); if ($u.Success) { $r.User = $u.Groups[1].Value }
    $p = [regex]::Match($text, '(?m)^\s*POSTGRES_PASSWORD:\s*"?([^"\r\n]+?)"?\s*$'); if ($p.Success) { $r.Password = $p.Groups[1].Value }
    $d = [regex]::Match($text, '(?m)^\s*POSTGRES_DB:\s*"?([^"\r\n]+?)"?\s*$'); if ($d.Success) { $r.Database = $d.Groups[1].Value }
    $port = [regex]::Match($text, 'IMS_DB_PORT:-(\d+)'); if ($port.Success) { $r.Port = [int]$port.Groups[1].Value }
    if ($env:IMS_DB_PORT) { $r.Port = [int]$env:IMS_DB_PORT }
    return $r
}

<# docker: the bundled PostgreSQL container; external: a PostgreSQL server you run yourself. #>
function Resolve-OrVipDatabaseMode {
    param([hashtable]$Config, [hashtable]$Db)
    $mode = [string]$Config.databaseMode
    if ($mode -eq 'docker' -or $mode -eq 'external') { return $mode }
    $compose = Get-OrVipComposeDatabase
    if ($compose.Exists -and $Db.IsLocal) { return 'docker' }
    return 'external'
}

# --------------------------------------------------------------------------------------------
# Step A - requirements
# --------------------------------------------------------------------------------------------

function Get-OrVipWindowsInfo {
    $v = [Environment]::OSVersion.Version
    $caption = 'Windows'
    try { $caption = (Get-CimInstance Win32_OperatingSystem -ErrorAction Stop).Caption } catch { }
    return @{ Caption = $caption; Build = $v.Build; Version = $v; Text = ('{0} (build {1})' -f $caption, $v.Build) }
}

function Find-OrVipTool {
    param([string]$Name)
    $cmd = Get-Command $Name -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($cmd) { return $cmd.Path }
    return $null
}

function Get-OrVipNode {
    $node = Find-OrVipTool 'node.exe'
    if (-not $node) {
        foreach ($c in @((Join-Path $env:ProgramFiles 'nodejs\node.exe'), (Join-Path ${env:ProgramFiles(x86)} 'nodejs\node.exe'))) {
            if ($c -and (Test-Path -LiteralPath $c)) { $node = $c; break }
        }
    }
    if (-not $node) { return $null }
    $old = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try { $versionText = [string](& $node -v 2>$null | Select-Object -First 1) } finally { $ErrorActionPreference = $old }
    $version = $null
    if ($versionText -match 'v?(\d+\.\d+\.\d+)') { $version = [version]$Matches[1] }
    $npm = Join-Path (Split-Path $node -Parent) 'npm.cmd'
    if (-not (Test-Path -LiteralPath $npm)) { $npm = Find-OrVipTool 'npm.cmd' }
    return @{ Node = $node; Version = $version; VersionText = $versionText; Npm = $npm }
}

<#
  Checks everything that does not change state. Returns @{ Windows; Node; Env; Db; Config; Mode }.
  With -NoThrow it returns @{ Problems = @(...) } style results for the setup and check scripts.
#>
function Test-OrVipRequirements {
    $win = Get-OrVipWindowsInfo
    Write-OrVipLog 'INFO' ('windows: ' + $win.Text)
    if ($win.Build -lt 19041) { Throw-OrVip 'error.windowsVersion' 'Requirements' @{ version = $win.Text } }

    $node = Get-OrVipNode
    if (-not $node) { Throw-OrVip 'error.nodeMissing' 'Requirements' }
    Write-OrVipLog 'INFO' ('node: {0} ({1})' -f $node.VersionText, $node.Node)
    if (-not $node.Version -or $node.Version -lt [version]'20.9.0') { Throw-OrVip 'error.nodeOld' 'Requirements' @{ version = $node.VersionText } }
    if (-not $node.Npm) { Throw-OrVip 'error.npmMissing' 'Requirements' }

    foreach ($f in @('package.json', 'package-lock.json', 'prisma\schema.prisma', 'next.config.ts')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:Root $f))) { Throw-OrVip 'error.projectMissing' 'Requirements' @{ path = $script:Root } }
    }

    $environment = Test-OrVipEnvironment
    $config = Get-OrVipConfig
    $mode = Resolve-OrVipDatabaseMode $config $environment.Db
    Write-OrVipLog 'INFO' ('database mode: ' + $mode + ', app port: ' + $config.appPort)
    return @{ Windows = $win; Node = $node; Env = $environment.Env; Db = $environment.Db; Config = $config; Mode = $mode }
}

# --------------------------------------------------------------------------------------------
# Step B - Docker Desktop and the PostgreSQL container
# --------------------------------------------------------------------------------------------

function Get-OrVipDockerDesktopPath {
    $candidates = @()
    foreach ($base in @($env:ProgramFiles, $env:ProgramW6432, $env:LOCALAPPDATA)) {
        if ($base) { $candidates += (Join-Path $base 'Docker\Docker\Docker Desktop.exe') }
    }
    foreach ($c in $candidates) { if (Test-Path -LiteralPath $c) { return $c } }
    return $null
}

function Get-OrVipDockerCli {
    $cli = Find-OrVipTool 'docker.exe'
    if ($cli) { return $cli }
    foreach ($base in @($env:ProgramFiles, $env:ProgramW6432)) {
        if ($base) {
            $c = Join-Path $base 'Docker\Docker\resources\bin\docker.exe'
            if (Test-Path -LiteralPath $c) { return $c }
        }
    }
    return $null
}

<# 'linux' / 'windows' when the Docker engine answers, otherwise $null. #>
function Get-OrVipDockerEngine {
    param([string]$Cli)
    $r = Invoke-OrVipCommand -FilePath $Cli -Arguments @('info', '--format', '{{.OSType}}') -LogName 'docker' -TimeoutSec 25
    if ($r.ExitCode -eq 0) {
        $m = [regex]::Match($r.Output, '(?im)^\s*(linux|windows)\s*$')
        if ($m.Success) { return $m.Groups[1].Value.ToLowerInvariant() }
    }
    return $null
}

function Start-OrVipDocker {
    param([hashtable]$Config, [scriptblock]$Status = {})
    $cli = Get-OrVipDockerCli
    $desktop = Get-OrVipDockerDesktopPath
    if (-not $cli -and -not $desktop) { Throw-OrVip 'error.dockerMissing' 'Docker' }
    if (-not $cli) { $cli = Join-Path (Split-Path $desktop -Parent) 'resources\bin\docker.exe' }

    $engine = Get-OrVipDockerEngine $cli
    if (-not $engine) {
        if (-not $desktop) { Throw-OrVip 'error.dockerMissing' 'Docker' }
        if (-not (Get-Process -Name 'Docker Desktop' -ErrorAction SilentlyContinue)) {
            Write-OrVipLog 'INFO' 'starting Docker Desktop'
            Start-Process -FilePath $desktop | Out-Null
        }
        & $Status 'status.waitingDocker'
        $deadline = (Get-Date).AddSeconds([int]$Config.dockerTimeoutSec)
        while (-not $engine) {
            if ((Get-Date) -gt $deadline) { Throw-OrVip 'error.dockerTimeout' 'Docker' @{ seconds = $Config.dockerTimeoutSec } }
            Wait-OrVip 3000
            $engine = Get-OrVipDockerEngine $cli
        }
    }
    if ($engine -ne 'linux') { Throw-OrVip 'error.dockerWindowsContainers' 'Docker' }
    $compose = Invoke-OrVipCommand -FilePath $cli -Arguments @('compose', 'version') -LogName 'docker' -TimeoutSec 30
    if ($compose.ExitCode -ne 0) { Throw-OrVip 'error.composeMissing' 'Docker' }
    Write-OrVipLog 'INFO' ('docker engine ready (' + $engine + ')')
    return $cli
}

<# Docker Compose's own project name for this folder (it names the data volume <project>_pgdata). #>
function Get-OrVipComposeProject {
    param([hashtable]$Config)
    if ($Config.composeProject) { return [string]$Config.composeProject }
    $name = (Split-Path $script:Root -Leaf).ToLowerInvariant() -replace '[^a-z0-9_-]', ''
    if ($name -eq '' -or $name -notmatch '^[a-z0-9]') { $name = 'orvip' + $name }
    $Config.composeProject = $name
    Save-OrVipConfig $Config
    Write-OrVipLog 'INFO' ('compose project remembered: ' + $name)
    return $name
}

function Test-OrVipTcpPort {
    param([string]$HostName, [int]$Port, [int]$TimeoutMs = 1500)
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $h = $HostName.Trim('[', ']')
        $async = $client.BeginConnect($h, $Port, $null, $null)
        if (-not $async.AsyncWaitHandle.WaitOne($TimeoutMs)) { return $false }
        $client.EndConnect($async)
        return $true
    } catch { return $false } finally { $client.Close() }
}

<# Starts (never re-creates) the bundled PostgreSQL container and waits until it answers. #>
function Start-OrVipDatabaseContainer {
    param([string]$Cli, [hashtable]$Config, [hashtable]$Db, [scriptblock]$Status = {})
    $project = Get-OrVipComposeProject $Config
    $base = @('compose', '-p', $project)
    $up = Invoke-OrVipCommand -FilePath $Cli -Arguments ($base + @('up', '-d', 'db')) -LogName 'docker' -TimeoutSec 600
    if ($up.ExitCode -ne 0) {
        $compose = Get-OrVipComposeDatabase
        if ($up.Output -match '(?i)port is already allocated|address already in use|bind:|Only one usage of each socket') {
            Throw-OrVip 'error.databasePortBusy' 'Database' @{ port = $compose.Port } (Get-OrVipLastLines $up.Output 4)
        }
        Throw-OrVip 'error.databaseStart' 'Database' @{ detail = (Get-OrVipLastLines $up.Output 3) } $up.Output
    }

    $portResult = Invoke-OrVipCommand -FilePath $Cli -Arguments ($base + @('port', 'db', '5432')) -LogName 'docker' -TimeoutSec 30
    $published = [regex]::Match($portResult.Output, ':(\d+)\s*$', 'Multiline')
    if ($published.Success) {
        $dockerPort = [int]$published.Groups[1].Value
        Write-OrVipLog 'INFO' ('database container published on port ' + $dockerPort)
        if ($Db.IsLocal -and $Db.Port -ne $dockerPort) {
            Throw-OrVip 'error.databasePortMismatch' 'Database' @{ urlPort = $Db.Port; dockerPort = $dockerPort }
        }
    }

    & $Status 'status.waitingDatabase'
    $deadline = (Get-Date).AddSeconds([int]$Config.databaseTimeoutSec)
    while ($true) {
        $ready = Invoke-OrVipCommand -FilePath $Cli -Arguments ($base + @('exec', '-T', 'db', 'pg_isready', '-U', $Db.User, '-d', $Db.Database)) -LogName 'docker' -TimeoutSec 20
        if ($ready.ExitCode -eq 0 -and (Test-OrVipTcpPort $Db.Host $Db.Port)) { break }
        if ((Get-Date) -gt $deadline) {
            Throw-OrVip 'error.databaseTimeout' 'Database' @{ seconds = $Config.databaseTimeoutSec; target = ('{0}:{1}' -f $Db.Host, $Db.Port) }
        }
        Wait-OrVip 2000
    }
    Write-OrVipLog 'INFO' 'database container is accepting connections'
    return $project
}

<# An external PostgreSQL server: only wait until its port answers. #>
function Wait-OrVipExternalDatabase {
    param([hashtable]$Config, [hashtable]$Db, [scriptblock]$Status = {})
    & $Status 'status.waitingDatabase'
    $deadline = (Get-Date).AddSeconds([int]$Config.databaseTimeoutSec)
    while (-not (Test-OrVipTcpPort $Db.Host $Db.Port)) {
        if ((Get-Date) -gt $deadline) {
            Throw-OrVip 'error.databaseTimeout' 'Database' @{ seconds = $Config.databaseTimeoutSec; target = ('{0}:{1}' -f $Db.Host, $Db.Port) }
        }
        Wait-OrVip 2000
    }
    Write-OrVipLog 'INFO' ('external database answers at {0}:{1}' -f $Db.Host, $Db.Port)
}

# --------------------------------------------------------------------------------------------
# Step C - dependencies (npm ci only when node_modules is missing or out of date)
# --------------------------------------------------------------------------------------------

function Get-OrVipDependencyStamp {
    param([hashtable]$Node)
    $lock = (Get-FileHash -LiteralPath (Join-Path $script:Root 'package-lock.json') -Algorithm SHA256).Hash
    return ('{0}|node{1}' -f $lock, $Node.Version.Major)
}

function Test-OrVipKeyModules {
    foreach ($f in @('node_modules\next\dist\bin\next', 'node_modules\prisma\build\index.js', 'node_modules\.prisma\client\index.js', 'node_modules\@prisma\client\package.json')) {
        if (-not (Test-Path -LiteralPath (Join-Path $script:Root $f))) { return $false }
    }
    return $true
}

<# Returns 'current' or 'installed'. Throws error.dependencies / error.dependenciesInUse. #>
function Update-OrVipDependencies {
    param([hashtable]$Node, [hashtable]$Config, [scriptblock]$Status = {})
    $stampFile = Join-Path $script:StateDir 'dependencies.stamp'
    $want = Get-OrVipDependencyStamp $Node
    $have = if (Test-Path -LiteralPath $stampFile) { [System.IO.File]::ReadAllText($stampFile).Trim() } else { '' }
    $modules = Join-Path $script:Root 'node_modules'

    if ((Test-Path -LiteralPath $modules) -and (Test-OrVipKeyModules)) {
        if ($have -eq $want) { Write-OrVipLog 'INFO' 'dependencies are current (skipped npm ci)'; return 'current' }
        if ($have -eq '') {
            # First run of the launcher on an existing install: accept it if npm agrees it matches.
            $ls = Invoke-OrVipCommand -FilePath $Node.Npm -Arguments @('ls', '--depth=0') -LogName 'npm' -TimeoutSec 120
            if ($ls.ExitCode -eq 0) {
                [System.IO.File]::WriteAllText($stampFile, $want)
                Write-OrVipLog 'INFO' 'existing node_modules matches package.json (skipped npm ci)'
                return 'current'
            }
        }
    }

    & $Status 'status.installingDependencies'
    $ci = Invoke-OrVipCommand -FilePath $Node.Npm -Arguments @('ci', '--no-audit', '--no-fund') -LogName 'npm' -TimeoutSec ([int]$Config.dependencyTimeoutSec)
    if ($ci.ExitCode -ne 0) {
        if ($ci.Output -match '(?i)\bEPERM\b|\bEBUSY\b|operation not permitted|resource busy') {
            Throw-OrVip 'error.dependenciesInUse' 'Dependencies' @{} (Get-OrVipLastLines $ci.Output 6)
        }
        Throw-OrVip 'error.dependencies' 'Dependencies' @{} (Get-OrVipLastLines $ci.Output 8)
    }
    if (-not (Test-Path -LiteralPath (Join-Path $script:Root 'node_modules\.prisma\client\index.js'))) {
        $gen = Invoke-OrVipPrisma $Node @('generate') 'npm' 300
        if ($gen.ExitCode -ne 0) { Throw-OrVip 'error.dependencies' 'Dependencies' @{} (Get-OrVipLastLines $gen.Output 8) }
    }
    if (-not (Test-OrVipKeyModules)) { Throw-OrVip 'error.dependencies' 'Dependencies' @{} 'key modules missing after npm ci' }
    [System.IO.File]::WriteAllText($stampFile, $want)
    return 'installed'
}

# --------------------------------------------------------------------------------------------
# Step D - database migrations (forward-only, after a backup, only when pending)
# --------------------------------------------------------------------------------------------

function Invoke-OrVipPrisma {
    param([hashtable]$Node, [string[]]$Arguments, [string]$LogName = 'migrations', [int]$TimeoutSec = 300)
    $cli = Join-Path $script:Root 'node_modules\prisma\build\index.js'
    return Invoke-OrVipCommand -FilePath $Node.Node -Arguments (@($cli) + $Arguments) -LogName $LogName -TimeoutSec $TimeoutSec
}

<# Classifies `prisma migrate status` output: UpToDate | Pending | NeedsAttention | Auth | Missing | Unreachable | Unknown #>
function Get-OrVipMigrationState {
    param([string]$Output, [int]$ExitCode)
    if ($Output -match '(?i)\bP1000\b|Authentication failed|password authentication failed') { return 'Auth' }
    if ($Output -match '(?i)\bP1003\b|Database .* does not exist') { return 'Missing' }
    if ($Output -match "(?i)\bP1001\b|Can't reach database server|\bP1002\b|timed out") { return 'Unreachable' }
    if ($Output -match '(?i)\bP3009\b|failed migrations?|migrations? .*failed|drift|have been modified|is not in sync|was modified after it was applied|not found locally') { return 'NeedsAttention' }
    if ($Output -match '(?i)not yet been applied|have not been applied|No migration found in prisma/migrations|database is empty') { return 'Pending' }
    if ($ExitCode -eq 0 -and $Output -match '(?i)Database schema is up to date') { return 'UpToDate' }
    return 'Unknown'
}

function Backup-OrVipDatabase {
    param([string]$Mode, [string]$DockerCli, [string]$Project, [hashtable]$Db, [hashtable]$Node)
    $file = Join-Path $script:BackupDir ('before-migrate-{0}.dump' -f (Get-Date -Format 'yyyyMMdd-HHmmss'))
    if ($Mode -eq 'docker') {
        # pg_dump inside the container writes to its standard output, which cmd.exe saves to the
        # file byte for byte.
        $dump = Invoke-OrVipCommand -FilePath $DockerCli -Arguments @('compose', '-p', $Project, 'exec', '-T', 'db', 'pg_dump', '-U', $Db.User, '-d', $Db.Database, '-Fc') -LogName 'backup' -TimeoutSec 1800 -StdoutFile $file
        if ($dump.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $file) -or (Get-Item -LiteralPath $file).Length -eq 0) {
            Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue
            Throw-OrVip 'error.backupFailed' 'Migrations' @{} (Get-OrVipLastLines $dump.Output 6)
        }
    } else {
        $pgDump = Find-OrVipTool 'pg_dump.exe'
        if (-not $pgDump) {
            Add-OrVipWarning 'pg_dump.exe was not found, so no automatic backup was taken before the database update (external database mode).'
            return $null
        }
        $dumpArgs = @('-h', $Db.Host.Trim('[', ']'), '-p', [string]$Db.Port, '-U', $Db.User, '-d', $Db.Database, '-Fc', '-f', $file)
        $dump = Invoke-OrVipCommand -FilePath $pgDump -Arguments $dumpArgs -LogName 'backup' -TimeoutSec 1800 -Environment @{ PGPASSWORD = $Db.Password }
        if ($dump.ExitCode -ne 0) { Throw-OrVip 'error.backupFailed' 'Migrations' @{} (Get-OrVipLastLines $dump.Output 6) }
    }
    Write-OrVipLog 'INFO' ('backup written: ' + $file)
    # Keep the ten most recent backups.
    Get-ChildItem -LiteralPath $script:BackupDir -Filter 'before-migrate-*.dump' | Sort-Object LastWriteTime -Descending |
        Select-Object -Skip 10 | Remove-Item -Force -ErrorAction SilentlyContinue
    return $file
}

<# Returns 'current' or 'migrated'. Never resets, never seeds. #>
function Update-OrVipDatabase {
    param([hashtable]$Node, [string]$Mode, [string]$DockerCli, [string]$Project, [hashtable]$Db, [scriptblock]$Status = {})
    $statusRun = Invoke-OrVipPrisma $Node @('migrate', 'status') 'migrations' 180
    $state = Get-OrVipMigrationState $statusRun.Output $statusRun.ExitCode
    Write-OrVipLog 'INFO' ('migration state: ' + $state)
    switch ($state) {
        'UpToDate' { return 'current' }
        'Auth' { Throw-OrVip 'error.databaseAuth' 'Database' }
        'Missing' { Throw-OrVip 'error.databaseMissing' 'Database' }
        'Unreachable' { Throw-OrVip 'error.databaseTimeout' 'Database' @{ seconds = 30; target = ('{0}:{1}' -f $Db.Host, $Db.Port) } (Get-OrVipLastLines $statusRun.Output 4) }
        'NeedsAttention' { Throw-OrVip 'error.migrationNeedsAttention' 'Migrations' @{} (Get-OrVipLastLines $statusRun.Output 10) }
        'Unknown' { Throw-OrVip 'error.migrationFailed' 'Migrations' @{} (Get-OrVipLastLines $statusRun.Output 10) }
    }
    & $Status 'status.backup'
    Backup-OrVipDatabase $Mode $DockerCli $Project $Db $Node | Out-Null
    & $Status 'status.migrating'
    $deploy = Invoke-OrVipPrisma $Node @('migrate', 'deploy') 'migrations' 900
    if ($deploy.ExitCode -ne 0) { Throw-OrVip 'error.migrationFailed' 'Migrations' @{} (Get-OrVipLastLines $deploy.Output 10) }
    return 'migrated'
}

# --------------------------------------------------------------------------------------------
# Step E - production build and the application server
# --------------------------------------------------------------------------------------------

function Get-OrVipBuildFingerprint {
    $parts = New-Object System.Collections.ArrayList
    [void]$parts.Add((Get-FileHash -LiteralPath (Join-Path $script:Root 'package-lock.json') -Algorithm SHA256).Hash)
    $newest = 0L
    foreach ($dir in @('src', 'prisma', 'public')) {
        $path = Join-Path $script:Root $dir
        if (Test-Path -LiteralPath $path) {
            foreach ($f in Get-ChildItem -LiteralPath $path -Recurse -File -ErrorAction SilentlyContinue) {
                if ($f.LastWriteTimeUtc.Ticks -gt $newest) { $newest = $f.LastWriteTimeUtc.Ticks }
            }
        }
    }
    foreach ($name in @('package.json', 'next.config.ts', 'postcss.config.mjs', 'tsconfig.json')) {
        $f = Join-Path $script:Root $name
        if (Test-Path -LiteralPath $f) { $t = (Get-Item -LiteralPath $f).LastWriteTimeUtc.Ticks; if ($t -gt $newest) { $newest = $t } }
    }
    [void]$parts.Add([string]$newest)
    $head = Join-Path $script:Root '.git\HEAD'
    if (Test-Path -LiteralPath $head) { [void]$parts.Add([System.IO.File]::ReadAllText($head).Trim()) }
    return ($parts -join '|')
}

<# Builds the production app only when it is missing or the code changed. Returns 'current' or 'built'. #>
function Update-OrVipBuild {
    param([hashtable]$Node, [hashtable]$Config, [scriptblock]$Status = {})
    $stampFile = Join-Path $script:StateDir 'build.stamp'
    $want = Get-OrVipBuildFingerprint
    $have = if (Test-Path -LiteralPath $stampFile) { [System.IO.File]::ReadAllText($stampFile).Trim() } else { '' }
    if ($have -eq $want -and (Test-Path -LiteralPath (Join-Path $script:Root '.next\BUILD_ID'))) {
        Write-OrVipLog 'INFO' 'production build is current (skipped next build)'
        return 'current'
    }
    & $Status 'status.building'
    $next = Join-Path $script:Root 'node_modules\next\dist\bin\next'
    $attempt = 0
    while ($true) {
        $attempt++
        $build = Invoke-OrVipCommand -FilePath $Node.Node -Arguments @($next, 'build') -LogName 'build' -TimeoutSec ([int]$Config.buildTimeoutSec) -Environment @{ NEXT_TELEMETRY_DISABLED = '1' }
        if ($build.ExitCode -eq 0) { break }
        # Next.js stops the first build after it finds a security advisory for its own version and
        # asks for the same command again; the advisory is recorded as a warning for the admin.
        if ($attempt -eq 1 -and $build.Output -match 'SecurityFatalError') {
            Add-OrVipWarning 'Next.js reported a known security vulnerability in the installed version and recommends upgrading. See .orvip\logs\build.log.'
            continue
        }
        Throw-OrVip 'error.buildFailed' 'Build' @{} (Get-OrVipLastLines $build.Output 12)
    }
    [System.IO.File]::WriteAllText($stampFile, $want)
    return 'built'
}

function Get-OrVipProcess {
    param([int]$ProcessId)
    try { return Get-CimInstance Win32_Process -Filter ('ProcessId={0}' -f $ProcessId) -ErrorAction Stop } catch { return $null }
}

function Get-OrVipCreationTicks {
    param($Process)
    if (-not $Process -or -not $Process.CreationDate) { return '' }
    return [string]$Process.CreationDate.ToUniversalTime().Ticks
}

function Read-OrVipServerState {
    if (-not (Test-Path -LiteralPath $script:ServerStateFile)) { return $null }
    try { $s = [System.IO.File]::ReadAllText($script:ServerStateFile) | ConvertFrom-Json } catch { return $null }
    $h = @{}
    foreach ($p in $s.PSObject.Properties) { $h[$p.Name] = $p.Value }
    return $h
}

function Remove-OrVipServerState { Remove-Item -LiteralPath $script:ServerStateFile -Force -ErrorAction SilentlyContinue }

<#
  The server this launcher started, if it is still running. A process id is only trusted when the
  process with that id also has the same creation time (after a Windows restart ids are re-used).
  Returns @{ State; Pids = @(alive tracked ids) } or $null (and forgets a stale record).
#>
function Get-OrVipTrackedServer {
    $state = Read-OrVipServerState
    if (-not $state) { return $null }
    $alive = @()
    foreach ($pair in @(@($state.pid, $state.created), @($state.childPid, $state.childCreated))) {
        if (-not $pair[0]) { continue }
        $p = Get-OrVipProcess ([int]$pair[0])
        if ($p -and (Get-OrVipCreationTicks $p) -eq [string]$pair[1]) { $alive += [int]$pair[0] }
    }
    if ($alive.Count -eq 0) {
        Write-OrVipLog 'INFO' 'forgetting a stale server record (process no longer running, e.g. after a Windows restart)'
        Remove-OrVipServerState
        return $null
    }
    return @{ State = $state; Pids = $alive }
}

<# The process listening on a TCP port: @{ Pid; Name } or $null. #>
function Get-OrVipPortOwner {
    param([int]$Port)
    $ownerPid = $null
    if (Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue) {
        $c = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($c) { $ownerPid = [int]$c.OwningProcess }
    } else {
        $line = netstat -ano -p tcp | Select-String -Pattern (':{0}\s+\S+\s+LISTENING\s+(\d+)' -f $Port) | Select-Object -First 1
        if ($line) { $ownerPid = [int]$line.Matches[0].Groups[1].Value }
    }
    if (-not $ownerPid) { return $null }
    $name = 'unknown'
    $proc = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
    if ($proc) { $name = $proc.ProcessName + '.exe' }
    return @{ Pid = $ownerPid; Name = $name }
}

<# Whether a process id belongs to the tracked server tree (itself or one of its ancestors). #>
function Test-OrVipInTree {
    param([int]$ProcessId, [int[]]$TreeRoots)
    $current = $ProcessId
    for ($i = 0; $i -lt 6 -and $current; $i++) {
        if ($TreeRoots -contains $current) { return $true }
        $p = Get-OrVipProcess $current
        if (-not $p) { return $false }
        $current = [int]$p.ParentProcessId
    }
    return $false
}

<# GET /api/health: @{ Reachable; IsOrVip; DatabaseOk }. #>
function Get-OrVipHealth {
    param([int]$Port)
    $r = @{ Reachable = $false; IsOrVip = $false; DatabaseOk = $false }
    try {
        $req = [System.Net.HttpWebRequest]::Create(('http://127.0.0.1:{0}/api/health' -f $Port))
        $req.Proxy = $null
        $req.Timeout = 4000
        $req.ReadWriteTimeout = 4000
        try { $resp = $req.GetResponse() } catch [System.Net.WebException] { $resp = $_.Exception.Response }
        if (-not $resp) { return $r }
        $r.Reachable = $true
        $reader = New-Object System.IO.StreamReader ($resp.GetResponseStream())
        $body = $reader.ReadToEnd()
        $reader.Close(); $resp.Close()
        $json = $body | ConvertFrom-Json -ErrorAction Stop
        if ($json.app -eq 'or-vip-erp') { $r.IsOrVip = $true; $r.DatabaseOk = ($json.database -eq 'ok') }
    } catch { }
    return $r
}

function Get-OrVipUrl {
    param([hashtable]$Config)
    return ('http://localhost:{0}' -f $Config.appPort)
}

<#
  What is on the app port right now: 'ours' (tracked, healthy), 'ours-starting', 'foreign-orvip'
  (an OR VIP server started some other way), 'busy' (another program), or 'free'.
#>
function Get-OrVipServerSituation {
    param([hashtable]$Config)
    $tracked = Get-OrVipTrackedServer
    $owner = Get-OrVipPortOwner $Config.appPort
    $health = Get-OrVipHealth $Config.appPort
    $situation = 'free'
    if ($owner -or $health.Reachable) {
        if ($tracked -and $owner -and (Test-OrVipInTree $owner.Pid $tracked.Pids)) {
            $situation = if ($health.IsOrVip) { 'ours' } else { 'ours-starting' }
        } elseif ($health.IsOrVip) {
            $situation = 'foreign-orvip'
        } else {
            $situation = 'busy'
        }
    } elseif ($tracked) {
        $situation = 'ours-starting'
    }
    return @{ Situation = $situation; Tracked = $tracked; Owner = $owner; Health = $health }
}

function Start-OrVipServer {
    param([hashtable]$Node, [hashtable]$Config, [scriptblock]$Status = {})
    $entry = Join-Path $script:Root 'node_modules\next\dist\bin\next'
    # Diagnostics and automated tests can replace the server entry point (for example with a
    # script that fails on purpose); normal use never sets this.
    if ($env:ORVIP_SERVER_ENTRY) { $entry = $env:ORVIP_SERVER_ENTRY }
    $listen = if ($Config.listenOnNetwork) { '0.0.0.0' } else { '127.0.0.1' }
    $log = Join-Path $script:LogDir 'server.log'
    $line = '==== {0} starting the application server on port {1}{2}' -f (Get-Date -Format 's'), $Config.appPort, [Environment]::NewLine
    [System.IO.File]::AppendAllText($log, $line, (New-Object System.Text.UTF8Encoding $false))
    $inner = '"{0}" "{1}" start -p {2} -H {3} 1>>"{4}" 2>&1' -f $Node.Node, $entry, $Config.appPort, $listen, $log

    # Started through the Windows shell (Start-Process) on purpose: unlike Process.Start with
    # UseShellExecute=false, it does not hand the launcher's own handles (console, pipes) to the
    # long-running server, so the server is fully independent of the launcher window and of any
    # program that is reading the launcher's output. The server inherits these two variables.
    $saved = @{ NODE_ENV = $env:NODE_ENV; NEXT_TELEMETRY_DISABLED = $env:NEXT_TELEMETRY_DISABLED }
    $env:NODE_ENV = 'production'
    $env:NEXT_TELEMETRY_DISABLED = '1'
    try {
        $p = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -ArgumentList ('/d /s /c "' + $inner + '"') -WorkingDirectory $script:Root -WindowStyle Hidden -PassThru
    } finally {
        $env:NODE_ENV = $saved.NODE_ENV
        $env:NEXT_TELEMETRY_DISABLED = $saved.NEXT_TELEMETRY_DISABLED
    }
    $null = $p.Handle   # keep a handle so HasExited and ExitCode stay readable
    $self = Get-OrVipProcess $p.Id
    $state = @{ pid = $p.Id; created = (Get-OrVipCreationTicks $self); childPid = $null; childCreated = $null; port = $Config.appPort; startedAt = (Get-Date -Format 's') }

    # Remember the node.exe child too, in case the cmd.exe wrapper is ever closed on its own.
    for ($i = 0; $i -lt 20 -and -not $state.childPid; $i++) {
        $child = Get-CimInstance Win32_Process -Filter ('ParentProcessId={0}' -f $p.Id) -ErrorAction SilentlyContinue | Where-Object { $_.Name -ieq 'node.exe' } | Select-Object -First 1
        if ($child) { $state.childPid = [int]$child.ProcessId; $state.childCreated = Get-OrVipCreationTicks $child } else { Wait-OrVip 250 }
    }
    [System.IO.File]::WriteAllText($script:ServerStateFile, ($state | ConvertTo-Json), (New-Object System.Text.UTF8Encoding $false))
    Write-OrVipLog 'INFO' ('application server started: cmd pid {0}, node pid {1}' -f $state.pid, $state.childPid)

    & $Status 'status.waitingServer'
    $deadline = (Get-Date).AddSeconds([int]$Config.serverTimeoutSec)
    $databaseDownSince = $null
    while ($true) {
        if ($p.HasExited) {
            Remove-OrVipServerState
            $tail = Get-OrVipLastLines ([System.IO.File]::ReadAllText($log)) 15
            Throw-OrVip 'error.serverExited' 'ServerExited' @{} $tail
        }
        $health = Get-OrVipHealth $Config.appPort
        if ($health.IsOrVip -and $health.DatabaseOk) { break }
        if ($health.IsOrVip -and -not $health.DatabaseOk) {
            if (-not $databaseDownSince) { $databaseDownSince = Get-Date }
            if (((Get-Date) - $databaseDownSince).TotalSeconds -gt 20) { Throw-OrVip 'error.serverDatabase' 'ServerDatabase' }
        }
        if ((Get-Date) -gt $deadline) { Throw-OrVip 'error.serverTimeout' 'ServerTimeout' @{ seconds = $Config.serverTimeoutSec } }
        Wait-OrVip 1000
    }
    Write-OrVipLog 'INFO' 'application server is healthy'
    return $state
}

<#
  Stops only the server tree this launcher started. Returns 'stopped', 'not-running' or
  'not-ours' (an OR VIP server started some other way, which is left alone). Never touches the
  database.
#>
function Stop-OrVipServer {
    param([hashtable]$Config, [int]$TimeoutSec = 30)
    $tracked = Get-OrVipTrackedServer
    if (-not $tracked) {
        $health = Get-OrVipHealth $Config.appPort
        if ($health.IsOrVip) { Write-OrVipLog 'INFO' 'an OR VIP server not started by the launcher is running; left alone'; return 'not-ours' }
        return 'not-running'
    }
    foreach ($id in $tracked.Pids) {
        if (Get-Process -Id $id -ErrorAction SilentlyContinue) { Write-OrVipLog 'INFO' ('stopping process tree ' + $id); Stop-OrVipProcessTree $id }
    }
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ($true) {
        $still = @($tracked.Pids | Where-Object { Get-Process -Id $_ -ErrorAction SilentlyContinue })
        $owner = Get-OrVipPortOwner $Config.appPort
        $portOurs = $owner -and (Test-OrVipInTree $owner.Pid $tracked.Pids)
        if ($still.Count -eq 0 -and -not $portOurs) { break }
        if ((Get-Date) -gt $deadline) { Throw-OrVip 'error.stopFailed' 'Unexpected' @{ seconds = $TimeoutSec } }
        Wait-OrVip 500
    }
    Remove-OrVipServerState
    Write-OrVipLog 'INFO' 'application server stopped'
    return 'stopped'
}

# --------------------------------------------------------------------------------------------
# One launcher at a time
# --------------------------------------------------------------------------------------------

function Enter-OrVipLock {
    param([int]$TimeoutSec = 1800, [scriptblock]$OnWait = {})
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $hash = [BitConverter]::ToString($sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($script:Root.ToLowerInvariant()))).Replace('-', '').Substring(0, 16)
    $script:Mutex = New-Object System.Threading.Mutex($false, ('Local\ORVIP-Launcher-' + $hash))
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    $notified = $false
    while ($true) {
        try {
            if ($script:Mutex.WaitOne(300)) { return $true }
        } catch {
            # A launcher that was closed abruptly leaves an "abandoned" lock, which we now own.
            $inner = $_.Exception
            while ($inner -and -not ($inner -is [System.Threading.AbandonedMutexException])) { $inner = $inner.InnerException }
            if ($inner) { return $true }
            throw
        }
        if (-not $notified) { & $OnWait; $notified = $true; Write-OrVipLog 'INFO' 'another launcher is running; waiting for it' }
        if ((Get-Date) -gt $deadline) { return $false }
        Invoke-OrVipPump
    }
}

function Exit-OrVipLock {
    if ($script:Mutex) {
        try { $script:Mutex.ReleaseMutex() } catch { }
        $script:Mutex.Dispose()
        $script:Mutex = $null
    }
}

# --------------------------------------------------------------------------------------------
# The whole start sequence
# --------------------------------------------------------------------------------------------

$script:Steps = @('requirements', 'docker', 'database', 'dependencies', 'migrations', 'server', 'running')
function Get-OrVipSteps { $script:Steps }

<#
  Runs steps A-E. $Report is called as & $Report <step> <state> [<messageKey>] [<params>] with
  state = running | done | skipped | failed | info. Returns @{ Url; AlreadyRunning; Mode }.
#>
function Start-OrVipSystem {
    param([scriptblock]$Report = {}, [switch]$NoBrowser)
    $step = 'requirements'
    $status = { param($key) & $Report $step 'info' $key @{} }
    if (-not (Enter-OrVipLock -OnWait { & $Report 'requirements' 'info' 'status.anotherLauncher' @{} })) {
        Throw-OrVip 'status.anotherLauncher' 'Busy'
    }
    try {
        & $Report $step 'running'
        $req = Test-OrVipRequirements
        $config = $req.Config
        $url = Get-OrVipUrl $config

        # Already running? Then this is a fast, safe no-op (repeated double-clicks).
        $now = Get-OrVipServerSituation $config
        Write-OrVipLog 'INFO' ('port {0}: {1}' -f $config.appPort, $now.Situation)
        if ($now.Situation -eq 'ours' -or $now.Situation -eq 'foreign-orvip') {
            if ($now.Situation -eq 'foreign-orvip') { Add-OrVipWarning ((Get-OrVipText 'error.notStartedByLauncher').en) }
            foreach ($s in $script:Steps) { if ($s -ne 'running') { & $Report $s 'skipped' } }
            & $Report 'running' 'done' 'status.alreadyRunning' @{ url = $url }
            if (-not $NoBrowser) { Start-Process $url | Out-Null }
            return @{ Url = $url; AlreadyRunning = $true; Mode = $req.Mode }
        }
        if ($now.Situation -eq 'busy') {
            Throw-OrVip 'error.portBusy' 'PortBusy' @{ port = $config.appPort; process = $now.Owner.Name }
        }
        if ($now.Situation -eq 'ours-starting') {
            # A server we started earlier that is not answering: stop it and start cleanly.
            Stop-OrVipServer $config | Out-Null
        }
        & $Report $step 'done'

        $step = 'docker'
        $dockerCli = $null
        if ($req.Mode -eq 'docker') {
            & $Report $step 'running'
            $dockerCli = Start-OrVipDocker $config $status
            & $Report $step 'done'
        } else {
            & $Report $step 'skipped'
        }

        $step = 'database'
        & $Report $step 'running'
        $project = $null
        if ($req.Mode -eq 'docker') { $project = Start-OrVipDatabaseContainer $dockerCli $config $req.Db $status }
        else { Wait-OrVipExternalDatabase $config $req.Db $status }
        & $Report $step 'done'

        $step = 'dependencies'
        & $Report $step 'running'
        Update-OrVipDependencies $req.Node $config $status | Out-Null
        & $Report $step 'done'

        $step = 'migrations'
        & $Report $step 'running'
        Update-OrVipDatabase $req.Node $req.Mode $dockerCli $project $req.Db $status | Out-Null
        & $Report $step 'done'

        $step = 'server'
        & $Report $step 'running'
        Update-OrVipBuild $req.Node $config $status | Out-Null
        Start-OrVipServer $req.Node $config $status | Out-Null
        & $Report $step 'done'

        & $Report 'running' 'done' 'status.running' @{ url = $url }
        if (-not $NoBrowser) { Start-Process $url | Out-Null }
        return @{ Url = $url; AlreadyRunning = $false; Mode = $req.Mode }
    } catch {
        & $Report $step 'failed'
        throw
    } finally {
        Exit-OrVipLock
    }
}

<# Plain text progress for -NoGui, setup and automation. #>
function New-OrVipConsoleReporter {
    return {
        param($Step, $State, $Key = '', $Params = @{})
        if ($State -eq 'info' -or $Key) {
            if ($Key) { $t = Get-OrVipText $Key $Params; Write-Host ('       ' + $t.en) }
            if ($State -eq 'info') { return }
        }
        $title = Get-OrVipText ('step.' + $Step)
        $tag = @{ running = '[....]'; done = '[ OK ]'; skipped = '[skip]'; failed = '[FAIL]' }[$State]
        if ($tag) { Write-Host ('{0} {1}' -f $tag, $title.en) }
    }
}

<# Prints a failure in both languages and returns its exit code. #>
function Write-OrVipFailure {
    param($ErrorRecord)
    $f = Resolve-OrVipFailure $ErrorRecord
    Write-Host ''
    Write-Host $f.Text.en -ForegroundColor Red
    Write-Host $f.Text.ar -ForegroundColor Red
    if ($f.Detail) { Write-Host $f.Detail }
    Write-Host ('Log: ' + $script:LogFile)
    return $f.ExitCode
}

function Stop-OrVipSystem {
    param([switch]$StopDatabase)
    $config = Get-OrVipConfig
    $result = Stop-OrVipServer $config
    if ($StopDatabase) {
        $cli = Get-OrVipDockerCli
        if ($cli -and $config.composeProject) {
            # "stop" keeps the container and its data volume; "down -v" is never used.
            Invoke-OrVipCommand -FilePath $cli -Arguments @('compose', '-p', [string]$config.composeProject, 'stop', 'db') -LogName 'docker' -TimeoutSec 120 | Out-Null
        }
    }
    return $result
}

Export-ModuleMember -Function *-OrVip*, Throw-OrVip, Resolve-OrVipFailure, Initialize-OrVip, Protect-OrVipSecret
