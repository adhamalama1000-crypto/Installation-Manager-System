#Requires -Version 5.1
<#
.SYNOPSIS
  Starts OR VIP ERP: checks the computer, starts Docker Desktop and the database, prepares the
  program and opens it in the browser. This is what the OR VIP desktop icon runs.

.PARAMETER NoGui
  Plain text progress instead of the OR VIP window (for automation and troubleshooting).
.PARAMETER NoBrowser
  Do not open the browser at the end.
.PARAMETER GuiPreview
  Draws the window with sample progress into a PNG file and exits (used by the automated tests).

  Exit codes: 0 running, 10 requirements, 11 .env, 20 Docker, 30 database, 40 dependencies,
  50 database update, 60 build, 70 port in use, 71 server stopped, 72 server timeout,
  73 server cannot reach database, 80 another launcher busy, 90 unexpected.
#>
[CmdletBinding()]
param([switch]$NoGui, [switch]$NoBrowser, [string]$GuiPreview = '')

$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrVip.psm1') -Force -DisableNameChecking

# ------------------------------------------------------------------------------------------------
# Plain text mode
# ------------------------------------------------------------------------------------------------
if ($NoGui) {
    Initialize-OrVip -LogName 'launcher'
    try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch { }
    $report = New-OrVipConsoleReporter
    try {
        $result = Start-OrVipSystem -Report $report -NoBrowser:$NoBrowser
        foreach ($w in Get-OrVipWarnings) { Write-Host ('NOTE: ' + $w) -ForegroundColor Yellow }
        Write-Host ('OR VIP is running: ' + $result.Url) -ForegroundColor Green
        exit 0
    } catch {
        exit (Write-OrVipFailure $_)
    }
}

# ------------------------------------------------------------------------------------------------
# OR VIP window
# ------------------------------------------------------------------------------------------------
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()

Initialize-OrVip -LogName 'launcher' -Pump { [System.Windows.Forms.Application]::DoEvents() }

$root = Get-OrVipRoot
$navy = [System.Drawing.ColorTranslator]::FromHtml('#071A3D')
$royal = [System.Drawing.ColorTranslator]::FromHtml('#0757D8')
$ink = [System.Drawing.ColorTranslator]::FromHtml('#0B1B36')
$muted = [System.Drawing.ColorTranslator]::FromHtml('#5F6D86')
$okColor = [System.Drawing.ColorTranslator]::FromHtml('#047857')
$badColor = [System.Drawing.ColorTranslator]::FromHtml('#C0262D')
$soft = [System.Drawing.ColorTranslator]::FromHtml('#F4F7FC')
$font = New-Object System.Drawing.Font('Segoe UI', 10)
$fontBold = New-Object System.Drawing.Font('Segoe UI', 10, [System.Drawing.FontStyle]::Bold)
$fontSmall = New-Object System.Drawing.Font('Segoe UI', 9)
$glyphs = @{ pending = [string][char]0x25CB; running = [string][char]0x25D4; done = [string][char]0x2713; skipped = [string][char]0x2013; failed = [string][char]0x2715 }

$form = New-Object System.Windows.Forms.Form
$form.Text = 'OR VIP ERP'
$form.ClientSize = New-Object System.Drawing.Size(560, 600)
$form.FormBorderStyle = 'FixedSingle'
$form.MaximizeBox = $false
$form.StartPosition = 'CenterScreen'
$form.BackColor = $soft
$form.Font = $font
$icon = Join-Path $PSScriptRoot 'assets\or-vip.ico'
if (Test-Path -LiteralPath $icon) { $form.Icon = New-Object System.Drawing.Icon($icon) }

# Header: the OR VIP logo on its own navy background.
$header = New-Object System.Windows.Forms.Panel
$header.SetBounds(0, 0, 560, 150)
$header.BackColor = $navy
$form.Controls.Add($header)
$logoPath = Join-Path $root 'public\brand\logo.png'
if (Test-Path -LiteralPath $logoPath) {
    $logo = New-Object System.Windows.Forms.PictureBox
    $logo.Image = [System.Drawing.Image]::FromFile($logoPath)
    $logo.SizeMode = 'Zoom'
    $logo.SetBounds(100, 12, 360, 126)
    $header.Controls.Add($logo)
}

