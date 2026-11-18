#Requires -Version 5.1
# Unit tests for the OR VIP Windows launcher module (Pester 5). Run on Windows:
#   Invoke-Pester scripts\windows\tests\OrVip.Tests.ps1 -Output Detailed

BeforeAll {
    Import-Module (Join-Path $PSScriptRoot '..\OrVip.psm1') -Force -DisableNameChecking
    Initialize-OrVip -LogName 'pester'
}

Describe 'Protect-OrVipSecret' {
    It 'masks the password of a connection string' {
        Protect-OrVipSecret 'x postgresql://ims:S3cret!@localhost:5433/db y' | Should -Be 'x postgresql://ims:****@localhost:5433/db y'
    }
    It 'masks KEY=value secrets' {
        Protect-OrVipSecret 'ADMIN_PASSWORD=abc123 PGPASSWORD="x y" CRON_SECRET: zzz' | Should -Be 'ADMIN_PASSWORD=**** PGPASSWORD=**** CRON_SECRET: ****'
    }
    It 'leaves normal text alone' { Protect-OrVipSecret 'Database schema is up to date' | Should -Be 'Database schema is up to date' }
}

Describe 'ConvertFrom-OrVipDatabaseUrl' {
    It 'parses a full connection string and masks the password' {
        $r = ConvertFrom-OrVipDatabaseUrl 'postgresql://ims:p%40ss@localhost:5433/installation_manager?schema=public'
        $r.Valid | Should -BeTrue
        $r.User | Should -Be 'ims'
        $r.Password | Should -Be 'p@ss'
        $r.Port | Should -Be 5433
        $r.Database | Should -Be 'installation_manager'
        $r.IsLocal | Should -BeTrue
        $r.Masked | Should -Be 'postgresql://ims:****@localhost:5433/installation_manager'
    }
    It 'defaults the port to 5432 and detects remote hosts' {
        $r = ConvertFrom-OrVipDatabaseUrl 'postgres://u:p@db.example.com/erp'
        $r.Port | Should -Be 5432
        $r.IsLocal | Should -BeFalse
    }
    It 'rejects <case>' -TestCases @(
        @{ case = 'an empty value'; url = '' }
        @{ case = 'another database type'; url = 'mysql://u:p@localhost/db' }
        @{ case = 'a bad port'; url = 'postgresql://u:p@localhost:99999/db' }
        @{ case = 'no database name'; url = 'postgresql://u:p@localhost:5432/' }
        @{ case = 'no user'; url = 'postgresql://localhost:5432/db' }
    ) {
        param($case, $url)
        (ConvertFrom-OrVipDatabaseUrl $url).Valid | Should -BeFalse
    }
}

Describe 'Read-OrVipEnvFile' {
    It 'reads quoted, unquoted and commented values' {
        $f = Join-Path $TestDrive '.env'
        Set-Content -LiteralPath $f -Value @('# comment', 'A="one two"', "B='x'", 'C=plain # note', 'export D=4', '', 'BAD LINE') -Encoding ASCII
        $v = Read-OrVipEnvFile $f
        $v['A'] | Should -Be 'one two'
        $v['B'] | Should -Be 'x'
        $v['C'] | Should -Be 'plain'
        $v['D'] | Should -Be '4'
        $v.ContainsKey('BAD LINE') | Should -BeFalse
    }
}

Describe 'Get-OrVipMigrationState' {
    It 'classifies <expected>' -TestCases @(
        @{ expected = 'UpToDate'; code = 0; text = "3 migrations found in prisma/migrations`nDatabase schema is up to date!" }
        @{ expected = 'Pending'; code = 1; text = "Following migration have not yet been applied:`n20261118090100_work_hours_reschedule" }
        @{ expected = 'Auth'; code = 1; text = 'Error: P1000: Authentication failed against database server' }
        @{ expected = 'Missing'; code = 1; text = 'Error: P1003: Database installation_manager does not exist' }
        @{ expected = 'Unreachable'; code = 1; text = "Error: P1001: Can't reach database server at localhost:5433" }
        @{ expected = 'NeedsAttention'; code = 1; text = 'Following migration have failed: 20261118090000_visit_type_removal' }
        @{ expected = 'NeedsAttention'; code = 1; text = 'The migration 2026 was modified after it was applied.' }
        @{ expected = 'Unknown'; code = 1; text = 'something else entirely' }
    ) {
        param($expected, $code, $text)
        Get-OrVipMigrationState $text $code | Should -Be $expected
    }
}

Describe 'Get-OrVipComposeDatabase' {
    It 'reads the bundled database settings from docker-compose.yml' {
        $c = Get-OrVipComposeDatabase
        $c.Exists | Should -BeTrue
        $c.User | Should -Be 'ims'
        $c.Database | Should -Be 'installation_manager'
        $c.Port | Should -Be 5433
        $c.Password | Should -Not -BeNullOrEmpty
    }
}

