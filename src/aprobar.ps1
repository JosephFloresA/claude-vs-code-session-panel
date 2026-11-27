<#
.SYNOPSIS
  Aprueba (Yes) o rechaza (No) el dialogo de permiso de Claude Code en VS Code, usando UI Automation.

.DESCRIPTION
  Las teclas sinteticas NO llegan al webview del dialogo (Chromium las filtra). En cambio, UI Automation
  SI ve el arbol de accesibilidad del webview cuando se consulta FromHandle(MainWindowHandle) + FindAll:
  ahi aparecen el texto del pedido y los botones Yes/No. Se pulsa el boton con InvokePattern/SelectionItem
  o, si no exponen patron, con un clic fisico real (mouse_event) en el centro de su rectangulo.
  NO se salta ninguna politica: automatiza el mismo clic que haria la persona.

  Decision:
    keys con "1"            -> Si  (pulsa el "Yes" SENCILLO; nunca "Yes, and don't ask again" / "allow all")
    keys con "2" o "esc"    -> No  (pulsa el boton de rechazo)
  Tambien acepta -Decision Si|No directo.

  El panel lo llama con -InputFile (JSON {keys, titles, session}). Devuelve una linea JSON:
    { ok, reason, decision, button?, how?, window? }
  Razones: clicked, dry_run (ok) · no_vscode, title_mismatch, no_dialog, no_button, unsupported_keys (fallo).

.EXAMPLE
  powershell -STA -NoProfile -ExecutionPolicy Bypass -File aprobar.ps1 -Decision Si -Title "Monitoreo de conversaciones" -DryRun
#>
param(
  [string]$InputFile,
  [string]$Session,
  [string[]]$Title = @(),
  [string[]]$Keys = @(),
  [ValidateSet('Si', 'No', '')][string]$Decision = '',
  [string[]]$Options = @(),   # AskUserQuestion: etiqueta(s) de opcion a elegir (luego pulsa "Submit answers")
  [switch]$DryRun,            # detecta y elige el boton, pero NO lo pulsa
  [switch]$Dump,             # diagnostico: lista TODOS los botones de la ventana (para sondear AskUserQuestion)
  [int]$TimeoutMs = 10000
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
  if ($in.keys) { $Keys = @($in.keys) }
  if ($in.titles) { $titles = @($in.titles) }
  if ($in.session) { $Session = [string]$in.session }
  if ($in.decision) { $Decision = [string]$in.decision }
  if ($in.options) { $Options = @($in.options) }
}
$Options = @($Options | Where-Object { $_ -and ([string]$_).Trim() } | ForEach-Object { ([string]$_).Trim() })

# Decidir Si/No a partir de las teclas que manda el panel.
if (-not $Decision) {
  $k = @($Keys | ForEach-Object { ([string]$_).ToLower() })
  if ($k -contains '1') { $Decision = 'Si' }
  elseif (($k -contains '2') -or ($k -contains 'esc')) { $Decision = 'No' }
}
if (-not $Dump -and $Options.Count -eq 0 -and $Decision -ne 'Si' -and $Decision -ne 'No') { Out-Result $false 'unsupported_keys' @{ keys = ($Keys -join '+') } }

$titles = @($titles | Where-Object { $_ -and $_.Trim().Length -ge 4 } | ForEach-Object { $_.Trim() })

Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
if (-not ('MClk' -as [type])) {
  Add-Type -TypeDefinition @"
using System; using System.Runtime.InteropServices;
public static class MClk {
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int X, int Y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint dx, uint dy, uint d, UIntPtr e);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  public static void ClickAt(int x, int y) {
    SetCursorPos(x, y);
    mouse_event(0x0002, (uint)x, (uint)y, 0, UIntPtr.Zero);  // LEFTDOWN
    mouse_event(0x0004, (uint)x, (uint)y, 0, UIntPtr.Zero);  // LEFTUP
  }
}
"@
}

$AE = [System.Windows.Automation.AutomationElement]
$CT = [System.Windows.Automation.ControlType]
$TS = [System.Windows.Automation.TreeScope]
$WALK = [System.Windows.Automation.TreeWalker]::ControlViewWalker
$BTN_COND = New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $CT::Button)
# Tipos que pueden ser una opcion de AskUserQuestion (no siempre son Button: a veces radio/listitem/checkbox).
$OPT_TYPES = @($CT::Button, $CT::RadioButton, $CT::ListItem, $CT::CheckBox, $CT::MenuItem, $CT::Hyperlink, $CT::TreeItem, $CT::Text)
$OPT_COND = [System.Windows.Automation.OrCondition]::new([System.Windows.Automation.Condition[]]@(
  $OPT_TYPES | ForEach-Object { New-Object System.Windows.Automation.PropertyCondition($AE::ControlTypeProperty, $_) }))

