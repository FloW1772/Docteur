# OMEGA V1 Phase 3 — fixed, repo-authored screen capture script.
#
# Invoked ONLY via runFixedPowerShellScript() (-File, never -Command with
# interpolated text) with exactly two positional, numeric/enum arguments:
#   $args[0] = ScreenIndex  ("all" is never accepted — a specific numeric
#              index into [System.Windows.Forms.Screen]::AllScreens, or
#              the literal string "list" to enumerate screens only)
#   $args[1] = OutputPath   (an absolute path this process already chose
#              and owns — always inside the OS temp dir, never derived
#              from any caller-facing string concatenation)
#
# No caller-supplied text is ever interpolated into this script's body —
# both arguments are consumed via $args, not string substitution, so
# there is no PowerShell/command injection surface here at all, mirroring
# the "fixed script, typed positional args only" discipline documented in
# omega-windows-exec.js.
#
# Capture mechanism (per mission's pre-made technical decision — not
# re-derived here): System.Windows.Forms.Screen for monitor enumeration,
# System.Drawing.Graphics.CopyFromScreen for the actual pixel capture,
# saved as PNG to a temp file, read back into Node, then deleted by the
# Node caller. Zero new npm dependency — both assemblies ship with the
# .NET Framework already present on every supported Windows version.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing

$mode = $args[0]

if ($mode -eq 'list') {
    # ── Multi-monitor enumeration (mission rule 10: detect + let the
    # caller explicitly select — never silently capture "all"). ──
    $screens = [System.Windows.Forms.Screen]::AllScreens
    $result = @()
    for ($i = 0; $i -lt $screens.Count; $i++) {
        $s = $screens[$i]
        $result += [PSCustomObject]@{
            index   = $i
            primary = [bool]$s.Primary
            x       = $s.Bounds.X
            y       = $s.Bounds.Y
            width   = $s.Bounds.Width
            height  = $s.Bounds.Height
            device  = $s.DeviceName
        }
    }
    Write-Output (@{ ok = $true; screens = $result } | ConvertTo-Json -Compress -Depth 4)
    exit 0
}

# ── Single-frame capture of ONE explicitly-selected screen. ──
$screenIndex = [int]$mode
$outputPath = $args[1]

$screens = [System.Windows.Forms.Screen]::AllScreens
if ($screenIndex -lt 0 -or $screenIndex -ge $screens.Count) {
    Write-Output (@{ ok = $false; reason = 'screen_index_out_of_range' } | ConvertTo-Json -Compress)
    exit 0
}

$bounds = $screens[$screenIndex].Bounds
$bitmap = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $graphics.CopyFromScreen($bounds.Location, [System.Drawing.Point]::Empty, $bounds.Size)
    $bitmap.Save($outputPath, [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output (@{ ok = $true; width = $bounds.Width; height = $bounds.Height; path = $outputPath } | ConvertTo-Json -Compress)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}
