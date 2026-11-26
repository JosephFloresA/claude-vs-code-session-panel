# test-vm.ps1 - Clean Windows 11 virtual machine (VirtualBox) to try the panel as a brand-new user would.
#
#   powershell -ExecutionPolicy Bypass -File scripts\dev\test-vm.ps1 -Action <action> [-Iso <path>] [-Name <vm>]
#
#   Create    creates the VM (EFI + TPM 2.0 + Secure Boot) and installs Windows unattended from the ISO
#   Start     starts the VM window
#   Snapshot  saves the current state as "clean-windows" (do it right after the first login, before installing anything)
#   Reset     powers off and goes back to the "clean-windows" snapshot (start every test from zero)
#   Status    VM state and snapshots
#   Delete    removes the VM and its disk
#
# Requirements: VirtualBox 7.1+ and, if WSL2/Docker/Hyper-V are active, the Windows feature "Windows Hypervisor
# Platform" (HypervisorPlatform) enabled. ISO: Windows 11 Enterprise evaluation (90 days, free) from the Microsoft
# Evaluation Center, or the normal multi-edition ISO (installs -Edition, Pro by default, unactivated). The guest user
# and its password are printed at the end of Create.

param(
    [ValidateSet("Create", "Start", "Snapshot", "Reset", "Status", "Delete")]
    [string]$Action = "Status",
    [string]$Iso = "",
    [string]$Name = "panel-test-win11",
    [int]$MemoryMB = 8192,
    [int]$Cpus = 4,
    [int]$DiskGB = 80,
    [string]$BaseFolder = "",
    [string]$User = "tester",
    [string]$TimeZone = "UTC",
    # Multi-edition ISOs (the normal consumer one): which edition to install. Ignored for single-edition ISOs.
    [string]$Edition = "Windows 11 Pro",
    # Optional. Without a key a consumer ISO installs unactivated (fine for testing).
    [string]$ProductKey = ""
)

$ErrorActionPreference = "Stop"
$vbox = Join-Path $env:ProgramFiles "Oracle\VirtualBox\VBoxManage.exe"
if (-not (Test-Path -LiteralPath $vbox)) { throw "VirtualBox not found. Install it: winget install Oracle.VirtualBox" }
if (-not $BaseFolder) { $BaseFolder = Join-Path $env:USERPROFILE "VirtualBox VMs" }
$snapName = "clean-windows"

function Invoke-VBox {
    # VBoxManage writes progress bars to stderr: in Windows PowerShell 5.1 that is a terminating error under
    # ErrorActionPreference=Stop, so only the exit code decides here.
    $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
    try { $out = & $vbox @args 2>&1 | ForEach-Object { "$_" } } finally { $ErrorActionPreference = $prev }
    if ($LASTEXITCODE -ne 0) { throw ("VBoxManage {0} failed:`n{1}" -f ($args -join " "), ($out | Out-String)) }
    return $out
}
function Test-Vm { (& $vbox list vms 2>$null) -match ('^"{0}" ' -f [regex]::Escape($Name)) }
function Get-VmState {
    $info = & $vbox showvminfo $Name --machinereadable 2>$null
    $line = $info | Where-Object { $_ -like 'VMState=*' } | Select-Object -First 1
    if ($line) { return $line.Split("=")[1].Trim('"') } return "missing"
}
function Stop-Vm {
    if ((Get-VmState) -eq "running") { & $vbox controlvm $Name poweroff 2>$null | Out-Null; Start-Sleep -Seconds 3 }
}

