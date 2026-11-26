#!/usr/bin/env node
/**
 * Panel web del monitor de sesiones y de los pseudoproyectos. Solo escucha en 127.0.0.1 (nunca en la red).
 *
 *   node src/dashboard.mjs [--port 7820]
 *   PANEL_CONFIG=<otro config.json> node src/dashboard.mjs     otro perfil (p. ej. un sandbox con su propio puerto)
 *
 * Estructura (cada pieza se puede tocar sin leer las demas):
 *   config.mjs            perfil, puertos, rutas e interruptores (unica fuente)
 *   http/base.mjs         respuestas, cuerpo con limite, token, enrutador
 *   rutas/panel.mjs       HTML, estaticos, /ver, /health, /api/config
 *   rutas/sesiones.mjs    sesiones, actividad, busqueda, git, permisos, teclado
 *   rutas/flujos.mjs      pseudoproyectos, escribano, historial, abrir chats
 *   teclado.mjs           enviar/aprobar en pestanas abiertas + auto-aceptar (solo perfil real)
 *   flujos/               modelo (lectura) · cambios (escrituras) · historial (git) · escriba · abrir
 *   core.mjs, actividad.mjs, buscar.mjs, git.mjs, hoy.mjs, permisos.mjs   nucleo de sesiones
 *   workspace.mjs         raices de trabajo (que repo toca cada sesion, que archivos se pueden previsualizar)
 *   integrations/cli.mjs  az / gh opcionales, siempre sin shell
 *   ../test/              npm test
 *
 * Seguridad: toda escritura (POST) exige X-Monitor-Token, un token aleatorio por arranque que solo va dentro del
 * HTML del panel (otra pagina no puede leerlo). Ademas el Host debe ser 127.0.0.1/localhost (anti DNS-rebinding).
 * Normalmente se levanta con scripts/panel.ps1.
 */
import http from "node:http";
import { CONFIG_FILE, ESCRIBA, PROFILE, PORT, FLUJOS_DIR, VERSION, WORKSPACE_ROOTS, ADO_ORG } from "./config.mjs";import { openSessionsDb } from "./core.mjs";
import { setMode } from "./permisos.mjs";
import { createRouter, createToken, send } from "./http/base.mjs";
import * as rutasPanel from "./rutas/panel.mjs";
import * as rutasSesiones from "./rutas/sesiones.mjs";
import * as rutasFlujos from "./rutas/flujos.mjs";
import { startAutoAccept } from "./teclado.mjs";
import { startEscriba } from "./flujos/escriba.mjs";
import { startHistorial } from "./flujos/historial.mjs";

// Crea las tablas una vez al arrancar: las lecturas posteriores son de solo lectura.
openSessionsDb().close();
// Al reiniciar el servidor el modo de aprobacion remota se apaga: nadie aprueba sin el panel abierto.
setMode(false);

const token = createToken();
const router = createRouter({ token });
for (const m of [rutasPanel, rutasSesiones, rutasFlujos]) m.register(router, { token });

const server = http.createServer(async (req, res) => {
  const host = String(req.headers.host ?? "").toLowerCase();
  if (host !== `127.0.0.1:${PORT}` && host !== `localhost:${PORT}`) { send(res, 421, "text/plain", "host no permitido"); return; }
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  try {
    if (!(await router.handle(req, res, url))) send(res, 404, "text/plain", "no encontrado");
  } catch (e) {
    if (!res.headersSent) send(res, 500, "text/plain; charset=utf-8", `error: ${e?.message ?? e}`);
  }
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") console.error(`El puerto ${PORT} ya está en uso (¿el panel ya corre?). Usa --port N o "port" en ${CONFIG_FILE}.`);
  else console.error(`No se pudo levantar el servidor: ${e.message}`);
  process.exit(1);
});

// Apagado limpio: deja de aceptar conexiones y sale (la tarea programada o panel.ps1 lo vuelven a levantar).
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => { server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); });
process.on("unhandledRejection", (e) => console.error(`[${new Date().toISOString()}] promesa rechazada sin manejar:`, e));

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[${new Date().toISOString()}] Claude session panel v${VERSION} (${PROFILE}) en http://127.0.0.1:${PORT}/`);
  console.log(`  config: ${CONFIG_FILE} · proyectos: ${FLUJOS_DIR} · escribano: ${ESCRIBA.on ? ESCRIBA.model : "apagado"}`);
  console.log(`  raices de trabajo: ${WORKSPACE_ROOTS.length ? WORKSPACE_ROOTS.join(", ") : "(automaticas)"} · Azure DevOps: ${ADO_ORG ?? "apagado"}`);
  startHistorial();    // flujos/ en git: commit por cambio + barrido de ediciones externas cada minuto
  startEscriba();      // mantiene hilos/*.md desde las transcripciones
  startAutoAccept();   // solo perfil real
});
