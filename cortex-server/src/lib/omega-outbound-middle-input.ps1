# OMEGA V2 fixed middle-button companion. Numeric arguments only:
# state 1=DOWN/2=UP, normalized virtual-desktop x/y (0..65535).
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Add-Type -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx; public int dy; public uint mouseData; public uint dwFlags; public uint time; public IntPtr dwExtraInfo; }
[StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; }
[StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
[DllImport("user32.dll", SetLastError=true)] public static extern uint SendInput(uint nInputs, INPUT[] pInputs, int cbSize);
'@ -Name 'OmegaV2MiddleInput' -Namespace 'OmegaInterop'
try {
  $state = [int]$args[0]; $x = [int]$args[1]; $y = [int]$args[2]
  if (($state -ne 1 -and $state -ne 2) -or $x -lt 0 -or $x -gt 65535 -or $y -lt 0 -or $y -gt 65535) { throw 'input_invalid' }
  $input = New-Object OmegaInterop.OmegaV2MiddleInput+INPUT
  $input.type = 0; $input.u.mi.dx = $x; $input.u.mi.dy = $y; $input.u.mi.mouseData = 0
  $input.u.mi.dwFlags = [uint32](0x0001 -bor 0x8000 -bor 0x4000 -bor $(if ($state -eq 1) { 0x0020 } else { 0x0040 }))
  $input.u.mi.time = 0; $input.u.mi.dwExtraInfo = [IntPtr]::Zero
  $arr = [OmegaInterop.OmegaV2MiddleInput+INPUT[]]@($input)
  $sent = [OmegaInterop.OmegaV2MiddleInput]::SendInput(1, $arr, [Runtime.InteropServices.Marshal]::SizeOf([type]'OmegaInterop.OmegaV2MiddleInput+INPUT'))
  @{ ok = ($sent -eq 1); requested = 1; sent = [int]$sent } | ConvertTo-Json -Compress
} catch { @{ ok = $false; requested = 1; sent = 0; reason = 'input_failed' } | ConvertTo-Json -Compress; exit 1 }