$ellipsis = [string][char]0x2026
function Test-TitleMatch([string]$winTitle) {
  $label = ($winTitle -split " - ")[0].Trim()
  $trunc = $label.EndsWith($ellipsis)
  $label = $label.TrimEnd([char]0x2026).TrimEnd(".").Trim()
  if ($label.Length -lt 4) { return $false }
  if ($titles.Count -eq 0) { return $true }
  foreach ($t in $titles) {
    if ($t.Equals($label, [StringComparison]::OrdinalIgnoreCase)) { return $true }
    if ($trunc -and $t.StartsWith($label, [StringComparison]::OrdinalIgnoreCase)) { return $true }
  }
  return $false
}

# El "Yes" de aprobar: nunca el que ademas desactiva futuras preguntas o permite todo.
$yesExclude = '(again|all edits|allow all|this session|siempre|no volver|don''t ask|dont ask)'
$yesRe = '^(\d+\s*[:\.\)]?\s*)?(Yes|S[ií]|Allow|Approve|Accept)\b'
$noRe  = '^(\d+\s*[:\.\)]?\s*)?(No|Deny|Reject|Cancel)\b'

function Named($elems) { @($elems | ForEach-Object { [pscustomobject]@{ El = $_; Name = $_.Current.Name } } | Where-Object { $_.Name }) }

