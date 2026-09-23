# OMEGA V1 Phase 4 — fixed, repo-authored input-injection script
# (OMEGA_INTERACTIVE: mouse move/click/wheel, keyboard key down/up).
#
# Invoked ONLY via runFixedPowerShellScript() (-File, never -Command with
# interpolated text) with exactly FOUR positional, numeric $args:
#   $args[0] = EventType  (integer, closed enum — see switch below)
#   $args[1] = Param1     (integer — meaning depends on EventType)
#   $args[2] = Param2     (integer — meaning depends on EventType)
#   $args[3] = Param3     (integer — meaning depends on EventType, 0 if unused)
#
# EventType enum (documented here AND in omega-input.js — the single
# source of truth for the numbering is this comment, duplicated
# intentionally on both sides of the process boundary so a mismatch is
# immediately visible in code review):
#   1 = MOVE       (Param1=normX 0-65535, Param2=normY 0-65535, Param3 unused)
#   2 = LEFT_DOWN  (Param1=normX, Param2=normY, Param3 unused)
#   3 = LEFT_UP    (Param1=normX, Param2=normY, Param3 unused)
#   4 = RIGHT_DOWN (Param1=normX, Param2=normY, Param3 unused)
#   5 = RIGHT_UP   (Param1=normX, Param2=normY, Param3 unused)
#   6 = WHEEL      (Param1=normX, Param2=normY, Param3=wheelDelta signed, -8..8 * WHEEL_DELTA steps encoded by caller)
#   7 = KEY_DOWN   (Param1=virtualKeyCode, Param2=extendedFlag 0|1, Param3 unused)
#   8 = KEY_UP     (Param1=virtualKeyCode, Param2=extendedFlag 0|1, Param3 unused)
#
# No caller-supplied TEXT is ever interpolated into this script's body —
# every argument is a bounded integer consumed via $args, not string
# substitution. There is no PowerShell/command injection surface here,
# mirroring omega-capture.ps1's exact discipline.
#
# This script is intentionally "dumb"/mechanical: the vk-code allowlist,
# coordinate-bounds check against the selected screen's real resolution,
# and rate/batch limits are ALL enforced in the calling Node module
# (omega-input.js) BEFORE this script is ever invoked. This script does
# perform one defense-in-depth check of its own (EventType must be one
# of the 8 listed values, coordinates/vk must be in-range for the
# Win32 API's own valid domains) so a bug in the Node-side validator
# cannot, by itself, turn into an out-of-range native call — but the
# authoritative security boundary is the Node module, not this script.
#
# API used (per mission's pre-researched decision, not re-derived here):
# user32.dll!SendInput — the current, documented, user-space Windows API
# for synthesizing input. NOT mouse_event/keybd_event (legacy). NOT
# SendKeys (keyboard-only, string-parsing, wrong fit for an allowlist
# architecture). SendInput is subject to UIPI (User Interface Privilege
# Isolation) — a non-elevated process cannot inject into an elevated
# window; Windows silently delivers fewer events than requested in that
# case. This script reports back the actual number of events accepted by
# SendInput (its own return value = number of events it successfully
# queued to the input stream) so partial/zero success is surfaced
# honestly rather than assumed. This is a Windows-enforced structural
# limitation, not a bug in this script.
#
# Secure desktop (UAC consent screen, Ctrl+Alt+Del) is a SEPARATE desktop
# object that SendInput from the normal interactive desktop cannot reach
# at all — Windows itself refuses, unconditionally. Nothing in this
# script needs to check for or handle that case.

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

Add-Type -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)]
public struct MOUSEINPUT {
    public int dx;
    public int dy;
    public uint mouseData;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Sequential)]
public struct KEYBDINPUT {
    public ushort wVk;
    public ushort wScan;
    public uint dwFlags;
    public uint time;
    public IntPtr dwExtraInfo;
}
[StructLayout(LayoutKind.Explicit)]
public struct INPUTUNION {
    [FieldOffset(0)] public MOUSEINPUT mi;
    [FieldOffset(0)] public KEYBDINPUT ki;
}
[StructLayout(LayoutKind.Sequential)]
public struct INPUT {
    public uint type;
    public INPUTUNION u;
}
[DllImport("user32.dll", SetLastError = true)]
public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
'@ -Name "OmegaNativeInput" -Namespace "OmegaInterop"

$INPUT_MOUSE = 0
$INPUT_KEYBOARD = 1

$MOUSEEVENTF_MOVE = 0x0001
$MOUSEEVENTF_ABSOLUTE = 0x8000
$MOUSEEVENTF_VIRTUALDESK = 0x4000
$MOUSEEVENTF_LEFTDOWN = 0x0002
$MOUSEEVENTF_LEFTUP = 0x0004
$MOUSEEVENTF_RIGHTDOWN = 0x0008
$MOUSEEVENTF_RIGHTUP = 0x0010
$MOUSEEVENTF_WHEEL = 0x0800

