# OMEGA V1 Phase 4.1 - persistent local session indicator.
# Visible user-space WinForms window. No service, driver, hook, startup,
# scheduled task, registry persistence, or hidden auto-start.

param(
    [ValidateSet('view', 'interactive', 'admin')]
    [string]$Mode,
    [Parameter(Mandatory = $true)]
    [string]$LeaseFile,
    [Parameter(Mandatory = $true)]
    [string]$StopFile,
    [int]$LeaseTimeoutMs = 5000
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dash = [char]0x2014
$title = if ($Mode -eq 'interactive') { "OMEGA $dash INTERACTIVE CONTROL ACTIVE" } elseif ($Mode -eq 'admin') { "OMEGA $dash ADMIN SESSION ACTIVE" } else { "OMEGA $dash VIEW ONLY ACTIVE" }
$message = if ($Mode -eq 'interactive') {
    'A remote device can control mouse and keyboard. Use STOP SESSION to end it.'
} elseif ($Mode -eq 'admin') {
    'OMEGA ADMIN actions require a separate local ALLOW ONCE confirmation.'
} else {
    'A remote device is viewing this screen. Mouse and keyboard control are disabled.'
}

function Get-LeaseAgeMs {
    try {
        $stamp = [Int64](Get-Content -LiteralPath $LeaseFile -Raw)
        return [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $stamp)
    } catch {
        return [Int64]::MaxValue
    }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = $title
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.ControlBox = $false
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.Width = 470
$form.Height = 175
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($workingArea.Right - $form.Width - 24), ($workingArea.Bottom - $form.Height - 24))

$header = New-Object System.Windows.Forms.Label
$header.Text = $title
$header.Font = New-Object System.Drawing.Font('Segoe UI', 12, [System.Drawing.FontStyle]::Bold)
$header.AutoSize = $false
$header.Width = 430
$header.Height = 32
$header.Location = New-Object System.Drawing.Point(18, 15)

$body = New-Object System.Windows.Forms.Label
$body.Text = $message
$body.AutoSize = $false
$body.Width = 430
$body.Height = 48
$body.Location = New-Object System.Drawing.Point(18, 52)

$stop = New-Object System.Windows.Forms.Button
$stop.Text = 'STOP OMEGA SESSION'
$stop.Width = 190
$stop.Height = 30
$stop.Location = New-Object System.Drawing.Point(18, 105)
$stop.Add_Click({
    try { [System.IO.File]::WriteAllText($StopFile, 'local_stop') } catch {}
    $form.Close()
})

$form.Controls.Add($header)
$form.Controls.Add($body)
$form.Controls.Add($stop)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 500
$timer.Add_Tick({
    if ((Test-Path -LiteralPath $StopFile) -or ((Get-LeaseAgeMs) -gt $LeaseTimeoutMs)) {
        $form.Close()
    }
})
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run($form)
} finally {
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
    try { Remove-Item -LiteralPath $LeaseFile -Force } catch {}
    try { Remove-Item -LiteralPath $StopFile -Force } catch {}
    try { Remove-Item -LiteralPath (Split-Path -Parent $LeaseFile) -Force } catch {}
}
