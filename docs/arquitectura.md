# Arquitectura

Un proceso Node (sin dependencias npm) que escucha solo en `127.0.0.1`, lee lo que Claude Code y VS Code ya
escriben en el equipo y sirve un front en JavaScript plano (módulos ES, sin build).

```mermaid
flowchart LR
  subgraph Equipo["Equipo de la persona"]
    CC["Claude Code<br/>~/.claude/sessions/*.json<br/>~/.claude/projects/*/*.jsonl"]
    VS["VS Code<br/>state.vscdb (no leídas)<br/>~/.claude/ide/*.lock"]
    P["Panel (Node)<br/>127.0.0.1:7820"]
    DB[("panel.db<br/>SQLite")]
    FL["Proyectos<br/>ficha.md + hilos/*.md<br/>(repo git local)"]
    PS["PowerShell + UI Automation<br/>aprobar / enviar / cerrar"]
  end
  B["Navegador"] -->|HTTP + token| P
  P -->|lee| CC
  P -->|lee| VS
  P <--> DB
  P <-->|lee, escribe, commit| FL
  P -->|claude -p (escribano)| CC
  P --> PS --> VS
  P -.->|opcional| AZ["az / gh<br/>estado de PR y work items"]
```

## Fuentes de datos (solo lectura)

| Fuente | Qué aporta |
|---|---|
| `~/.claude/sessions/<pid>.json` | Sesiones vivas: pid, cwd, ocupada/libre, esperando permiso. Nunca se abren los `*.key`. |
| `~/.claude/projects/<slug>/<id>.jsonl` | Transcripción: título, pedidos, respuestas, herramientas, archivos editados, PR y work items citados, uso de contexto. Se lee solo la cabeza y la cola, con caché por tamaño y fecha. |
| `state.vscdb` de VS Code | Qué sesiones terminaron sin que las vieras (marca de la extensión). |
| `~/.claude/ide/*.lock` | Ventanas de VS Code vivas con la extensión. |

## Lo que escribe el panel

| Dónde | Qué |
|---|---|
| `panel.db` (SQLite, `node:sqlite`) | Lo que decides en el panel: fijar, archivar, notas, título propio, «visto», auto-aceptar. |
| Carpeta de proyectos | Fichas e hilos. Cada cambio es un commit con su autor (`panel`, `escriba`, `chat`); las ediciones externas se barren cada minuto. |
| Adjuntos | Archivos que mandas a un chat desde el panel; se borran a los 30 días. |

## Módulos (`src/`)

| Módulo | Responsabilidad |
|---|---|
| `config.mjs` | Única fuente de rutas, puertos e interruptores (`config.json` + `PANEL_*`). |
| `workspace.mjs` | Raíces de trabajo: qué repo toca una ruta, qué se puede previsualizar, raíces aprendidas. |
| `core.mjs` | Junta las fuentes en una fila por sesión, estado derivado, detalle de conversación, permiso pendiente. |
| `choques.mjs` | Sesiones que editan el mismo archivo o repo. |
| `git.mjs` | `git status` por repo y estado de PR (ADO con `az`, GitHub con `gh`), todo en caché y en segundo plano. |
| `integrations/cli.mjs` | Lanza `az` y `gh` sin shell. |
| `actividad.mjs`, `buscar.mjs`, `hoy.mjs` | Actividad reciente, búsqueda de texto completo, resumen del día. |
| `permisos.mjs`, `teclado.mjs`, `*.ps1` | Aprobar, enviar y cerrar pestañas con UI Automation; una sola cola para no pelear por el foco. |
| `flujos/` | Proyectos: `modelo` (lectura), `cambios` (escrituras), `historial` (git), `escriba` (resúmenes con `claude -p`), `sugerir`, `abrir`, `terminar`, `ado`. |
| `http/base.mjs`, `rutas/*.mjs` | Enrutador mínimo, cuerpo con límite, token en los POST; rutas agrupadas por área. |
| `static/`, `dashboard.html` | Front sin build. |

## Estados de una sesión

`necesita_input` (pidió permiso o te preguntó) → `trabajando` → `esperando` (tu turno) → `en_pausa` (sin
actividad hace `staleHours`) → `cerrada` (el proceso terminó). `vacia`: abierta sin ningún pedido.