# Steps: glyph, English and Arabic names.
$rows = @{}
$y = 166
foreach ($step in Get-OrVipSteps) {
    $t = Get-OrVipText ('step.' + $step)
    $g = New-Object System.Windows.Forms.Label
    $g.SetBounds(24, $y, 26, 26); $g.Font = $fontBold; $g.ForeColor = $muted; $g.Text = $glyphs.pending
    $en = New-Object System.Windows.Forms.Label
    $en.SetBounds(52, $y + 2, 250, 24); $en.ForeColor = $ink; $en.Text = $t.en
    $ar = New-Object System.Windows.Forms.Label
    $ar.SetBounds(300, $y + 2, 236, 24); $ar.ForeColor = $ink; $ar.Text = $t.ar
    $ar.RightToLeft = 'Yes'; $ar.TextAlign = 'MiddleRight'
    $form.Controls.AddRange(@($g, $en, $ar))
    $rows[$step] = @{ Glyph = $g; En = $en; Ar = $ar }
    $y += 32
}

$statusEn = New-Object System.Windows.Forms.Label
$statusEn.SetBounds(24, $y + 12, 512, 54); $statusEn.ForeColor = $ink
$statusAr = New-Object System.Windows.Forms.Label
$statusAr.SetBounds(24, $y + 68, 512, 54); $statusAr.ForeColor = $ink
$statusAr.RightToLeft = 'Yes'; $statusAr.TextAlign = 'TopRight'
$form.Controls.AddRange(@($statusEn, $statusAr))

$buttons = New-Object System.Windows.Forms.FlowLayoutPanel
$buttons.SetBounds(16, 540, 528, 48)
$buttons.FlowDirection = 'LeftToRight'
$form.Controls.Add($buttons)
function New-OrVipButton([string]$Key, [bool]$Primary) {
    $t = Get-OrVipText $Key
    $b = New-Object System.Windows.Forms.Button
    $b.Text = $t.en + ' / ' + $t.ar
    $b.AutoSize = $true
    $b.Height = 36
    $b.Margin = New-Object System.Windows.Forms.Padding(4)
    $b.FlatStyle = 'Flat'
    if ($Primary) { $b.BackColor = $royal; $b.ForeColor = [System.Drawing.Color]::White; $b.FlatAppearance.BorderColor = $royal }
    else { $b.BackColor = [System.Drawing.Color]::White; $b.ForeColor = $ink; $b.FlatAppearance.BorderColor = [System.Drawing.ColorTranslator]::FromHtml('#C3CEE0') }
    $buttons.Controls.Add($b)
    return $b
}
$btnOpen = New-OrVipButton 'button.open' $true
$btnStart = New-OrVipButton 'button.start' $true
$btnRestart = New-OrVipButton 'button.restart' $false
$btnStop = New-OrVipButton 'button.stop' $false
$btnLogs = New-OrVipButton 'button.logs' $false
$btnClose = New-OrVipButton 'button.close' $false

$script:busy = $false
$script:url = 'http://localhost:3000'

function Set-OrVipStatus([string]$Key, [hashtable]$Params = @{}, [bool]$IsError = $false) {
    $t = Get-OrVipText $Key $Params
    $statusEn.Text = $t.en; $statusAr.Text = $t.ar
    $c = if ($IsError) { $badColor } else { $ink }
    $statusEn.ForeColor = $c; $statusAr.ForeColor = $c
}

function Set-OrVipButtons([string]$Phase) {
    # Phase: busy | running | failed | stopped
    $btnOpen.Visible = ($Phase -eq 'running')
    $btnRestart.Visible = ($Phase -eq 'running')
    $btnStop.Visible = ($Phase -eq 'running' -or $Phase -eq 'failed')
    $btnStart.Visible = ($Phase -eq 'failed' -or $Phase -eq 'stopped')
    $btnStart.Text = if ($Phase -eq 'failed') { $t = Get-OrVipText 'button.retry'; $t.en + ' / ' + $t.ar } else { $t = Get-OrVipText 'button.start'; $t.en + ' / ' + $t.ar }
    foreach ($b in @($btnOpen, $btnStart, $btnRestart, $btnStop)) { $b.Enabled = ($Phase -ne 'busy') }
}

function Reset-OrVipRows {
    foreach ($r in $rows.Values) { $r.Glyph.Text = $glyphs.pending; $r.Glyph.ForeColor = $muted; $r.En.Font = $font; $r.Ar.Font = $font }
}

