# Brief: migrar sesiones de Claude Code a proyectos

Contexto: en la carpeta de proyectos (abajo `<flujos>`: la que contiene el `ficha_path` del prompt) cada proyecto tiene
`ficha.md` (estado vivo, ≤ 4.500 caracteres) y `hilos/<hilo>.md` (bitácora de una línea de trabajo, ≤ 5.500
caracteres). Sirven para retomar trabajo en un chat nuevo cargando solo la ficha (y el hilo que toque) en vez de
reabrir conversaciones gigantes. Cada cambio queda en el historial git de `<flujos>` (no hace falta hacer commit: el
panel lo registra solo).

## Lee primero (formato a copiar al pie de la letra)
- `<flujos>\README.md`, si existe (las tres capas).
- Una ficha existente con hilos en `<flujos>` como **modelo de ficha y de hilo**: mismas secciones, mismo orden,
  mismos encabezados `##`, la misma línea de cabecera `> Estado vivo...` y la tabla de hilos. Si no hay ninguna, usa
  la plantilla que el panel crea al hacer «Nuevo proyecto».

## Fuentes
- Transcripciones: `node <herramientas>\extraer.cjs <id8> <temporal>\extractos\<id8>.txt` (la ruta exacta del
  extractor viene en el prompt) las vuelca a texto compacto (usuario, respuestas de Claude, herramientas en una
  línea). Lee el extracto, no el .jsonl. Guarda los extractos en una carpeta temporal fuera de carpetas sincronizadas
  (OneDrive, Dropbox), porque contienen texto de las transcripciones.
  Si el extracto es grande (> 150 KB), no lo leas entero: lee el principio, el final (el estado más reciente manda)
  y busca con Grep los temas (rama, PR, commit, error, decid, pendiente, bloque, prod, dev, job, run).
- Memorias del usuario en `~/.claude/projects/<carpeta>/memory/` (contexto ya destilado, puede estar desactualizado).
- Puedes leer (solo leer) archivos citados en las sesiones y usar `git log`/`git branch` en esos repos para confirmar
  ramas o commits. Nada más.

## Reglas
- Escribe **solo** dentro de `<flujos>\<slug>\` de tus proyectos. No toques otros proyectos (salvo que tu encargo lo
  diga explícitamente), ni repos, ni `~/.claude`, ni nada en la nube.
- Datos literales: rutas, ramas, PR, commits, IDs, cifras y fechas tal cual aparecen. No inventes: si algo no consta,
  escribe «(no consta)». Si dos sesiones se contradicen, ponlo en «Inconsistencias detectadas».
- Fechas absolutas (AAAA-MM-DD o «05-nov»). Nada de «ayer» o «la semana pasada».
- Cabecera de la ficha: `> Actualizada: <AAAA-MM-DD de hoy> (migración desde sesiones <id8>, <id8>...).`
- «En curso / reservas»: déjala vacía con la línea de formato del modelo (nadie tiene nada reservado ahora).
- Un hilo por línea de trabajo distinguible (no necesariamente uno por sesión: varias sesiones del mismo tema van a un
  hilo, y la columna Sesión lista la principal). La tabla de hilos de la ficha enlaza `hilos/<hilo>.md`. Nombre de
  hilo: minúsculas, guiones, sin acentos.
- Cada hilo termina con «## Dónde buscar detalle exacto»: qué sesión (id8) y qué fecha tiene cada tema, para que un
  subagente busque ahí si falta un dato.
- Estado: si una línea de trabajo terminó, dilo («Cerrado: PR 12345 completado»); si quedó a medias, qué falta.
- Límites: ficha ≤ 4.500 y cada hilo ≤ 5.500 caracteres. Compruébalo (`(Get-Content x -Raw).Length` o `wc -m`) y
  condensa si te pasas.
- Borra tus extractos al terminar.

## Entrega (tu respuesta final, corta)
Por proyecto: slug, título, hilos creados con su estado, caracteres de la ficha y de cada hilo, y cualquier duda o
dato que no pudiste confirmar. Nada más.
