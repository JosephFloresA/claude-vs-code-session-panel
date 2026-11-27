# reiniciar-vscode.ps1 - Rescata un VS Code "fantasma": procesos Code.exe vivos pero sin ninguna ventana.
#
#   powershell -ExecutionPolicy Bypass -File scripts\reiniciar-vscode.ps1 [-Force] [-NoStart]
#
# Solo actua si NINGUN proceso de VS Code tiene ventana (un VS Code sano no se toca, salvo con -Force).
# Cierra todos los Code.exe y vuelve a abrir VS Code (las conversaciones de Claude Code se retoman desde su historial).
# Ver docs/problemas-conocidos.md.
param([switch]$Force, [switch]$NoStart)

$procs = @(Get-Process -Name Code -ErrorAction SilentlyContinue)
if ($procs.Count -eq 0) { Write-Host "  VS Code no esta corriendo." -ForegroundColor DarkGray }
else {
    $withWindow = @($procs | Where-Object { $_.MainWindowHandle -ne 0 })
    if ($withWindow.Count -gt 0 -and -not $Force) {
        Write-Host ("  VS Code tiene {0} ventana(s) abierta(s): no se toca. Usa -Force si igual quieres reiniciarlo." -f $withWindow.Count) -ForegroundColor Yellow
        exit 0
    }
    Write-Host ("  {0} procesos de VS Code sin ventana: cerrandolos..." -f $procs.Count) -ForegroundColor Cyan
    $procs | Stop-Process -Force -ErrorAction SilentlyContinue
    $deadline = (Get-Date).AddSeconds(10)
    while (@(Get-Process -Name Code -ErrorAction SilentlyContinue).Count -gt 0 -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 300 }
    $left = @(Get-Process -Name Code -ErrorAction SilentlyContinue).Count
    if ($left) { Write-Host "  quedaron $left procesos; cierralos desde el Administrador de tareas" -ForegroundColor Red; exit 1 }
    Write-Host "  VS Code cerrado." -ForegroundColor Green
}
if (-not $NoStart) {
    $exe = Join-Path $env:LOCALAPPDATA "Programs\Microsoft VS Code\Code.exe"
    if (-not (Test-Path -LiteralPath $exe)) { $cmd = Get-Command code -ErrorAction SilentlyContinue; if ($cmd) { $exe = $cmd.Source } }
    # Sin las variables VSCODE_*/ELECTRON_* que hereda una terminal de VS Code (si no, Code.exe arranca como proceso interno).
    Get-ChildItem Env: | Where-Object { $_.Name -match '^(VSCODE_|ELECTRON_)' } | ForEach-Object { Remove-Item "Env:$($_.Name)" }
    Start-Process -FilePath $exe
    Write-Host "  VS Code abierto de nuevo." -ForegroundColor Green
}