$KEYEVENTF_EXTENDEDKEY = 0x0001
$KEYEVENTF_KEYUP = 0x0002

function New-MouseInput([int]$flags, [int]$dx = 0, [int]$dy = 0, [int]$data = 0) {
    $input = New-Object OmegaInterop.OmegaNativeInput+INPUT
    $input.type = $INPUT_MOUSE
    $input.u.mi.dx = $dx
    $input.u.mi.dy = $dy
    $input.u.mi.mouseData = [uint32]([int64]$data -band 0xFFFFFFFF)
    $input.u.mi.dwFlags = [uint32]$flags
    $input.u.mi.time = 0
    $input.u.mi.dwExtraInfo = [IntPtr]::Zero
    return $input
}

function New-KeyInput([int]$vk, [int]$flags) {
    $input = New-Object OmegaInterop.OmegaNativeInput+INPUT
    $input.type = $INPUT_KEYBOARD
    $input.u.ki.wVk = [uint16]$vk
    $input.u.ki.wScan = 0
    $input.u.ki.dwFlags = [uint32]$flags
    $input.u.ki.time = 0
    $input.u.ki.dwExtraInfo = [IntPtr]::Zero
    return $input
}

function Send-OneInput($input) {
    $arr = [OmegaInterop.OmegaNativeInput+INPUT[]]@($input)
    $size = [System.Runtime.InteropServices.Marshal]::SizeOf([type]"OmegaInterop.OmegaNativeInput+INPUT")
    $sent = [OmegaInterop.OmegaNativeInput]::SendInput(1, $arr, $size)
    return [int]$sent
}

# Extended-key virtual-key codes per standard Windows convention (arrows,
# Home/End/PageUp/PageDown/Insert/Delete, right Ctrl/Alt, numpad Enter).
$EXTENDED_VKS = @(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x90,0x91)

try {
    $eventType = [int]$args[0]
    $p1 = [int]$args[1]
    $p2 = [int]$args[2]
    $p3 = if ($args.Count -gt 3) { [int]$args[3] } else { 0 }

    $sent = 0
    $requested = 1

    switch ($eventType) {
        1 { # MOVE
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            $flags = $MOUSEEVENTF_MOVE -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 0)
        }
        2 { # LEFT_DOWN
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            $flags = $MOUSEEVENTF_LEFTDOWN -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK -bor $MOUSEEVENTF_MOVE
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 0)
        }
        3 { # LEFT_UP
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            $flags = $MOUSEEVENTF_LEFTUP -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK -bor $MOUSEEVENTF_MOVE
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 0)
        }
        4 { # RIGHT_DOWN
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            $flags = $MOUSEEVENTF_RIGHTDOWN -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK -bor $MOUSEEVENTF_MOVE
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 0)
        }
        5 { # RIGHT_UP
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            $flags = $MOUSEEVENTF_RIGHTUP -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK -bor $MOUSEEVENTF_MOVE
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 0)
        }
        6 { # WHEEL
            if ($p1 -lt 0 -or $p1 -gt 65535 -or $p2 -lt 0 -or $p2 -gt 65535) { throw "coords_out_of_range" }
            if ($p3 -lt -3 -or $p3 -gt 3 -or $p3 -eq 0) { throw "wheel_delta_out_of_range" }
            $flags = $MOUSEEVENTF_WHEEL -bor $MOUSEEVENTF_ABSOLUTE -bor $MOUSEEVENTF_VIRTUALDESK
            $sent = Send-OneInput (New-MouseInput $flags $p1 $p2 ($p3 * 120))
        }
        7 { # KEY_DOWN
            if ($p1 -lt 1 -or $p1 -gt 254) { throw "vk_out_of_range" }
            $flags = 0
            if ($EXTENDED_VKS -contains $p1) { $flags = $flags -bor $KEYEVENTF_EXTENDEDKEY }
            $sent = Send-OneInput (New-KeyInput $p1 $flags)
        }
        8 { # KEY_UP
            if ($p1 -lt 1 -or $p1 -gt 254) { throw "vk_out_of_range" }
            $flags = $KEYEVENTF_KEYUP
            if ($EXTENDED_VKS -contains $p1) { $flags = $flags -bor $KEYEVENTF_EXTENDEDKEY }
            $sent = Send-OneInput (New-KeyInput $p1 $flags)
        }
        default {
            throw "event_type_invalid"
        }
    }

    Write-Output (@{ ok = $true; requested = $requested; sent = $sent } | ConvertTo-Json -Compress)
} catch {
    Write-Output (@{ ok = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress)
}
