# Changelog

Formato: [Keep a Changelog](https://keepachangelog.com/es-ES/1.1.0/). Versiones: [SemVer](https://semver.org/lang/es/).

## [0.1.0] - 2026-11-26

Primera versión como repositorio propio (antes vivía dentro de un repo de gestión personal).

### Agregado
- Configuración única (`config.json` + variables `PANEL_*`), con `config.example.json` y `/api/diagnostico`.
- Raíces de trabajo configurables o deducidas solas de las carpetas de trabajo de las sesiones (`src/workspace.mjs`).
- Estado de PR de GitHub con `gh`, además de Azure DevOps.
- `scripts/panel.ps1`: Init, Start, Open, Stop, Restart, Status, Install y Uninstall; verifica la versión de Node,
  rota logs y admite varios perfiles (un `config.json` y un puerto por perfil).
- `npm run check`: sintaxis y bloqueo de correos, rutas personales, tokens y palabras prohibidas locales.
- CI en GitHub Actions (Windows, Node 22 y 24): tests, check y análisis de los `.ps1`.
- Mensajes claros si el puerto está ocupado o el `config.json` es inválido, y apagado limpio.

### Cambiado
- Azure DevOps pasa a ser opcional (`azureDevOps.org`); cada PR se consulta con la organización de su enlace.
- Las llamadas a `az` van sin shell (antes, `az` con una cadena de comando).
- El cliente de work items ya no depende de otro paquete: usa `az boards work-item show` directamente.
- Las familias de etiquetas de Proyectos (`tags.types`, `tags.groups`) y las palabras ignoradas al sugerir proyecto
  salen de la configuración.
- El perfil «lab» deja de ser un caso especial: cualquier perfil es otro `config.json`.

### Corregido
- `aprobar.ps1`, `enviar.ps1`, `cerrar_pestana.ps1` y `toast.ps1` se guardan con BOM UTF-8: Windows PowerShell 5.1
  los leía como ANSI y el patrón `S[ií]` nunca reconocía el botón «Sí» de VS Code en español.
