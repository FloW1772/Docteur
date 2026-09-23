# OMEGA ADMIN V1 - fixed semantic Windows executor.
# The action is a closed enum and is passed as one validated argument.
# No command text, executable path, user script or free-form PowerShell is
# accepted. Read-only actions return bounded metadata only; high-impact
# actions call documented Windows APIs without force-close flags.

param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('GET_SYSTEM_INFO', 'GET_PROCESS_LIST', 'GET_SERVICE_STATUS', 'GET_NETWORK_STATUS', 'GET_DISK_STATUS', 'LOCK_WORKSTATION', 'REQUEST_LOGOFF', 'REQUEST_RESTART', 'REQUEST_SHUTDOWN')]
    [string]$Action
)

$ErrorActionPreference = 'Stop'

function Emit-Result($value) {
    $value | ConvertTo-Json -Compress -Depth 8
}

if ($Action -eq 'GET_SYSTEM_INFO') {
    $os = Get-CimInstance -ClassName Win32_OperatingSystem
    $computer = Get-CimInstance -ClassName Win32_ComputerSystem
    Emit-Result ([PSCustomObject]@{
        ok = $true
        action = $Action
        system = [PSCustomObject]@{
            computerName = [string]$computer.Name
            osCaption = [string]$os.Caption
            osVersion = [string]$os.Version
            architecture = [string]$os.OSArchitecture
            lastBootUpTime = [string]$os.LastBootUpTime
        }
    })
    exit 0
}

if ($Action -eq 'GET_PROCESS_LIST') {
    $rows = @(Get-Process | Select-Object -First 200 | ForEach-Object {
        try {
            $cpu = $null
            try { $cpu = [double]$_.CPU } catch {}
            [PSCustomObject]@{
                pid = [int]$_.Id
                name = [string]$_.ProcessName
                sessionId = [int]$_.SessionId
                memoryBytes = [int64]$_.WorkingSet64
                cpuSeconds = $cpu
            }
        } catch {}
    })
    Emit-Result ([PSCustomObject]@{ ok = $true; action = $Action; processes = $rows })
    exit 0
}

if ($Action -eq 'GET_SERVICE_STATUS') {
    $rows = @(Get-CimInstance -ClassName Win32_Service | Select-Object -First 200 | ForEach-Object {
        [PSCustomObject]@{
            name = [string]$_.Name
            displayName = [string]$_.DisplayName
            state = [string]$_.State
            startMode = [string]$_.StartMode
        }
    })
    Emit-Result ([PSCustomObject]@{ ok = $true; action = $Action; services = $rows })
    exit 0
}

if ($Action -eq 'GET_NETWORK_STATUS') {
    $rows = @(Get-CimInstance -ClassName Win32_NetworkAdapterConfiguration -Filter 'IPEnabled = TRUE' | Select-Object -First 64 | ForEach-Object {
        [PSCustomObject]@{
            description = [string]$_.Description
            macAddress = [string]$_.MACAddress
            dhcpEnabled = [bool]$_.DHCPEnabled
            addresses = @($_.IPAddress | Select-Object -First 16)
            gateways = @($_.DefaultIPGateway | Select-Object -First 8)
            dnsServers = @($_.DNSServerSearchOrder | Select-Object -First 16)
        }
    })
    Emit-Result ([PSCustomObject]@{ ok = $true; action = $Action; interfaces = $rows })
    exit 0
}

if ($Action -eq 'GET_DISK_STATUS') {
    $rows = @(Get-CimInstance -ClassName Win32_LogicalDisk -Filter 'DriveType = 3' | Select-Object -First 32 | ForEach-Object {
        [PSCustomObject]@{
            drive = [string]$_.DeviceID
            filesystem = [string]$_.FileSystem
            totalBytes = [int64]$_.Size
            freeBytes = [int64]$_.FreeSpace
        }
    })
    Emit-Result ([PSCustomObject]@{ ok = $true; action = $Action; disks = $rows })
    exit 0
}

Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class OmegaAdminNative {
    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool LockWorkStation();

    [DllImport("user32.dll", SetLastError = true)]
    public static extern bool ExitWindowsEx(uint flags, uint reason);
}
'@

$ok = $false
if ($Action -eq 'LOCK_WORKSTATION') {
    $ok = [OmegaAdminNative]::LockWorkStation()
} elseif ($Action -eq 'REQUEST_LOGOFF') {
    $ok = [OmegaAdminNative]::ExitWindowsEx(0, 0x00050000)
} elseif ($Action -eq 'REQUEST_RESTART') {
    $ok = [OmegaAdminNative]::ExitWindowsEx(2, 0x00050000)
} elseif ($Action -eq 'REQUEST_SHUTDOWN') {
    $ok = [OmegaAdminNative]::ExitWindowsEx(1, 0x00050000)
}

if (-not $ok) {
    Emit-Result ([PSCustomObject]@{ ok = $false; action = $Action; error = 'ACCESS_DENIED' })
    exit 0
}

Emit-Result ([PSCustomObject]@{ ok = $true; action = $Action; accepted = $true })
