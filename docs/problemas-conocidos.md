# Problemas conocidos

## VS Code «fantasma»: la ventana desaparece y los procesos siguen vivos

**Síntoma.** La ventana de VS Code se cierra o desaparece (no está en la barra de tareas), pero en el Administrador de
tareas siguen corriendo muchos `Code.exe`. Abrir VS Code de nuevo no muestra ninguna ventana, porque el proceso vivo
se queda con el «candado» de instancia única. El panel sigue mostrando las sesiones (sus procesos `claude` siguen
vivos), pero enviar o aprobar falla con `title_mismatch` o `no_vscode`.

**Cómo salir.**

```powershell
powershell -ExecutionPolicy Bypass -File scripts\reiniciar-vscode.ps1
```

Cierra todos los `Code.exe` **solo si ninguno tiene ventana** y vuelve a abrir VS Code. Las conversaciones de Claude
Code se retoman desde su historial. Equivale a forzar el cierre de la tarea en el Administrador de tareas.

**Qué se sabe (medido el 2026-11-26 en una VM con Windows 11 limpio).**

| Hora | Hecho |
|---|---|
| 16:24–16:26 y 16:39–16:41 | El panel intentó aprobar y enviar. Cada intento abre enlaces `vscode://…`, y cada enlace lanza un `Code.exe` nuevo que entrega el enlace a la instancia abierta (en `%APPDATA%\Code\logs` queda una carpeta vacía por cada uno: 11 en total). Cuando no encontraba la pestaña, reintentaba cada ~1,2 s durante todo el intento. |
| 16:41 | Último envío: encontró la ventana, pero sin el atajo `Ctrl+Alt+Shift+F9` configurado el texto no llegó al chat (`not_confirmed`). |
| 16:41–16:46 | La ventana original desapareció. A las 16:46 no había ningún VS Code en la barra de tareas. |
| 16:50:11 | Arrancó una instancia principal nueva de VS Code (todos los `Code.exe` tienen esa hora y hay un `main.log` nuevo), con su ventana. |

Además, los enlaces repetidos abrieron varias pestañas «Claude Code» vacías en VS Code.

> Ojo al diagnosticar por SSH o desde un servicio: Windows no deja ver las ventanas de otra sesión, así que ahí
> `Get-Process Code` muestra `MainWindowHandle = 0` aunque la ventana exista. Hay que mirarlo desde el escritorio (una
> tarea programada interactiva) o con una captura de pantalla.

**Causa.** No confirmada. Ningún script del panel oculta ni cierra ventanas (solo restauran y traen al frente) ni manda
`Alt+F4`, `Ctrl+W` o `Esc`. El mismo síntoma también le ocurre a la persona usuaria sin pruebas de por medio. Hipótesis:

1. Un fallo de VS Code o de Electron (proceso de render o GPU), independiente del panel.
2. La ráfaga de `Code.exe` lanzados por enlaces `vscode://` mientras la instancia principal está ocupada.

**Mitigaciones aplicadas.**

- Los scripts del panel lanzan como máximo 3 enlaces `vscode://` por acción (antes, uno por segundo sin límite).
- `panel.ps1 -Action Install` (e `Init`) crea el atajo `Ctrl+Alt+Shift+F9 → claude-vscode.focus` que necesita el envío.
- `scripts/reiniciar-vscode.ps1` para salir del estado fantasma sin abrir el Administrador de tareas.

**Si vuelve a pasar,** anota la hora y guarda la carpeta más reciente de `%APPDATA%\Code\logs` (sobre todo `main.log`
y `window*/renderer.log`), y también `%TEMP%\monitor-aprobar.log`. Con eso se puede confirmar o descartar la hipótesis 2.

## El envío desde el panel dice `not_confirmed`

Falta el atajo `Ctrl+Alt+Shift+F9 → claude-vscode.focus` en `%APPDATA%\Code\User\keybindings.json`. Corre
`scripts\panel.ps1 -Action Install` (lo agrega con respaldo) o agrégalo a mano:

```json
{ "key": "ctrl+alt+shift+f9", "command": "claude-vscode.focus" }
```

## VirtualBox con WSL2, Docker o Hyper-V activos

Para probar en una VM (`scripts/dev/test-vm.ps1`): con el hipervisor de Windows activo, VirtualBox corre en modo
compatible («tortuga»). Funciona, pero más lento. Por eso el script usa video `vmsvga` (con `vboxsvga`, la instalación de
Windows 11 quedó en pantalla negra), resolución fija por firmware y snapshots con la VM apagada (el snapshot en vivo se
colgó). Si la integridad de memoria (aislamiento del núcleo) está activa, el hipervisor sigue encendido aunque
`hypervisorlaunchtype` esté en `Off`.

## Los choques no ven ediciones hechas con comandos de terminal

El panel detecta que dos sesiones editan el mismo archivo por las herramientas de edición de Claude (Edit, Write,
MultiEdit, NotebookEdit). Si Claude cambia un archivo con PowerShell o bash (algo frecuente en Windows), ese cambio no
queda registrado como edición y no genera choque. Es una limitación de diseño: deducir qué archivos toca un comando
arbitrario no es fiable.
