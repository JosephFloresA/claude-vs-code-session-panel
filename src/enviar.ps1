<#
.SYNOPSIS
  Envia un mensaje a una conversacion de Claude Code que ya esta abierta en VS Code.

.DESCRIPTION
  La extension de VS Code no acepta texto externo cuando la pestana ya esta abierta (solo la enfoca).
  Este script lo resuelve simulando lo que haria la persona:
    1. (Opcional) abre vscode://anthropic.claude-code/open?session=<id> para enfocar la pestana.
    2. Espera a que la ventana en primer plano sea VS Code y que su titulo (la pestana activa) coincida
       con el titulo de la sesion. Si no coincide, NO escribe nada: evita pegar en otro archivo o sesion.
    3. Copia el texto al portapapeles y envia Ctrl+V y Enter.

  El panel lo llama con -InputFile (JSON {text, titles}); se puede usar a mano con -Session y -Text.
  Escribe en la salida un JSON {ok, reason, window}. Razones: sent, dry_run, no_text, no_vscode, title_mismatch.

.EXAMPLE
  powershell -STA -NoProfile -ExecutionPolicy Bypass -File enviar.ps1 -Session 3b56...-c3f6 -Text "dale" -Title "Monitoreo de conversaciones"
#>
param(
  [string]$InputFile,
  [string]$Session,
  [string]$Text,
  [string[]]$Title = @(),
  [switch]$NoOpen,
  [switch]$DryRun,   # comprueba foco y titulo, pero no pega ni envia
  [ValidateSet("enviar", "cerrar")][string]$Accion = "enviar",   # cerrar: mismo enfoque y verificacion, pero Ctrl+F4
  [int]$TimeoutMs = 10000
)
$ErrorActionPreference = "Stop"

function Out-Result($ok, $reason, $window) {
  @{ ok = $ok; reason = $reason; window = $window } | ConvertTo-Json -Compress
  exit 0
}