Describe 'Resolve-OrVipDatabaseMode' {
    It 'uses docker for a local database when docker-compose.yml exists' {
        Resolve-OrVipDatabaseMode @{ databaseMode = 'auto' } @{ IsLocal = $true } | Should -Be 'docker'
    }
    It 'uses external for a remote database' {
        Resolve-OrVipDatabaseMode @{ databaseMode = 'auto' } @{ IsLocal = $false } | Should -Be 'external'
    }
    It 'respects an explicit choice' {
        Resolve-OrVipDatabaseMode @{ databaseMode = 'external' } @{ IsLocal = $true } | Should -Be 'external'
    }
}

Describe 'Messages' {
    It 'has English and Arabic text for every key' {
        $json = [System.IO.File]::ReadAllText((Join-Path $PSScriptRoot '..\messages.json'), [System.Text.Encoding]::UTF8) | ConvertFrom-Json
        foreach ($p in $json.PSObject.Properties) {
            $p.Value.en | Should -Not -BeNullOrEmpty -Because $p.Name
            $p.Value.ar | Should -Not -BeNullOrEmpty -Because $p.Name
        }
        (Get-OrVipText 'step.database').ar | Should -Match '[؀-ۿ]'
    }
    It 'fills placeholders and never shows a password in them' {
        $t = Get-OrVipText 'error.databaseTimeout' @{ seconds = 15; target = 'postgresql://u:pw@h:1/d' }
        $t.en | Should -Match '15 seconds'
        $t.en | Should -Not -Match 'pw@'
    }
    It 'turns failures into an exit code and both languages' {
        $f = $null
        try { Throw-OrVip 'error.portBusy' 'PortBusy' @{ port = 3000; process = 'x.exe' } } catch { $f = Resolve-OrVipFailure $_ }
        $f.ExitCode | Should -Be 70
        $f.Text.en | Should -Match '3000'
        $f.Text.ar | Should -Match '3000'
    }
}

Describe 'Invoke-OrVipCommand' {
    It 'returns the exit code and output and logs it' {
        $r = Invoke-OrVipCommand -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments @('/d', '/c', 'echo hello & exit 3') -LogName 'pester'
        $r.ExitCode | Should -Be 3
        $r.Output | Should -Match 'hello'
    }
    It 'passes extra environment variables to the program only, without logging them' {
        $r = Invoke-OrVipCommand -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments @('/d', '/c', 'echo value=%ORVIP_PESTER_SECRET%') -LogName 'pester' -Environment @{ ORVIP_PESTER_SECRET = 'abc' }
        $r.Output | Should -Match 'value=abc'
        $env:ORVIP_PESTER_SECRET | Should -BeNullOrEmpty
    }
    It 'stops a program that runs longer than its timeout' {
        $start = Get-Date
        $r = Invoke-OrVipCommand -FilePath (Join-Path $env:SystemRoot 'System32\PING.EXE') -Arguments @('-n', '30', '127.0.0.1') -LogName 'pester' -TimeoutSec 2
        $r.TimedOut | Should -BeTrue
        ((Get-Date) - $start).TotalSeconds | Should -BeLessThan 15
    }
    It 'writes standard output to a file byte for byte when asked' {
        $file = Join-Path $TestDrive 'out.txt'
        $r = Invoke-OrVipCommand -FilePath (Join-Path $env:SystemRoot 'System32\cmd.exe') -Arguments @('/d', '/c', 'echo data') -LogName 'pester' -StdoutFile $file
        $r.ExitCode | Should -Be 0
        (Get-Content -LiteralPath $file -Raw).Trim() | Should -Be 'data'
    }
}

Describe 'Tracked server records' {
    It 'never trusts a record whose process id now belongs to another process' {
        $other = Start-Process -FilePath (Join-Path $env:SystemRoot 'System32\PING.EXE') -ArgumentList '-n', '60', '127.0.0.1' -WindowStyle Hidden -PassThru
        try {
            $state = @{ pid = $other.Id; created = '1'; childPid = $null; childCreated = $null; port = 3999 }
            [System.IO.File]::WriteAllText((Join-Path (Get-OrVipRoot) '.orvip\server.json'), ($state | ConvertTo-Json))
            Get-OrVipTrackedServer | Should -BeNullOrEmpty
            Test-Path (Join-Path (Get-OrVipRoot) '.orvip\server.json') | Should -BeFalse
            Stop-OrVipServer @{ appPort = 3999 } | Should -Be 'not-running'
            $other.HasExited | Should -BeFalse
        } finally { Stop-Process -Id $other.Id -Force -ErrorAction SilentlyContinue }
    }
    It 'reports a free port and finds a listening one' {
        Get-OrVipPortOwner 3998 | Should -BeNullOrEmpty
        $listener = New-Object System.Net.Sockets.TcpListener([System.Net.IPAddress]::Loopback, 3998)
        $listener.Start()
        try { (Get-OrVipPortOwner 3998).Pid | Should -Be $PID } finally { $listener.Stop() }
    }
}
