# panel.ps1 - Levanta, detiene e instala el panel de sesiones de Claude Code (Windows PowerShell 5.1+).
#
#   powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 [-Action <accion>] [-Port N] [-Config <ruta>]
#
#   Init       crea el config.json a partir de config.example.json (si no existe) y lo abre
#   Start      levanta el servidor (idempotente)
#   Open       lo levanta si hace falta y abre el panel en el navegador
#   Stop       lo detiene            Restart   Stop + Start
#   Status     dice si esta arriba
#   Install    registra una tarea programada que lo levanta al iniciar sesion en Windows (y lo levanta ahora)
#   Uninstall  borra la tarea y lo detiene
#
# El servidor solo escucha en 127.0.0.1. Lee ~/.claude (sesiones y transcripciones) y escribe solo en su carpeta de
# datos (%LOCALAPPDATA%\claude-session-panel) o donde diga el config.json. Varias instancias (p. ej. un sandbox):
# una por config.json, cada una con su puerto.

param(
    [ValidateSet("Init", "Start", "Stop", "Restart", "Status", "Open", "Install", "Uninstall")]
    [string]$Action = "Start",
    [int]$Port = 0,
    [string]$Config = ""
)

$ErrorActionPreference = "Stop"

$appRoot = Split-Path -Parent $PSScriptRoot
$server = Join-Path $appRoot "src\dashboard.mjs"
$dataDir = Join-Path $env:LOCALAPPDATA "claude-session-panel"
$logDir = Join-Path $dataDir "logs"

if ($Config) { $env:PANEL_CONFIG = (Resolve-Path -LiteralPath $Config -ErrorAction SilentlyContinue).Path; if (-not $env:PANEL_CONFIG) { $env:PANEL_CONFIG = $Config } }
$configFile = $env:PANEL_CONFIG
if (-not $configFile) { $configFile = Join-Path $env:APPDATA "claude-session-panel\config.json" }

function Read-PanelConfig {
    if (-not (Test-Path -LiteralPath $configFile)) { return $null }
    try { return (Get-Content -LiteralPath $configFile -Raw -Encoding UTF8) | ConvertFrom-Json } catch {
        Write-Host ("  config.json invalido ({0}): {1}" -f $configFile, $_.Exception.Message) -ForegroundColor Red
        return $null
    }
}

# Puerto: -Port > PANEL_PORT > config.json > 7820. Solo se pasa --port al servidor si vino por parametro.
$passPort = $Port -gt 0
if (-not $passPort) {
    if ($env:PANEL_PORT) { $Port = [int]$env:PANEL_PORT }
    else {
        $cfg = Read-PanelConfig
        if ($cfg -and $cfg.port) { $Port = [int]$cfg.port } else { $Port = 7820 }
    }
}
$url = "http://127.0.0.1:$Port/"
$taskName = if ($Port -eq 7820) { "Claude Session Panel" } else { "Claude Session Panel ($Port)" }

function Resolve-NodePath {
    $cmd = Get-Command node -ErrorAction SilentlyContinue
    if (-not $cmd) { throw "No se encontro node.exe. Instala Node.js 22.5 o superior (https://nodejs.org) y vuelve a intentar." }
    $v = (& $cmd.Source --version).TrimStart("v").Split(".")
    if ([int]$v[0] -lt 22 -or ([int]$v[0] -eq 22 -and [int]$v[1] -lt 5)) {
        throw ("Node {0} es muy antiguo: el panel necesita 22.5 o superior (usa node:sqlite)." -f ($v -join "."))
    }
    return $cmd.Source
}

function Test-Health {
    try {
        $r = Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 ("http://127.0.0.1:{0}/health" -f $Port)
        return ($r.Content -eq "ok")
    } catch { return $false }
}

function Get-ListenerPid {
    if (-not (Test-Health)) { return $null }
    $conn = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($conn) { return [int]$conn.OwningProcess }
    # Algunas estaciones no ven el listener con Get-NetTCPConnection: se busca por linea de comando.
    $proc = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction SilentlyContinue |
        Where-Object { $_.CommandLine -like "*dashboard.mjs*" -and $_.CommandLine -match ("--port\s+{0}(\s|$)" -f $Port) } |
        Select-Object -First 1
    if ($proc) { return [int]$proc.ProcessId }
    return -1
}

# Rota un log si pasa de 5 MB (se conserva una copia .1).
function Invoke-LogRotation([string]$file) {
    if ((Test-Path -LiteralPath $file) -and (Get-Item -LiteralPath $file).Length -gt 5MB) {
        Move-Item -LiteralPath $file -Destination "$file.1" -Force
    }
}