$report = {
    param($Step, $State, $Key = '', $Params = @{})
    if ($form.IsDisposed) { return }
    if ($State -eq 'info') { if ($Key) { Set-OrVipStatus $Key $Params }; [System.Windows.Forms.Application]::DoEvents(); return }
    $r = $rows[$Step]
    if ($r) {
        $r.Glyph.Text = $glyphs[$State]
        $r.Glyph.ForeColor = switch ($State) { 'done' { $okColor } 'failed' { $badColor } 'running' { $royal } default { $muted } }
        $bold = ($State -eq 'running')
        $r.En.Font = if ($bold) { $fontBold } else { $font }
        $r.Ar.Font = if ($bold) { $fontBold } else { $font }
        if ($State -eq 'running') { Set-OrVipStatus ('step.' + $Step) }
        if ($Step -eq 'docker' -and $State -eq 'skipped') { Set-OrVipStatus 'status.skippedExternal' }
    }
    if ($Key) { Set-OrVipStatus $Key $Params }
    [System.Windows.Forms.Application]::DoEvents()
}

function Invoke-OrVipStart {
    if ($script:busy) { return }
    $script:busy = $true
    Reset-OrVipRows
    Set-OrVipButtons 'busy'
    Set-OrVipStatus 'status.starting'
    try {
        $result = Start-OrVipSystem -Report $report -NoBrowser:$NoBrowser
        $script:url = $result.Url
        $warnings = Get-OrVipWarnings
        if ($warnings.Count -gt 0) { $statusEn.Text += [Environment]::NewLine + 'Note: ' + ($warnings -join ' ') }
        Set-OrVipButtons 'running'
    } catch {
        $f = Resolve-OrVipFailure $_
        $statusEn.Text = $f.Text.en + [Environment]::NewLine + (Get-OrVipText 'error.seeLogs' @{ path = (Get-OrVipLogFile) }).en
        $statusAr.Text = $f.Text.ar
        $statusEn.ForeColor = $badColor; $statusAr.ForeColor = $badColor
        Set-OrVipButtons 'failed'
    } finally {
        $script:busy = $false
    }
}

function Invoke-OrVipStop {
    if ($script:busy) { return }
    $script:busy = $true
    Set-OrVipButtons 'busy'
    Set-OrVipStatus 'status.stopping'
    try {
        $r = Stop-OrVipSystem
        Reset-OrVipRows
        if ($r -eq 'not-ours') { Set-OrVipStatus 'error.notStartedByLauncher' } else { Set-OrVipStatus 'status.stopped' }
        Set-OrVipButtons 'stopped'
    } catch {
        $f = Resolve-OrVipFailure $_
        $statusEn.Text = $f.Text.en; $statusAr.Text = $f.Text.ar
        Set-OrVipButtons 'failed'
    } finally { $script:busy = $false }
}

$btnOpen.Add_Click({ Start-Process $script:url | Out-Null })
$btnStart.Add_Click({ Invoke-OrVipStart })
$btnStop.Add_Click({ Invoke-OrVipStop })
$btnRestart.Add_Click({
    Invoke-OrVipStop
    if (-not $btnStart.Visible) { return }
    Invoke-OrVipStart
})
$btnLogs.Add_Click({ Start-Process -FilePath 'explorer.exe' -ArgumentList ('"{0}"' -f (Get-OrVipLogDir)) | Out-Null })
$btnClose.Add_Click({ $form.Close() })
$form.Add_FormClosing({
    param($eventSender, $e)
    if ($script:busy) { $e.Cancel = $true; Set-OrVipStatus 'status.closeWhileBusy' }
})

if ($GuiPreview) {
    # Render a sample state for the automated tests and documentation, without starting anything.
    Set-OrVipButtons 'running'
    foreach ($s in @('requirements', 'docker', 'database', 'dependencies', 'migrations')) { & $report $s 'done' }
    & $report 'server' 'running' 'status.waitingServer'
    $form.Show()
    [System.Windows.Forms.Application]::DoEvents()
    $bmp = New-Object System.Drawing.Bitmap($form.Width, $form.Height)
    $form.DrawToBitmap($bmp, (New-Object System.Drawing.Rectangle(0, 0, $form.Width, $form.Height)))
    $bmp.Save($GuiPreview, [System.Drawing.Imaging.ImageFormat]::Png)
    $form.Close()
    exit 0
}

Set-OrVipButtons 'busy'
$form.Add_Shown({ $form.Activate(); Invoke-OrVipStart })
[void]$form.ShowDialog()