function New-TestVm {
    if (-not $Iso -or -not (Test-Path -LiteralPath $Iso)) { throw "Pass -Iso with the Windows 11 ISO path." }
    if (Test-Vm) { throw "A VM named '$Name' already exists. Use -Action Delete first or another -Name." }

    # Language of the ISO: the unattended setup fails if the locale does not match the image.
    $detect = Invoke-VBox unattended detect "--iso=$Iso" --machine-readable
    $langLine = $detect | Where-Object { $_ -like 'OSLanguages=*' } | Select-Object -First 1
    $lang = if ($langLine) { $langLine.Split("=")[1].Trim('"').Split(",")[0] } else { "en-US" }
    $locale = $lang.Replace("-", "_")
    $country = if ($lang -match "-(\w\w)$") { $Matches[1].ToUpper() } else { "US" }
    Write-Host ("  ISO language: {0}" -f $lang) -ForegroundColor DarkGray

    # Edition: ImageIndexN="Windows 11 Pro (10.0... / x64 / en-US)". Exact name, so "Pro" does not pick "Pro N".
    $images = @($detect | Where-Object { $_ -match '^ImageIndex(\d+)="(.+?) \(' } | ForEach-Object {
        if ($_ -match '^ImageIndex(\d+)="(.+?) \(') { [pscustomobject]@{ Index = [int]$Matches[1]; Name = $Matches[2] } } })
    $imageArgs = @()
    if ($images.Count -gt 1) {
        $img = $images | Where-Object { $_.Name -eq $Edition } | Select-Object -First 1
        if (-not $img) { throw ("Edition '{0}' not in the ISO. Available: {1}" -f $Edition, (($images | ForEach-Object Name) -join ", ")) }
        $imageArgs = @("--image-index=$($img.Index)")
        Write-Host ("  edition: {0} (index {1})" -f $img.Name, $img.Index) -ForegroundColor DarkGray
    }
    if ($ProductKey) { $imageArgs += "--key=$ProductKey" }

    $chars = "abcdefghijkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789".ToCharArray()
    $password = -join (1..14 | ForEach-Object { $chars | Get-Random }) + "!7"

    Invoke-VBox createvm --name $Name --ostype Windows11_64 --register --basefolder $BaseFolder | Out-Null
    Invoke-VBox modifyvm $Name --memory $MemoryMB --cpus $Cpus --firmware efi --tpm-type 2.0 `
        --graphicscontroller vboxsvga --vram 128 --nic1 nat --mouse usbtablet --usb-xhci on `
        --clipboard-mode bidirectional --drag-and-drop bidirectional --audio-enabled off | Out-Null

    $disk = Join-Path (Join-Path $BaseFolder $Name) "$Name.vdi"
    Invoke-VBox createmedium disk --filename $disk --size ($DiskGB * 1024) --variant Standard | Out-Null
    Invoke-VBox storagectl $Name --name SATA --add sata --controller IntelAhci --portcount 3 | Out-Null
    Invoke-VBox storageattach $Name --storagectl SATA --port 0 --device 0 --type hdd --medium $disk | Out-Null

    # Secure Boot with the Microsoft keys (Windows 11 setup checks for TPM 2.0 + Secure Boot).
    Invoke-VBox modifynvram $Name inituefivarstore | Out-Null
    Invoke-VBox modifynvram $Name enrollmssignatures | Out-Null
    Invoke-VBox modifynvram $Name enrollorclpk | Out-Null
    try { Invoke-VBox modifynvram $Name secureboot --enable | Out-Null } catch { Write-Host "  (secureboot --enable not supported by this VirtualBox; keys are enrolled)" -ForegroundColor DarkGray }

    Invoke-VBox unattended install $Name "--iso=$Iso" "--user=$User" "--password=$password" "--full-user-name=$User" `
        "--locale=$locale" "--country=$country" "--time-zone=$TimeZone" "--hostname=$Name.local" --install-additions @imageArgs | Out-Null
    Invoke-VBox startvm $Name --type gui | Out-Null

    Write-Host ""
    Write-Host "  VM '$Name' created and Windows setup started (20-40 min, reboots on its own)." -ForegroundColor Green
    Write-Host ("  Guest user: {0}   password: {1}" -f $User, $password) -ForegroundColor Yellow
    Write-Host "  When the desktop appears: -Action Snapshot (before installing anything)." -ForegroundColor Cyan
}

switch ($Action) {
    "Create"   { New-TestVm }
    "Start"    { Invoke-VBox startvm $Name --type gui | Out-Null; Write-Host "  started" -ForegroundColor Green }
    "Snapshot" {
        $existing = & $vbox snapshot $Name list --machinereadable 2>$null
        if ($existing -match ('="{0}"' -f $snapName)) { Invoke-VBox snapshot $Name delete $snapName | Out-Null }
        Invoke-VBox snapshot $Name take $snapName --description "Fresh Windows, nothing installed" --live | Out-Null
        Write-Host "  snapshot '$snapName' saved" -ForegroundColor Green
    }
    "Reset"    {
        Stop-Vm
        Invoke-VBox snapshot $Name restore $snapName | Out-Null
        Invoke-VBox startvm $Name --type gui | Out-Null
        Write-Host "  back to '$snapName' and started" -ForegroundColor Green
    }
    "Status"   {
        if (-not (Test-Vm)) { Write-Host "  VM '$Name' does not exist" -ForegroundColor DarkGray; break }
        Write-Host ("  {0}: {1}" -f $Name, (Get-VmState))
        & $vbox snapshot $Name list 2>$null
    }
    "Delete"   {
        if (Test-Vm) { Stop-Vm; Invoke-VBox unregistervm $Name --delete | Out-Null }
        # A disk left by an interrupted Create is registered but not attached: unregistervm does not remove it.
        $vmDir = Join-Path $BaseFolder $Name
        $disk = Join-Path $vmDir "$Name.vdi"
        if (Test-Path -LiteralPath $disk) {
            $prev = $ErrorActionPreference; $ErrorActionPreference = "Continue"
            & $vbox closemedium disk $disk --delete 2>&1 | Out-Null
            $ErrorActionPreference = $prev
        }
        if (Test-Path -LiteralPath $vmDir) { Remove-Item -LiteralPath $vmDir -Recurse -Force }
        Write-Host "  VM '$Name' deleted" -ForegroundColor Green
    }
}
