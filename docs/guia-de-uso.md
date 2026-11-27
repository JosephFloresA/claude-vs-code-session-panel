# Guía de uso

Para quien usa Claude Code en VS Code y nunca vio el panel. En 10 minutos sabrás qué es, cómo instalarlo y cómo
sacarle provecho en el día a día.

## Qué es, en una frase

Una página en tu navegador (`http://127.0.0.1:7820`) que muestra **todas tus conversaciones de Claude Code a la vez**:
cuáles te necesitan, cuáles terminaron, qué archivos tocaron. Desde ahí puedes leerlas, responderlas y aprobar permisos
sin ir pestaña por pestaña en VS Code.

## ¿Me sirve?

Te sirve si alguna vez te pasó algo de esto:

- Tienes 5, 10 o 20 chats de Claude abiertos y no sabes cuál terminó o cuál te está esperando.
- Un chat quedó horas detenido porque pidió permiso y no lo viste.
- Dos chats editaron el mismo archivo y uno pisó el trabajo del otro.
- Retomas un tema días después y no recuerdas en qué quedó.

Si usas uno o dos chats a la vez, probablemente no lo necesitas.

## Instalación (5 minutos)

**Necesitas:** Windows 10 u 11, VS Code con la extensión **Claude Code**, [Node.js](https://nodejs.org) 22.5 o superior
y [git](https://git-scm.com). Si te falta algo:

```powershell
winget install Git.Git OpenJS.NodeJS.LTS Microsoft.VisualStudioCode
```

Después, en PowerShell:

```powershell
git clone https://github.com/JosephFloresA/claude-vs-code-session-panel.git
cd claude-vs-code-session-panel
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Install
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Open
```

- `Install` deja el panel arrancando solo cada vez que inicias sesión en Windows y agrega a VS Code el atajo que
  necesita para escribir en tus chats (`Ctrl+Alt+Shift+F9`).
- `Open` lo abre en el navegador. Guárdalo en favoritos.

No hace falta configurar nada. Si quieres ajustar algo, mira la sección «Configuración» del [README](../README.md).

## La pantalla

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Sesiones de Claude  [Bandeja][Tabla][Tablero][Archivos][Proyectos]  🔍  ☀ │  ← barra superior
│ Todo · Pendientes · Sin ver · Trabajando · Hoy · (filtros por repo)      │  ← filtros
├───────────────────────┬──────────────────────────────────────────────────┤
│ 🔴 Te necesitan       │  Título de la conversación          [VS Code]    │
│   · Arreglar el login │  estado · modelo · % de contexto usado           │
│ 🟡 Tu turno           │  ─────────────────────────────────────────────── │
│   · Informe mensual   │  Tú: ...                                         │
│   · Revisar PR 123    │  Claude: ...                                     │
│ 🔵 Trabajando         │                                                  │
│   · Migrar base       │  [ escribe aquí y Enter para responder ]         │
└───────────────────────┴──────────────────────────────────────────────────┘
        lista                                detalle
```

### Qué significa cada estado

| Estado | Qué pasa | Qué hacer |
|---|---|---|
| 🔴 **Te necesita** | Pidió permiso para algo o te hizo una pregunta con opciones | Responder ya: el chat está detenido |
| 🔵 **Sin ver** | Terminó y todavía no lo miraste | Leer la respuesta |
| 🟡 **Tu turno** | Respondió y espera tu siguiente mensaje | Seguir cuando puedas |
| ⚙️ **Trabajando** | Está en medio de una tarea | Nada |
| 💤 **En pausa** | Nadie le escribe hace más de 3 horas | Cerrarlo o archivarlo si ya no sirve |
| ⚪ **Sin uso** | Abierto pero sin ningún mensaje | Cerrarlo |
| ⚫ **Cerrada** | La pestaña ya no existe | Nada (se ve 12 h para referencia) |

Los chats que te necesitan siempre aparecen arriba.

### Las cinco vistas

Cambia de vista con los botones de arriba o con la tecla `g`.

- **Bandeja.** Lista a la izquierda y la conversación a la derecha. Es la vista para el día a día.
- **Tabla.** Todas las sesiones en filas, con repo, rama, PR, % de contexto y archivos editados. Sirve para ordenar y
  comparar.
- **Tablero.** Columnas por estado (como un tablero Kanban).
- **Archivos.** Los documentos que generaron tus chats (Markdown, HTML, PDF, imágenes), con vista previa.
- **Proyectos.** La memoria de largo plazo: ver más abajo.

## Tareas comunes

### Ver qué te necesita

Mira el contador rojo de arriba o el filtro **Pendientes**. Si activas los avisos (el botón de campana), el navegador
te notifica cuando un chat te necesita o termina.

### Leer y responder sin cambiar de pestaña

1. En la **Bandeja**, haz clic en la conversación.
2. A la derecha ves los últimos intercambios.
3. Escribe abajo y presiona `Enter`. El panel lo pega en la pestaña correcta de VS Code y confirma que llegó.

También hay respuestas rápidas («dale», «sí, continúa», «súbelo»…) debajo de la conversación. Para adjuntar un
archivo, arrástralo o pégalo con `Ctrl+V`.

> Mientras envía, el panel trae VS Code al frente un momento. Es normal: está escribiendo por ti.

### Aprobar permisos

Cuando Claude quiere ejecutar un comando o editar un archivo, la sesión se pone 🔴 y el panel muestra **qué** quiere
hacer (el comando completo o el cambio en el archivo).

- **Uno por uno:** botones **Aprobar** / **Rechazar** en la tarjeta del permiso.
- **Varios a la vez:** botón **Aprobar aquí** de la barra superior. Lista todos los pendientes; los riesgosos (borrar
  archivos, comandos peligrosos) se marcan aparte y no se aprueban en bloque.
- **Auto-aceptar (⚡):** se activa por sesión. Aprueba solo los permisos de esa sesión mientras trabaja. Úsalo en tareas
  largas que ya revisaste; nunca responde preguntas con opciones.

Aprobar desde el panel es exactamente el mismo clic que harías en VS Code: no salta ninguna regla de permisos.

### Responder preguntas con opciones

A veces Claude pregunta «¿prefieres A, B o C?». En la tarjeta aparecen las opciones como botones; elige una y el panel
la marca y la envía en VS Code. Si no puede (por ejemplo, la pregunta permite varias opciones), te avisa y te ofrece
**Abrir** para elegir en VS Code.

### Ir a la conversación en VS Code

Botón **VS Code** del detalle, o `Enter` sobre la sesión seleccionada.

### Ordenar tu lista

| Acción | Cómo | Para qué |
|---|---|---|
| Fijar | `p` o el chinche | Mantener arriba lo importante |
| Archivar | `a` | Ocultar lo que ya no importa. Vuelve sola si hay actividad nueva |
| Marcar como vista | `v` | Quitar el «Sin ver» |
| Nota | `n` | Recordatorio corto: Bloqueo, En validación, Listo o Info |
| Renombrar | `r` | Un título propio en vez del que puso Claude |

Selecciona varias con `x` (o `Ctrl+clic`) para hacerlo en lote.

### Buscar en todas tus conversaciones

Escribe en la caja de arriba (`/` para ir directo). Filtra la lista mientras escribes; con `Enter` busca el texto en
**todas** tus conversaciones de los últimos días, sin importar tildes.

### Ver tu día

Botón ☀ **Día** o tecla `h`: línea de tiempo de lo que hiciste hoy, por repo, con PRs y archivos. Sirve para el daily o
para reportar avances.

### Evitar pisarte

Si dos chats abiertos editan **el mismo archivo** o trabajan en **el mismo repo**, la sesión muestra un aviso de choque.
Revisa antes de que uno haga commit de los cambios del otro.

> Solo detecta cambios hechos con las herramientas de edición de Claude. Si Claude modifica un archivo con comandos de
> terminal, ese cambio no se ve (ver [problemas conocidos](problemas-conocidos.md)).

## Proyectos: memoria para retomar temas

Un chat largo se vuelve lento y caro, y los temas duran más que un chat. Proyectos guarda **en qué quedó cada tema**
para empezar un chat nuevo con solo lo necesario.

- **Ficha** (`ficha.md`, máximo ~4.500 caracteres): el estado actual del proyecto. Objetivo, qué está hecho, qué falta,
  decisiones y bloqueos.
- **Hilos** (`hilos/<nombre>.md`): la bitácora de cada línea de trabajo dentro del proyecto.

**Cómo se usa:**

1. En la vista **Proyectos**, crea un proyecto y uno o más hilos.
2. Asigna tus chats a un hilo (el panel sugiere a cuál pertenece cada chat).
3. El **escribano** (un modelo barato, Haiku) lee lo nuevo de cada chat asignado y actualiza su hilo solo. Cuesta
   fracciones de centavo por pasada.
4. Cuando terminas una línea de trabajo, **Terminar** guarda lo último en el hilo, actualiza la ficha y cierra la
   pestaña.
5. Para retomar otro día: abre un chat nuevo y pídele que lea la ficha (y el hilo que toque). No necesitas reabrir la
   conversación gigante.

Cada cambio en fichas e hilos queda en un historial (git) con quién lo hizo: tú, el panel o el escribano. Desde el
historial puedes ver diferencias y **restaurar** una versión anterior.

## Atajos de teclado

| Tecla | Acción |
|---|---|
| `j` / `k` | Bajar / subir por las sesiones |
| `Enter` | Abrir en VS Code |
| `e` | Escribir una respuesta |
| `f` | Modo lectura (conversación a pantalla completa) |
| `g` | Cambiar de vista |
| `h` | Día |
| `/` | Buscar |
| `x` | Seleccionar para acciones en lote |
| `v` · `p` · `a` · `n` · `r` | Vista · fijar · archivar · nota · renombrar |
| `,` | Ajustes |
| `?` | Ver todos los atajos |
| `Esc` | Cerrar |

## Privacidad

- Todo queda **en tu equipo**. El panel solo escucha en `127.0.0.1`: nadie más en la red puede abrirlo.
- Lee las conversaciones que Claude Code ya guarda en tu carpeta `~/.claude`. No las envía a ningún lado.
- **No lo compartas como servidor** ni lo expongas en la red: vería todas tus conversaciones. Cada persona instala el
  suyo.
- El escribano usa tu propia cuenta de Claude (el mismo `claude` que usa VS Code).

## Si algo no funciona

| Síntoma | Solución |
|---|---|
| El navegador dice que no puede conectar | `powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Start` |
| «Enviar» no llega al chat | `scripts\panel.ps1 -Action Install` (crea el atajo que falta) |
| VS Code desapareció pero sigue en el Administrador de tareas | `powershell -ExecutionPolicy Bypass -File scripts\reiniciar-vscode.ps1` |
| Quiero ver qué está usando el panel | Abre `http://127.0.0.1:7820/api/diagnostico` |

Más casos en [problemas conocidos](problemas-conocidos.md). Los registros quedan en
`%LOCALAPPDATA%\claude-session-panel\logs`.

## Actualizar y desinstalar

```powershell
cd claude-vs-code-session-panel
git pull                                                              # actualizar
powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Restart

powershell -ExecutionPolicy Bypass -File scripts\panel.ps1 -Action Uninstall   # desinstalar
```

`Uninstall` quita el arranque automático y detiene el panel. Tus proyectos quedan en
`%LOCALAPPDATA%\claude-session-panel`; bórralos a mano si ya no los quieres.
