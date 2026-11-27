# Claude VS Code Session Panel

Panel web local para seguir, priorizar y manejar muchas conversaciones de **Claude Code** abiertas en
**VS Code** a la vez, con una memoria por proyecto (ficha + hilos) que permite retomar trabajo en un chat
nuevo sin reabrir conversaciones gigantes.

**¿Primera vez?** Empieza por la [guía de uso](docs/guia-de-uso.md): qué es, cómo instalarlo y cómo usarlo en el día a día.

> [!WARNING]
> **Beta y no oficial.** Proyecto personal, sin relación con Anthropic. «Claude» y «Claude Code» son marcas de
> Anthropic. El panel se apoya en detalles internos de la extensión Claude Code y de VS Code (archivos de `~/.claude`,
> textos y estructura de su interfaz) que pueden cambiar sin aviso: una actualización puede romper aprobar o enviar.
> Probado con la extensión **Claude Code 2.1.332**, VS Code en Windows 11 y Node 22, 24 y 26.
> Si algo falla, [abre un reporte](https://github.com/JosephFloresA/claude-vs-code-session-panel/issues/new/choose).

> **English summary.** A local (127.0.0.1-only) web panel for people who run many Claude Code conversations
> in VS Code at once: an inbox of sessions that need you, clash detection when two sessions edit the same
> repo, git/PR status, full-text search across transcripts, previews of generated files, and per-project
> memory (a short "project card" plus thread logs kept up to date by a cheap model). Windows + VS Code.
> UI in Spanish. Zero npm dependencies; Node ≥ 22.5.

## Qué resuelve

Cuando tienes 10 o 20 chats de Claude Code abiertos, se pierde cuál terminó, cuál te hizo una pregunta,
cuáles están tocando el mismo repo y dónde quedó cada tema. El panel lee lo que Claude Code ya escribe en tu
equipo (`~/.claude`) y te lo muestra en un solo lugar:

| Vista | Para qué |
|---|---|
| **Bandeja** | Las sesiones que te necesitan primero: pidió permiso, terminó sin que la vieras, te hizo una pregunta. Puedes leer la conversación, responder y aprobar desde el panel. |
| **Tabla / Tablero** | Todas las sesiones con estado, repo, rama, PR, work items, % de contexto usado y archivos editados. |
| **Choques** | Dos sesiones vivas editando el mismo archivo o el mismo repo (comparten rama: un commit se puede llevar los cambios de la otra). |
| **Día** | Resumen de lo que hiciste hoy por repo (base para un daily). |
| **Búsqueda** | Texto completo en todas tus transcripciones, sin importar tildes. |
| **Proyectos** | Una `ficha.md` (estado vivo, ≤ 4.500 car.) y `hilos/*.md` (bitácora por línea de trabajo) por proyecto, con historial git de cada cambio. Un «escribano» (Haiku) resume lo nuevo de cada chat en su hilo. |

## Requisitos

- **Windows 10/11** (aprobar, enviar y cerrar pestañas usa UI Automation de Windows).
- **VS Code** con la extensión oficial de **Claude Code**.
- **Node.js 22.5 o superior** (usa `node:sqlite`; no hay dependencias npm).
- **git** (historial de los proyectos).
- Opcional: **Azure CLI** con la extensión `azure-devops` (estado de PR y work items de Azure DevOps) y/o
  **GitHub CLI** `gh` (estado de PR de GitHub).

## Instalación

```powershell
git clone https://github.com/JosephFloresA/claude-vs-code-session-panel.git
cd claude-vs-code-session-panel

# 1. (opcional) crear tu configuración; sin ella funciona con valores por defecto
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Init

# 2. levantarlo y abrirlo
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Open

# 3. (opcional) que arranque solo al iniciar sesión en Windows
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Install
```

El panel queda en <http://127.0.0.1:7820/>. Otras acciones: `Status`, `Stop`, `Restart`, `Uninstall`.
Los logs quedan en `%LOCALAPPDATA%\claude-session-panel\logs`. `Install` también agrega a VS Code el atajo
`Ctrl+Alt+Shift+F9 → claude-vscode.focus`, que el panel usa para escribir en un chat (respalda antes `keybindings.json`).

Si algo falla, revisa [docs/problemas-conocidos.md](docs/problemas-conocidos.md). Por ejemplo, el VS Code «fantasma»
(procesos vivos sin ventana) se arregla con `scripts\reiniciar-vscode.ps1`.

Desde la terminal también hay un resumen sin abrir el navegador:

```powershell
npm run sessions            # tabla legible
node src/cli.mjs --md       # Markdown
node src/cli.mjs --hoy      # resumen del día
```

## Configuración

Todo es opcional. El archivo vive en `%APPDATA%\claude-session-panel\config.json` (u otra ruta con la variable
`PANEL_CONFIG`). Parte de [config.example.json](config.example.json). Las variables `PANEL_*` pisan al archivo.

| Clave | Por defecto | Qué hace |
|---|---|---|
| `port` | `7820` | Puerto local. |
| `workspaceRoots` | automáticas | Carpetas cuyos hijos directos son tus repos (p. ej. `C:/src`). Sin configurar, se deducen de las carpetas de trabajo de tus sesiones. Deciden qué repo toca cada sesión, los choques y qué archivos generados se pueden previsualizar. |
| `deprioritizedRepos` | `[]` | Repos que casi toda sesión toca (un repo de control): van al final y no cuentan para sugerir proyecto. |
| `dataDir` | `%LOCALAPPDATA%\claude-session-panel` | Base de datos, adjuntos y, si no dices otra cosa, los proyectos. |
| `projectsDir` | `<dataDir>\projects` | Carpeta de proyectos (ficha + hilos). Puede ser una carpeta compartida por tu equipo. |
| `scribe.enabled` / `scribe.model` | `true` / `haiku` | El escribano que mantiene los hilos. Usa tu `claude` CLI (`claude -p`). |
| `vscode.workspace` | — | Carpeta o `.code-workspace` que se abre si no hay ninguna ventana de VS Code. |
| `keyboard` | `true` | Enviar texto / aprobar en pestañas abiertas (UI Automation). |
| `azureDevOps.org` | — | `https://dev.azure.com/<org>`: activa `AB#` → work items y vincular historias. Los PR de ADO se consultan con la organización de su propio enlace. |
| `github.enabled` | `true` | Estado de PR de GitHub con `gh` (si está instalado). |
| `tags` | tipos genéricos | Familias de etiquetas de Proyectos: `types` (uno por proyecto), `groups` (área, equipo, cliente) y `groupsLabel`. |
| `staleHours` / `conflictHours` | `3` / `24` | Cuándo una sesión pasa a «en pausa» y la ventana para detectar choques. |

Para ver la configuración efectiva: <http://127.0.0.1:7820/api/diagnostico>.

**Varios perfiles** (por ejemplo, un sandbox con otro `CLAUDE_CONFIG_DIR`): un `config.json` por perfil con otro
`port` y `profile`, y `scripts\panel.ps1 -Config <ruta>`. Si el perfil usa otra instancia de VS Code, define
`vscode.userDataDir` y los enlaces se abren a través del servidor.

## Seguridad y privacidad

- Solo escucha en `127.0.0.1` y exige `Host: 127.0.0.1|localhost` (protección contra DNS rebinding).
- Toda escritura (POST) exige un token aleatorio por arranque que solo va dentro del HTML del panel.
- **No lo expongas en la red ni lo montes como servidor compartido**: lee todas tus transcripciones. Cada persona
  lo instala en su equipo.
- Nunca abre los `*.key` de `~/.claude/sessions` ni sirve archivos con pinta de secreto (`.env`, `*token*`, `*.pem`…).
  Solo previsualiza archivos que una sesión creó o editó y que viven dentro de tus `workspaceRoots`.
- Aprobar desde el panel es el mismo clic que harías en VS Code: no salta ninguna política de permisos.
  El auto-aceptar es por sesión, se activa a mano y nunca responde preguntas de opciones.
- Las llamadas a `az` y `gh` van sin shell (argumentos por argv).

## Desarrollo

```powershell
npm test          # node --test (sin dependencias)
npm run check     # sintaxis + que no se cuelen correos, rutas personales, tokens ni palabras prohibidas
npm start         # levanta el servidor en primer plano
```

`npm run check` lee además un `.check-forbidden.txt` local (no versionado) con palabras que nunca deben llegar
al repo (tu empresa, tu usuario…). Estructura del código: [docs/arquitectura.md](docs/arquitectura.md).

## Licencia

[MIT](LICENSE).
