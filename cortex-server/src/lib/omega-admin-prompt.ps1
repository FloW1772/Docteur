# OMEGA ADMIN V1 - local confirmation only.
# This process displays a visible prompt and writes exactly ALLOW or DENY to
# the per-request file. It never executes the requested action.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN')]
    [string]$Action,
    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[A-Za-z0-9-]{1,64}$')]
    [string]$DeviceId,
    [Parameter(Mandatory = $true)]
    [string]$ApprovalFile,
    [Parameter(Mandatory = $true)]
    [string]$LeaseFile,
    [int]$LeaseTimeoutMs = 5000,
    [int]$TimeoutSeconds = 30
)

$ErrorActionPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$dash = [char]0x2014
$decisionWritten = $false

function Write-Decision([string]$decision) {
    if ($script:decisionWritten) { return }
    $script:decisionWritten = $true
    try { [System.IO.File]::WriteAllText($ApprovalFile, $decision) } catch {}
    $form.Close()
}

function Get-LeaseAgeMs {
    try {
        $stamp = [Int64](Get-Content -LiteralPath $LeaseFile -Raw)
        return [Math]::Max(0, [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() - $stamp)
    } catch { return [Int64]::MaxValue }
}

$form = New-Object System.Windows.Forms.Form
$form.Text = "OMEGA $dash ADMIN REQUEST"
$form.FormBorderStyle = [System.Windows.Forms.FormBorderStyle]::FixedToolWindow
$form.ControlBox = $false
$form.MaximizeBox = $false
$form.MinimizeBox = $false
$form.ShowInTaskbar = $true
$form.TopMost = $true
$form.Width = 520
$form.Height = 255
$form.StartPosition = [System.Windows.Forms.FormStartPosition]::Manual

$workingArea = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
$form.Location = New-Object System.Drawing.Point(($workingArea.Right - $form.Width - 24), ($workingArea.Bottom - $form.Height - 24))

$header = New-Object System.Windows.Forms.Label
$header.Text = 'OMEGA ADMIN REQUEST'
$header.Font = New-Object System.Drawing.Font('Segoe UI', 14, [System.Drawing.FontStyle]::Bold)
$header.AutoSize = $false
$header.Width = 475
$header.Height = 35
$header.Location = New-Object System.Drawing.Point(20, 15)

$details = New-Object System.Windows.Forms.Label
$details.Text = "Device: $DeviceId`r`nAction: $Action`r`nTimestamp: $([DateTimeOffset]::Now.ToString('o'))"
$details.AutoSize = $false
$details.Width = 475
$details.Height = 72
$details.Location = New-Object System.Drawing.Point(20, 58)

$warning = New-Object System.Windows.Forms.Label
$warning.Text = 'This request can affect the local Windows session. Choose ALLOW ONCE or DENY.'
$warning.AutoSize = $false
$warning.Width = 475
$warning.Height = 32
$warning.Location = New-Object System.Drawing.Point(20, 132)

$allow = New-Object System.Windows.Forms.Button
$allow.Text = 'ALLOW ONCE'
$allow.Width = 145
$allow.Height = 34
$allow.Location = New-Object System.Drawing.Point(20, 178)
$allow.Add_Click({ Write-Decision 'ALLOW' })

$deny = New-Object System.Windows.Forms.Button
$deny.Text = 'DENY'
$deny.Width = 115
$deny.Height = 34
$deny.Location = New-Object System.Drawing.Point(180, 178)
$deny.Add_Click({ Write-Decision 'DENY' })

$form.Controls.Add($header)
$form.Controls.Add($details)
$form.Controls.Add($warning)
$form.Controls.Add($allow)
$form.Controls.Add($deny)

$timer = New-Object System.Windows.Forms.Timer
$timer.Interval = 250
$timer.Add_Tick({
    if ((Get-LeaseAgeMs) -gt $LeaseTimeoutMs) {
        Write-Decision 'DENY'
    }
    if (([DateTimeOffset]::Now - $script:startedAt).TotalSeconds -ge $TimeoutSeconds) {
        Write-Decision 'DENY'
    }
})
$script:startedAt = [DateTimeOffset]::Now
$timer.Start()

try {
    [System.Windows.Forms.Application]::Run($form)
} finally {
    if (-not $script:decisionWritten) {
        try { [System.IO.File]::WriteAllText($ApprovalFile, 'DENY') } catch {}
    }
    $timer.Stop()
    $timer.Dispose()
    $form.Dispose()
}