$titles = @($Title)
if ($InputFile) {
  $raw = [IO.File]::ReadAllText($InputFile, [Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $InputFile -Force -ErrorAction SilentlyContinue
  $in = $raw | ConvertFrom-Json
  $Text = [string]$in.text
  if ($in.titles) { $titles = @($in.titles) }
  if ($in.session) { $Session = [string]$in.session }
  if ($in.no_open) { $NoOpen = $true }
  if ($in.accion -eq "cerrar") { $Accion = "cerrar" }
}
if ($Accion -eq "enviar" -and (-not $Text -or -not $Text.Trim())) { Out-Result $false "no_text" "" }
$titles = @($titles | Where-Object { $_ -and $_.Trim().Length -ge 4 } | ForEach-Object { $_.Trim() })

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class MonW {
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int cmd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] public static extern uint GetCurrentThreadId();
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static void Key(byte vk, bool up) { keybd_event(vk, 0, up ? 2u : 0u, UIntPtr.Zero); }
  // Trae una ventana al frente de forma fiable desde un proceso en segundo plano (restriccion de foreground
  // de Windows): se adjunta al hilo de entrada de la ventana activa y asi SetForegroundWindow si surte efecto.
  public static void Force(IntPtr h) {
    if (IsIconic(h)) ShowWindow(h, 9);      // SW_RESTORE
    IntPtr fg = GetForegroundWindow();
    uint tmp;
    uint fgThread = GetWindowThreadProcessId(fg, out tmp);
    uint curThread = GetCurrentThreadId();
    bool attached = false;
    if (fgThread != 0 && fgThread != curThread) { attached = AttachThreadInput(curThread, fgThread, true); }
    BringWindowToTop(h);
    ShowWindow(h, 5);                        // SW_SHOW
    SetForegroundWindow(h);
    if (attached) AttachThreadInput(curThread, fgThread, false);
  }
}
"@

$ellipsis = [string][char]0x2026
function Test-TitleMatch([string]$windowTitle) {
  # Titulo de VS Code: "<pestana activa> - <carpeta o workspace> - Visual Studio Code"; la pestana puede venir truncada con "..."
  $label = ($windowTitle -split " - ")[0].Trim()
  $truncated = $label.EndsWith($ellipsis)
  $label = $label.TrimEnd([char]0x2026).TrimEnd(".").Trim()
  if ($label.Length -lt 4) { return $false }
  if ($titles.Count -eq 0) { return $true }
  foreach ($t in $titles) {
    if ($t.Equals($label, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($truncated -and $t.StartsWith($label, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# Busca, entre TODAS las ventanas de VS Code, la que tiene como pestaña activa la sesion pedida (por titulo).
function Find-Win {
  foreach ($p in @(Get-Process -Name 'Code' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) {
    if (Test-TitleMatch ([MonW]::Title($p.MainWindowHandle))) { return $p.MainWindowHandle }
  }
  return [IntPtr]::Zero
}
$canActivate = ($Session -match '^[0-9a-fA-F-]{36}$')
function Invoke-Activate { if ($canActivate) { try { Start-Process "vscode://anthropic.claude-code/open?session=$Session" | Out-Null } catch {} } }
$anyCode = { @(Get-Process -Name 'Code' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 }).Count -gt 0 }

# Primer empujon: activar la pestaña correcta (aunque VS Code no este al frente, el URI la deja como activa).
Invoke-Activate

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$matched = $false
$winTitle = ""
$cold = $false          # hubo que activar/forzar: la pestaña no estaba lista
$lastActivate = [Environment]::TickCount
while ((Get-Date) -lt $deadline) {
  $h = Find-Win
  if ($h -ne [IntPtr]::Zero) {
    # La pestaña correcta esta activa en alguna ventana. Asegurar que esa ventana quede al frente para pegar.
    if ([MonW]::GetForegroundWindow() -ne $h) { $cold = $true; [MonW]::Force($h); Start-Sleep -Milliseconds 350 }
    if ([MonW]::GetForegroundWindow() -eq $h -and (Test-TitleMatch ([MonW]::Title($h)))) {
      Start-Sleep -Milliseconds 250
      if ([MonW]::GetForegroundWindow() -eq $h) { $winTitle = [MonW]::Title($h); $matched = $true; break }
    }
  } else {
    # La sesion no es la pestaña activa de ninguna ventana: re-activarla por el URI (throttle ~1s).
    $cold = $true
    $now = [Environment]::TickCount
    if ($now - $lastActivate -gt 1000) { Invoke-Activate; $lastActivate = $now }
  }
  Start-Sleep -Milliseconds 200
}
if (-not $matched) {
  $why = if (& $anyCode) { "title_mismatch" } else { "no_vscode" }
  Out-Result $false $why $winTitle
}

if ($DryRun) { Out-Result $true "dry_run" $winTitle }
if ($Accion -eq "cerrar") {
  # La pestaña activa de la ventana al frente es la de la sesion (verificado arriba): cerrar el editor activo.
  Start-Sleep -Milliseconds 300
  if ([MonW]::GetForegroundWindow() -ne $h -or -not (Test-TitleMatch ([MonW]::Title($h)))) { Out-Result $false "title_mismatch" ([MonW]::Title($h)) }
  foreach ($vk in 0x10, 0x11, 0x12) { [MonW]::Key([byte]$vk, $true) }
  [MonW]::Key(0x11, $false); [MonW]::Key(0x73, $false); [MonW]::Key(0x73, $true); [MonW]::Key(0x11, $true)
  Out-Result $true "closed" $winTitle
}
Set-Clipboard -Value $Text

# --- Confirmacion por la transcripcion ---
# Antes se pegaba a ciegas tras una pausa fija: si la pestaña venia de otra (no era la activa), el cuadro del
# chat aun no tenia el foco, el Ctrl+V se perdia y el script decia "sent" igual (habia que mandar 2 veces).
# Ahora: foco explicito al cuadro (Ctrl+Alt+Shift+F9 = claude-vscode.focus, keybindings.json) y se confirma
# que la transcripcion registro el mensaje: el texto (sesion libre) o un "enqueue" (sesion trabajando, queda en cola).
$tp = if ($in -and $in.transcript) { [string]$in.transcript } else { "" }
$offset = -1
if ($tp -and (Test-Path -LiteralPath $tp)) { $offset = (Get-Item -LiteralPath $tp).Length }
# Trozo del texto que se buscara en la transcripcion (letras/numeros/espacios: sobrevive al escape JSON).
$snip = ([regex]::Matches($Text, '[\p{L}\p{N} ,.?!-]{8,}') | Sort-Object Length -Descending | Select-Object -First 1).Value
if ($snip) { $snip = $snip.Trim(); if ($snip.Length -gt 40) { $snip = $snip.Substring(0, 40) } }

function Test-Sent {
  if ($offset -lt 0) { return $false }
  try {
    $fs = [IO.File]::Open($tp, 'Open', 'Read', 'ReadWrite')
    try {
      if ($fs.Length -le $offset) { return $false }
      $len = [int][Math]::Min($fs.Length - $offset, 4MB)
      $buf = New-Object byte[] $len
      [void]$fs.Seek($offset, 'Begin'); [void]$fs.Read($buf, 0, $len)
      $new = [Text.Encoding]::UTF8.GetString($buf)
    } finally { $fs.Close() }
  } catch { return $false }
  if ($new.Contains('"operation":"enqueue"')) { return $true }
  if ($snip -and $new.Contains($snip)) { return $true }
  return $false
}
function Wait-Sent([int]$ms) {
  $until = (Get-Date).AddMilliseconds($ms)
  while ((Get-Date) -lt $until) { if (Test-Sent) { return $true }; Start-Sleep -Milliseconds 200 }
  return $false
}
function Still-Ours { return ([MonW]::GetForegroundWindow() -eq $h -and (Test-TitleMatch ([MonW]::Title($h)))) }
function Send-Focus {
  foreach ($vk in 0x10, 0x11, 0x12) { [MonW]::Key([byte]$vk, $true) }   # soltar modificadores colgados
  foreach ($vk in 0x11, 0x12, 0x10) { [MonW]::Key([byte]$vk, $false) }
  [MonW]::Key(0x78, $false); [MonW]::Key(0x78, $true)                     # F9
  foreach ($vk in 0x10, 0x12, 0x11) { [MonW]::Key([byte]$vk, $true) }
}
function Send-Paste { [MonW]::Key(0x11, $false); [MonW]::Key(0x56, $false); [MonW]::Key(0x56, $true); [MonW]::Key(0x11, $true) }
function Send-Enter { [MonW]::Key(0x0D, $false); [MonW]::Key(0x0D, $true) }

# Si la pestaña venia fria, VS Code tarda en revelar el webview: pausa algo mas larga antes del foco.
Start-Sleep -Milliseconds $(if ($cold) { 700 } else { 150 })
Send-Focus; Start-Sleep -Milliseconds 350
if (-not (Still-Ours)) { Out-Result $false "focus_lost" ([MonW]::Title([MonW]::GetForegroundWindow())) }
Send-Paste; Start-Sleep -Milliseconds 300
Send-Enter
if ($offset -lt 0) { Out-Result $true "sent" "$winTitle (sin confirmar: no hay transcripcion)" }
if (Wait-Sent 3500) { Out-Result $true "sent" $winTitle }

# Reintento 1: el texto quedo en el cuadro pero el Enter se perdio (Enter en un cuadro vacio no hace nada).
if (-not (Still-Ours)) { Out-Result $false "focus_lost" ([MonW]::Title([MonW]::GetForegroundWindow())) }
Send-Focus; Start-Sleep -Milliseconds 300; Send-Enter
if (Wait-Sent 2500) { Out-Result $true "sent" "$winTitle (2do Enter)" }

# Reintento 2: el pegado tambien se perdio (cuadro sin foco): pegar de nuevo y enviar.
if (-not (Still-Ours)) { Out-Result $false "focus_lost" ([MonW]::Title([MonW]::GetForegroundWindow())) }
Send-Focus; Start-Sleep -Milliseconds 400; Send-Paste; Start-Sleep -Milliseconds 300; Send-Enter
if (Wait-Sent 3500) { Out-Result $true "sent" "$winTitle (re-pegado)" }
Out-Result $false "not_confirmed" $winTitle