# Accionable = se puede pulsar/seleccionar (Button, o con patron Invoke/SelectionItem/Toggle). Excluye texto puro.
function Is-Actionable($el) {
  if ($el.Current.ControlType -eq $CT::Button) { return $true }
  $p = $null
  if ($el.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { return $true }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { return $true }
  if ($el.TryGetCurrentPattern([System.Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { return $true }
  return $false
}

function Invoke-El($el, $hwnd, [switch]$ForceClick) {
  # The VS Code webview sometimes throws "Unrecognized error" (E_FAIL) on InvokePattern.Invoke() for an option that
  # is perfectly clickable, and sometimes Invoke() returns without doing anything (seen on a clean Windows 11 VM,
  # 2026-11-26). Each pattern is tried inside try/catch and, if none works (or -ForceClick), it does a real mouse
  # click on the element's centre. Callers that can check the effect retry with -ForceClick.
  $cur = $el
  for ($i = 0; $i -lt 4 -and $null -ne $cur -and -not $ForceClick; $i++) {
    $p = $null
    if ($cur.TryGetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern, [ref]$p)) {
      try { ([System.Windows.Automation.InvokePattern]$p).Invoke(); return 'invoke' } catch { }
    }
    $s = $null
    if ($cur.TryGetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern, [ref]$s)) {
      try { ([System.Windows.Automation.SelectionItemPattern]$s).Select(); return 'select' } catch { }
    }
    try { $cur = $WALK.GetParent($cur) } catch { $cur = $null }
  }
  $r = $el.Current.BoundingRectangle
  # Never a mouse click on something off screen (e.g. chat history scrolled away: negative coordinates).
  if (-not $r.IsEmpty -and $r.Width -gt 0 -and $r.Height -gt 0 -and -not $el.Current.IsOffscreen) {
    if ($hwnd -ne [IntPtr]::Zero) { [void][MClk]::SetForegroundWindow($hwnd); Start-Sleep -Milliseconds 120 }
    $cx = [int][Math]::Round($r.Left + ($r.Width / 2.0)); $cy = [int][Math]::Round($r.Top + ($r.Height / 2.0))
    [MClk]::ClickAt($cx, $cy); return 'click'
  }
  return $null
}

# Activa (o re-activa) la pestaña de la sesion por el URI de la extension. NO depende del foco: VS Code procesa
# el URI aunque este en segundo plano, y deja esa conversacion como pestaña activa (su titulo pasa a coincidir).
$canActivate = (-not $Dump) -and ($Session -match '^[0-9a-fA-F-]{36}$')
function Invoke-Activate { if ($canActivate) { try { Start-Process "vscode://anthropic.claude-code/open?session=$Session" | Out-Null } catch {} } }

$deadline = (Get-Date).AddMilliseconds($TimeoutMs)
$lastReason = 'no_vscode'
$lastActivate = 0
# Primer empujon: pedir la activacion de la pestaña correcta desde el arranque.
Invoke-Activate
while ((Get-Date) -lt $deadline) {
  $procs = @(Get-Process -Name 'Code' -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 })
  if ($procs.Count -eq 0) { $lastReason = 'no_vscode' }
  $anyTitleOk = $false
  foreach ($pr in $procs) {
    $titleOk = Test-TitleMatch $pr.MainWindowTitle
    if ($titleOk) { $anyTitleOk = $true }
    # Para elegir/aprobar exigimos el titulo (la sesion correcta). El -Dump no, para poder sondear cualquier ventana.
    if (-not $Dump -and -not $titleOk) { $lastReason = 'title_mismatch'; continue }
    $win = $AE::FromHandle($pr.MainWindowHandle)
    if ($null -eq $win) { continue }

    if ($Dump) {
      # Lista elementos (con su tipo) de la ventana que tenga "Submit answers", para ver como se llaman las opciones.
      $els = Named (@($win.FindAll($TS::Descendants, $OPT_COND)))
      # El "Submit answers" debe ser accionable (un boton real), no texto del chat que mencione la frase.
      if (@($els | Where-Object { ($_.Name -match 'Submit answers') -and (Is-Actionable $_.El) }).Count -eq 0) { $lastReason = 'no_dialog'; continue }
      $list = @($els | ForEach-Object { "$(($_.El.Current.ControlType.ProgrammaticName -replace 'ControlType\.','')): $($_.Name)" } | Select-Object -Unique -First 150)
      Out-Result $true 'dump' @{ window = $pr.MainWindowTitle; elements = $list }
    }

    # ---- AskUserQuestion (preferencias): elegir opcion(es) y pulsar "Submit answers" ----
    if ($Options.Count -gt 0) {
      # Las opciones pueden ser radio/listitem/checkbox, no solo Button: se busca en tipos amplios y accionables.
      $winEls = Named (@($win.FindAll($TS::Descendants, $OPT_COND)))
      $submit = @($winEls | Where-Object { ($_.Name -match 'Submit answers|Enviar respuestas') -and (Is-Actionable $_.El) -and -not $_.El.Current.IsOffscreen })
      if ($submit.Count -eq 0) { $lastReason = 'no_dialog'; continue }   # sin "Submit answers" accionable no es un AskUserQuestion
      # Only the OPEN question: its options live in the same container as "Submit answers"
      # (class permissionRequestContainer_*). Answered questions in the chat history are RadioButtons too, with the
      # same kind of names but off screen: matching the whole window clicked those and nothing happened.
      $box = $WALK.GetParent($submit[0].El)
      for ($i = 0; $i -lt 4 -and $null -ne $box -and $box.Current.ClassName -notlike 'permissionRequestContainer*'; $i++) { $box = $WALK.GetParent($box) }
      if ($null -eq $box) { $box = $WALK.GetParent($submit[0].El) }
      $els = @(Named (@($box.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition))) | Where-Object { -not $_.El.Current.IsOffscreen })
      $clicked = @()
      $findOpt = {
        param($all, $opt)
        @($all | Where-Object {
          $nm = $_.Name.Trim()
          ($nm -notmatch 'Submit answers') -and (Is-Actionable $_.El) -and (
            $nm -ieq $opt -or
            $nm.StartsWith($opt, [StringComparison]::OrdinalIgnoreCase) -or
            $opt.StartsWith($nm, [StringComparison]::OrdinalIgnoreCase) -or
            $nm -match ('(^|\s)' + [regex]::Escape($opt) + '($|\s)')
          )
        } | Sort-Object -Property @{ Expression = { $_.Name.Length } })
      }
      foreach ($opt in $Options) {
        $cand = & $findOpt $els $opt
        if ($cand.Count) { if (Invoke-El $cand[0].El $pr.MainWindowHandle) { $clicked += $cand[0].Name; Start-Sleep -Milliseconds 220 } }
      }
      if ($clicked.Count -eq 0) {
        # Diagnostico: que opciones accionables se vieron (para afinar el match del nombre).
        $seen = @($els | Where-Object { (Is-Actionable $_.El) -and ($_.Name -notmatch 'Submit answers') } | ForEach-Object { $_.Name.Trim() } | Where-Object { $_ } | Select-Object -Unique -First 40)
        Out-Result $false 'no_button' @{ want = ($Options -join '|'); seen = $seen; window = $pr.MainWindowTitle }
      }
      if ($DryRun) { Out-Result $true 'dry_run' @{ mode = 'choice'; clicked = $clicked; window = $pr.MainWindowTitle } }
      Start-Sleep -Milliseconds 200
      # Re-escanear y enviar (el "Submit answers" puede haberse habilitado al seleccionar).
      $submitRe = '(^|\s)Submit answers\s*$|Enviar respuestas'
      $findSubmit = { @(Named (@($win.FindAll($TS::Descendants, $OPT_COND))) | Where-Object { ($_.Name -match $submitRe) -and (Is-Actionable $_.El) -and -not $_.El.Current.IsOffscreen }) }
      $submit2 = & $findSubmit
      if ($submit2.Count) { [void](Invoke-El $submit2[0].El $pr.MainWindowHandle) }
      # Verify: the question is answered only if its "Submit answers" button is gone. UIA can report success and do
      # nothing, so if it is still there, repeat with real mouse clicks (option + submit) and check again.
      Start-Sleep -Milliseconds 900
      $how = 'uia'
      if ((& $findSubmit).Count) {
        $how = 'mouse'
        # Same container rule as above (never the off-screen history), re-read after the first attempt.
        $box2 = $WALK.GetParent((& $findSubmit)[0].El)
        for ($i = 0; $i -lt 4 -and $null -ne $box2 -and $box2.Current.ClassName -notlike 'permissionRequestContainer*'; $i++) { $box2 = $WALK.GetParent($box2) }
        if ($null -eq $box2) { $box2 = $box }
        $els2 = @(Named (@($box2.FindAll($TS::Descendants, [System.Windows.Automation.Condition]::TrueCondition))) | Where-Object { -not $_.El.Current.IsOffscreen })
        foreach ($opt in $Options) {
          $cand = & $findOpt $els2 $opt
          if ($cand.Count) { [void](Invoke-El $cand[0].El $pr.MainWindowHandle -ForceClick); Start-Sleep -Milliseconds 300 }
        }
        $submit3 = & $findSubmit
        if ($submit3.Count) { [void](Invoke-El $submit3[0].El $pr.MainWindowHandle -ForceClick) }
        Start-Sleep -Milliseconds 1200
      }
      if ((& $findSubmit).Count) { Out-Result $false 'not_applied' @{ clicked = $clicked; how = $how; window = $pr.MainWindowTitle } }
      Out-Result $true 'chosen' @{ clicked = $clicked; submitted = $true; how = $how; window = $pr.MainWindowTitle }
    }

    # Botones del dialogo: filtro nativo de UIA (ControlType = Button). Una sola pasada, rapida.
    # El texto del chat que diga "Sí/No/Yes" NO es un boton, asi que no se confunde con el dialogo.
    $btns = Named (@($win.FindAll($TS::Descendants, $BTN_COND)))
    $yes = @($btns | Where-Object { ($_.Name -match $yesRe) -and ($_.Name -notmatch $yesExclude) })
    $no  = @($btns | Where-Object { $_.Name -match $noRe })
    # Hay dialogo solo si aparecen a la vez un boton Yes y un boton No (no basta uno suelto).
    if (-not (($yes.Count -gt 0) -and ($no.Count -gt 0))) { $lastReason = 'no_dialog'; continue }

    $cands = if ($Decision -eq 'Si') { $yes } else { $no }
    # Nombre mas corto primero: el "Yes"/"No" sencillo frente a variantes largas.
    $ordered = @($cands | Sort-Object -Property @{ Expression = { $_.Name.Length } })

    if ($DryRun) { Out-Result $true 'dry_run' @{ decision = $Decision; button = $ordered[0].Name; window = $pr.MainWindowTitle; count = $ordered.Count } }

    foreach ($c in $ordered) {
      $how = Invoke-El $c.El $pr.MainWindowHandle
      if ($how) { Out-Result $true 'clicked' @{ decision = $Decision; button = $c.Name; how = $how; window = $pr.MainWindowTitle } }
    }
    $lastReason = 'no_button'
  }
  # Si ninguna ventana muestra la sesion como pestaña activa, re-activarla por el URI y reintentar.
  if ($canActivate -and -not $anyTitleOk) {
    $now = [Environment]::TickCount
    if ($now - $lastActivate -gt 1200) { Invoke-Activate; $lastActivate = $now }
  }
  Start-Sleep -Milliseconds 350
}
Out-Result $false $lastReason @{ decision = $Decision }