function Start-Panel {
    $existing = Get-ListenerPid
    if ($existing) { Write-Host ("  el panel ya estaba arriba en {0} (PID {1})" -f $url, $existing) -ForegroundColor Yellow; return }
    if (-not (Test-Path -LiteralPath $server)) { throw "Falta $server." }
    $nodePath = Resolve-NodePath
    $stdout = Join-Path $logDir ("panel-{0}.out.log" -f $Port)
    $stderr = Join-Path $logDir ("panel-{0}.err.log" -f $Port)
    Invoke-LogRotation $stdout; Invoke-LogRotation $stderr
    $argList = @("`"$server`"")
    if ($passPort) { $argList += @("--port", $Port) }
    Start-Process -FilePath $nodePath -ArgumentList $argList -WorkingDirectory $appRoot -WindowStyle Hidden `
        -RedirectStandardOutput $stdout -RedirectStandardError $stderr | Out-Null
    $found = $null
    for ($i = 0; $i -lt 24; $i++) { Start-Sleep -Milliseconds 250; $found = Get-ListenerPid; if ($found) { break } }
    if ($found) { Write-Host ("  panel arriba en {0} (PID {1})" -f $url, $found) -ForegroundColor Green }
    else {
        Write-Host ("  el panel NO arranco. Revisa {0}" -f $stderr) -ForegroundColor Red
        if (Test-Path -LiteralPath $stderr) { Get-Content -LiteralPath $stderr -Tail 5 | ForEach-Object { Write-Host "    $_" -ForegroundColor DarkGray } }
    }
}

function Stop-Panel {
    $listenerPid = Get-ListenerPid
    if (-not $listenerPid) { Write-Host "  el panel no estaba corriendo" -ForegroundColor DarkGray; return }
    if ($listenerPid -lt 0) { Write-Host "  el panel responde pero no se pudo identificar su proceso; detenlo desde el Administrador de tareas" -ForegroundColor Yellow; return }
    Stop-Process -Id $listenerPid -Force -ErrorAction SilentlyContinue
    Write-Host ("  panel detenido (PID {0})" -f $listenerPid) -ForegroundColor Green
}

function Initialize-Config {
    if (Test-Path -LiteralPath $configFile) { Write-Host ("  ya existe {0}" -f $configFile) -ForegroundColor Yellow }
    else {
        New-Item -ItemType Directory -Force -Path (Split-Path -Parent $configFile) | Out-Null
        Copy-Item -LiteralPath (Join-Path $appRoot "config.example.json") -Destination $configFile
        Write-Host ("  creado {0} (todo es opcional: edita lo que necesites)" -f $configFile) -ForegroundColor Green
    }
    Start-Process notepad.exe -ArgumentList "`"$configFile`""
}

function Install-StartupTask {
    $cfgArg = if ($env:PANEL_CONFIG) { ' -Config "{0}"' -f $env:PANEL_CONFIG } else { "" }
    $portArg = if ($passPort) { " -Port $Port" } else { "" }
    $arguments = '-ExecutionPolicy Bypass -WindowStyle Hidden -NoProfile -File "{0}" -Action Start{1}{2}' -f $PSCommandPath, $portArg, $cfgArg
    $action = New-ScheduledTaskAction -Execute "powershell.exe" -Argument $arguments
    $trigger = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME
    $principal = New-ScheduledTaskPrincipal -UserId "$env:USERDOMAIN\$env:USERNAME" -LogonType Interactive -RunLevel Limited
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
        -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $trigger -Principal $principal `
        -Settings $settings -Description "Levanta el panel local de sesiones de Claude Code." -Force | Out-Null
    Write-Host ("  tarea '{0}' registrada (se ejecuta al iniciar sesion)" -f $taskName) -ForegroundColor Green
}

function Uninstall-StartupTask {
    if (-not (Get-ScheduledTask -TaskName $taskName -ErrorAction SilentlyContinue)) {
        Write-Host ("  la tarea '{0}' no estaba registrada" -f $taskName) -ForegroundColor DarkGray; return
    }
    Unregister-ScheduledTask -TaskName $taskName -Confirm:$false
    Write-Host ("  tarea '{0}' eliminada" -f $taskName) -ForegroundColor Green
}

if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir -Force | Out-Null }

Write-Host ("== Claude session panel - puerto {0} ==" -f $Port) -ForegroundColor Cyan
switch ($Action) {
    "Init"      { Initialize-Config }
    "Install"   { Install-StartupTask; Start-Panel }
    "Uninstall" { Uninstall-StartupTask; Stop-Panel }
    "Stop"      { Stop-Panel }
    "Restart"   { Stop-Panel; Start-Panel }
    "Start"     { Start-Panel }
    "Open"      { Start-Panel; Start-Process $url }
    "Status"    {
        $listenerPid = Get-ListenerPid
        if ($listenerPid) { Write-Host ("  arriba en {0} (PID {1})" -f $url, $listenerPid) -ForegroundColor Green }
        else { Write-Host ("  caido (puerto {0} libre)" -f $Port) -ForegroundColor Red }
    }
}
