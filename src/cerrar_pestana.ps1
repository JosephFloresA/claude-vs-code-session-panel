<#
.SYNOPSIS
  Cierra la pestaña de una sesion de Claude Code en VS Code con UI Automation (sin teclado ni foco).

.DESCRIPTION
  UI Automation ve cada pestaña del editor (ControlType TabItem) con su boton "Close (Ctrl+F4)". Los titulos
  salen truncados ("Ficha del proyecto ideas…") y pueden repetirse, asi que el nombre no basta:
    1. Activa la pestaña de la sesion con vscode://anthropic.claude-code/open?session=<id> (cambia la pestaña
       activa aunque VS Code este en segundo plano).
    2. Busca en todas las ventanas de VS Code las pestañas ACTIVAS (IsSelected) cuyo titulo coincide (exacto o
       prefijo truncado) y que tengan boton Close. Exige que haya UNA sola: si hay 0 reintenta, si hay 2 o mas
       no cierra nada (ambiguous).
    3. Pulsa su Close (InvokePattern) y verifica que la pestaña desaparecio.
  NO se salta ninguna politica: es el mismo clic de la persona en la X de la pestaña.

  El panel lo llama con -InputFile (JSON {titles, session, open_url}). Devuelve una linea JSON:
    { ok, reason, tab? }   reason: closed, dry_run · no_vscode, no_tab, ambiguous, no_close_button, still_open
.EXAMPLE
  powershell -STA -NoProfile -ExecutionPolicy Bypass -File cerrar_pestana.ps1 -Title "Ficha del proyecto herramientas_claude" -DryRun
#>
param(
  [string]$InputFile,
  [string]$Session,
  [string]$OpenUrl,
  [string[]]$Title = @(),
  [switch]$DryRun,
  [int]$TimeoutMs = 12000
)
$ErrorActionPreference = "Stop"

function Out-Result($ok, $reason, $extra) {
  $o = [ordered]@{ ok = $ok; reason = $reason }
  if ($extra) { foreach ($k in $extra.Keys) { $o[$k] = $extra[$k] } }
  ([pscustomobject]$o) | ConvertTo-Json -Compress
  exit 0
}

$titles = @($Title)
if ($InputFile) {
  $raw = [IO.File]::ReadAllText($InputFile, [Text.Encoding]::UTF8)
  Remove-Item -LiteralPath $InputFile -Force -ErrorAction SilentlyContinue
  $in = $raw | ConvertFrom-Json
  if ($in.titles) { $titles = @($in.titles) }
  if ($in.session) { $Session = [string]$in.session }
  if ($in.open_url) { $OpenUrl = [string]$in.open_url }
  if ($in.dry_run) { $DryRun = $true }
}
$titles = @($titles | Where-Object { $_ -and $_.Trim().Length -ge 4 } | ForEach-Object { $_.Trim() })
if ($titles.Count -eq 0) { Out-Result $false "no_title" $null }
if (-not $OpenUrl -and $Session -match '^[0-9a-f-]{36}$') { $OpenUrl = "vscode://anthropic.claude-code/open?session=$Session" }

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
$TAB_COND = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::TabItem)
$BTN_COND = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
$ellipsis = [string][char]0x2026

function Test-NameMatch([string]$name) {
  $n = $name.Trim()
  $trunc = $n.EndsWith($ellipsis)
  $n = $n.TrimEnd([char]0x2026).TrimEnd(".").Trim()
  if ($n.Length -lt 4) { return $false }
  foreach ($t in $titles) {
    if ($t.Equals($n, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($trunc -and $t.StartsWith($n, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

function Get-CloseButton($tab) {
  foreach ($b in $tab.FindAll($TS::Descendants, $BTN_COND)) { if ($b.Current.Name -match '^(Close|Cerrar)\b') { return $b } }
  return $null
}

# Pestañas de editor (con boton Close) cuyo titulo coincide; marca si estan activas.
function Find-Tabs {
  $out = @()
  $wins = @(Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  foreach ($p in $wins) {
    try { $root = $AE::FromHandle($p.MainWindowHandle) } catch { continue }
    foreach ($t in $root.FindAll($TS::Descendants, $TAB_COND)) {
      $name = $t.Current.Name
      if (-not $name -or -not (Test-NameMatch $name)) { continue }
      $close = Get-CloseButton $t
      if (-not $close) { continue }
      $sel = $null; $isSel = $false
      if ($t.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$sel)) { $isSel = $sel.Current.IsSelected }
      $out += [pscustomobject]@{ Tab = $t; Name = $name; Close = $close; Selected = $isSel; Window = $p.MainWindowTitle }
    }
  }
  return ,$out
}

if (-not (Get-Process Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })) { Out-Result $false "no_vscode" $null }

$sw = [Diagnostics.Stopwatch]::StartNew()
$lastOpen = -5000
$target = $null; $seen = 0
while ($sw.ElapsedMilliseconds -lt $TimeoutMs) {
  if ($OpenUrl -and ($sw.ElapsedMilliseconds - $lastOpen) -ge 2500) {
    try { Start-Process $OpenUrl } catch {}
    $lastOpen = $sw.ElapsedMilliseconds
    Start-Sleep -Milliseconds 700
  }
  $tabs = Find-Tabs
  $seen = $tabs.Count
  $active = @($tabs | Where-Object { $_.Selected })
  if ($active.Count -gt 1) { Out-Result $false "ambiguous" @{ tabs = @($active | ForEach-Object { $_.Name }) } }
  if ($active.Count -eq 1) { $target = $active[0]; break }
  # Sin URI (o si no activa nada) y una sola pestaña con ese titulo en todo VS Code: tambien es inequivoca.
  if (-not $OpenUrl -and $tabs.Count -eq 1) { $target = $tabs[0]; break }
  Start-Sleep -Milliseconds 500
}
if (-not $target) { Out-Result $false "no_tab" @{ seen = $seen } }
if ($DryRun) { Out-Result $true "dry_run" @{ tab = $target.Name; window = $target.Window } }

$inv = $null
if ($target.Close.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$inv)) { $inv.Invoke() }
else { Out-Result $false "no_close_button" @{ tab = $target.Name } }

# Verificacion: el elemento de la pestaña deja de existir (o deja de estar en la lista).
$gone = $false
for ($i = 0; $i -lt 10; $i++) {
  Start-Sleep -Milliseconds 300
  try { $null = $target.Tab.Current.Name; $alive = -not $target.Tab.Current.IsOffscreen } catch { $alive = $false }
  if (-not $alive) { $gone = $true; break }
  $still = @(Find-Tabs | Where-Object { $_.Selected -and $_.Name -eq $target.Name })
  if ($still.Count -eq 0) { $gone = $true; break }
}
if (-not $gone) { Out-Result $false "still_open" @{ tab = $target.Name } }
Out-Result $true "closed" @{ tab = $target.Name }
