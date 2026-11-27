<#
.SYNOPSIS
  Envia (Enter) el prompt que el panel dejo cargado en un chat NUEVO de VS Code (perfil real o lab).

.DESCRIPTION
  El panel abre vscode://anthropic.claude-code/open?prompt=... (flujos/abrir.mjs). La extension
  carga el texto pero no lo envia. Este script:
    1. Busca la ventana cuyo titulo calza con -TitlePattern (regex; el panel pasa config.vscode.titlePattern). Un chat nuevo se
       titula "Claude Code" hasta que la IA le pone nombre, asi que solo una ventana con un chat nuevo enfocado calza.
    2. La trae al frente, espera a que el cuadro de texto tenga el prompt y vuelve a comprobar el titulo.
    3. Pulsa Enter cada ~1,5 s mientras la ventana siga siendo ese chat nuevo, hasta que el chat pasa a
       busy en <CLAUDE_CONFIG_DIR>\sessions o tiene transcripcion (prueba de que el mensaje salio). Un Enter con el cuadro vacio no hace nada.
       Si el titulo no coincide, NO pulsa nada (el prompt queda cargado para enviarlo a mano).
  Salida: JSON {ok, reason, window}. Razones: sent, no_window, focus_lost, not_confirmed.
#>
param([int]$TimeoutMs = 20000, [int]$SettleMs = 1200, [int]$SendWindowMs = 15000,
      [string]$TitlePattern = '^Claude Code( - .+)? - Visual Studio Code( - Insiders)?$')
$ErrorActionPreference = "Stop"
function Out-Result($ok, $reason, $window) { @{ ok = $ok; reason = $reason; window = $window } | ConvertTo-Json -Compress; exit 0 }

Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices; using System.Text;
public static class LabW {
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr l);
  // Electron no siempre expone la ventana visible como MainWindowHandle: se recorren todas las ventanas de nivel superior.
  public static IntPtr FindByTitle(string pattern) {
    IntPtr found = IntPtr.Zero; var re = new System.Text.RegularExpressions.Regex(pattern);
    // Primero la ventana al frente (si calza), despues cualquier ventana visible que calce.
    IntPtr fg = GetForegroundWindow();
    if (fg != IntPtr.Zero && re.IsMatch(Title(fg))) return fg;
    EnumWindows((h, l) => { if (IsWindowVisible(h) && re.IsMatch(Title(h))) { found = h; return false; } return true; }, IntPtr.Zero);
    return found;
  }
  public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
  public static void Key(byte vk, bool up) { keybd_event(vk, 0, up ? 2u : 0u, UIntPtr.Zero); }
  public static void Force(IntPtr h) {
    if (IsIconic(h) || !IsWindowVisible(h)) ShowWindow(h, 9);   // SW_RESTORE: tambien muestra una ventana oculta
    IntPtr fg = GetForegroundWindow(); uint tmp;
    uint fgThread = GetWindowThreadProcessId(fg, out tmp); uint cur = GetCurrentThreadId(); bool att = false;
    if (fgThread != 0 && fgThread != cur) { att = AttachThreadInput(cur, fgThread, true); }
    BringWindowToTop(h); ShowWindow(h, 5); SetForegroundWindow(h);
    if (att) AttachThreadInput(cur, fgThread, false);
  }
}
"@

function Find-LabNewChat { return [LabW]::FindByTitle($TitlePattern) }

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$h = [IntPtr]::Zero
while ((Get-Date) -lt $deadline) {
  $h = Find-LabNewChat
  if ($h -ne [IntPtr]::Zero) {
    if ([LabW]::GetForegroundWindow() -ne $h) { [LabW]::Force($h); Start-Sleep -Milliseconds 350 }
    if ([LabW]::GetForegroundWindow() -eq $h) { break }
  }
  Start-Sleep -Milliseconds 250
}
if ($h -eq [IntPtr]::Zero) { Out-Result $false "no_window" "" }
# Una ventana oculta puede figurar como "primer plano" sin recibir el teclado en su cuadro de texto.
function Test-Ready { return ([LabW]::GetForegroundWindow() -eq $h) -and [LabW]::IsWindowVisible($h) -and -not [LabW]::IsIconic($h) -and ([LabW]::Title($h) -cmatch $TitlePattern) }
if (-not (Test-Ready)) { [LabW]::Force($h); Start-Sleep -Milliseconds 500 }
if (-not (Test-Ready)) { Out-Result $false "hidden" "la ventana del chat nuevo no quedo visible al frente" }

$Cfg = $env:CLAUDE_CONFIG_DIR
if (-not $Cfg) { $Cfg = Join-Path $env:USERPROFILE ".claude" }
$t0 = (Get-Date).AddSeconds(-1)
# Enviado = algun chat del lab cambio su registro (sessions\<pid>.json) a busy/waiting despues de empezar,
# o ya tiene transcripcion. Se mira solo esa carpeta (pocos archivos), no todas las transcripciones.
function Test-NewTranscript {
  foreach ($f in @(Get-ChildItem -Path (Join-Path $Cfg "sessions") -Filter *.json -ErrorAction SilentlyContinue | Where-Object { $_.LastWriteTime -gt $t0 })) {
    try { $j = Get-Content -LiteralPath $f.FullName -Raw | ConvertFrom-Json } catch { continue }
    if ($j.entrypoint -ne "claude-vscode") { continue }
    if ($j.status -and $j.status -ne "idle") { return $true }
    $key = ([string]$j.cwd) -replace '[^A-Za-z0-9]', '-'
    if (Test-Path -LiteralPath (Join-Path $Cfg "projects\$key\$($j.sessionId).jsonl")) { return $true }
  }
  return $false
}

# La extension tarda en pintar el webview y en poner el prompt en el cuadro: Enter repetido hasta confirmar.
Start-Sleep -Milliseconds $SettleMs
$until = (Get-Date).AddMilliseconds($SendWindowMs)
$presses = 0
while ((Get-Date) -lt $until) {
  if (Test-NewTranscript) { Out-Result $true "sent" "$([LabW]::Title($h)) (Enter x$presses)" }
  if (-not (Test-Ready)) {
    if ($presses -gt 0) { Start-Sleep -Milliseconds 800; if (Test-NewTranscript) { Out-Result $true "sent" "titulo cambiado tras Enter x$presses" } }
    Out-Result $false "focus_lost" ([LabW]::Title([LabW]::GetForegroundWindow()))
  }
  # Ctrl+Alt+Shift+F9 = claude-vscode.focus (keybindings.json del perfil de VS Code): foco al cuadro del chat activo.
  foreach ($vk in 0x11, 0x12, 0x10) { [LabW]::Key([byte]$vk, $false) }
  [LabW]::Key(0x78, $false); [LabW]::Key(0x78, $true)
  foreach ($vk in 0x10, 0x12, 0x11) { [LabW]::Key([byte]$vk, $true) }   # soltar Shift/Alt/Ctrl
  Start-Sleep -Milliseconds 300
  if (-not (Test-Ready)) { continue }
  [LabW]::Key(0x0D, $false); [LabW]::Key(0x0D, $true)
  $presses++
  for ($i = 0; $i -lt 6; $i++) { Start-Sleep -Milliseconds 250; if (Test-NewTranscript) { Out-Result $true "sent" "$([LabW]::Title($h)) (Enter x$presses)" } }
}
Out-Result $false "not_confirmed" "Enter x$presses sin transcripcion nueva"
