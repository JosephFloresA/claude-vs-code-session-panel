# Prueba desde cero en una VM

Objetivo: instalar y usar el panel como lo haría alguien que nunca lo vio, en un Windows recién instalado, y anotar
todo lo que falla o confunde.

## 1. Preparar la VM (una vez)

1. VirtualBox 7.1+ (`winget install Oracle.VirtualBox`). Si usas WSL2, Docker o Hyper-V, activa además la
   característica de Windows **Plataforma del hipervisor de Windows** y reinicia.
2. Descarga un ISO de Windows 11: el normal de microsoft.com/software-download/windows11 (multi-edición; el script instala **Pro** sin clave, queda sin activar y no vence) o el de evaluación Enterprise (vence a los 90 días). Cualquier idioma: el script lo detecta.
3. Crea la VM (instala Windows sola, 20–40 min):
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\dev\test-vm.ps1 -Action Create -Iso C:\ruta\Win11_Eval.iso
   ```
   Anota el usuario y la contraseña que imprime.
4. Cuando aparezca el escritorio, guarda el punto de partida:
   ```powershell
   powershell -ExecutionPolicy Bypass -File scripts\dev\test-vm.ps1 -Action Snapshot
   ```

Cada prueba nueva parte de cero con `-Action Reset`.

## 2. Dentro de la VM: instalar como un usuario nuevo

Solo con lo que dice el README, sin atajos:

```powershell
winget install Git.Git OpenJS.NodeJS.LTS Microsoft.VisualStudioCode
# cerrar y abrir PowerShell para tomar el PATH nuevo
git clone https://github.com/JosephFloresA/claude-vs-code-session-panel.git
cd claude-vs-code-session-panel
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Open
```

Después: abrir VS Code, instalar la extensión **Claude Code**, iniciar sesión y abrir 2 o 3 chats en carpetas distintas
(idealmente repos git clonados en `C:\src`).

## 3. Qué verificar

| # | Prueba | Esperado |
|---|---|---|
| 1 | `panel.ps1 -Action Open` sin config.json | Arranca en 7820 y abre el navegador; sin errores en `%LOCALAPPDATA%\claude-session-panel\logs` |
| 2 | Panel sin ninguna sesión de Claude | Vista vacía entendible, sin errores en la consola del navegador |
| 3 | Abrir 2–3 chats en VS Code | Aparecen en la bandeja con título, estado y repo |
| 4 | Un chat pide permiso para un comando | Pasa a «necesita input»; aprobar desde el panel funciona |
| 5 | Enviar un mensaje desde el panel | Llega al chat correcto, una sola vez |
| 6 | Dos chats editan el mismo repo | Aparece el choque |
| 7 | `/api/diagnostico` | Raíces aprendidas = la carpeta que contiene los repos |
| 8 | Proyectos: crear uno, un hilo, editar la ficha | Se guarda; el historial muestra el cambio |
| 9 | Escribano (requiere `claude` CLI en el PATH) | El hilo se actualiza después de un turno; si no hay CLI, el panel lo dice en vez de fallar en silencio |
| 10 | `panel.ps1 -Action Install`, cerrar sesión y volver a entrar | El panel arranca solo |
| 11 | Sin `az` ni `gh` | Los PR se muestran como enlace con «sin datos», nada se rompe |
| 12 | `panel.ps1 -Action Uninstall` | Quita la tarea y detiene el panel |

Anota cada problema con: paso, qué esperabas, qué pasó y el log (`panel-7820.err.log`).
