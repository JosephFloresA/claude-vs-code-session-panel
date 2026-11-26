/**
 * Rutas de sesiones de Claude Code, permisos y teclado.
 *   GET  /api/sesiones                 todas las sesiones (?hours=12&archivadas=1&pausa_h=&conflicto_h=)
 *   GET  /api/hoy                      resumen del dia agrupado por repo (Markdown)
 *   GET  /api/actividad?dia=           linea de tiempo del dia, tokens y costo estimado por sesion
 *   GET  /api/buscar?q=&dias=          busqueda en todas las conversaciones
 *   GET  /api/git                      estado git de los repos y PR de las sesiones
 *   GET  /api/pendientes               permisos/preguntas que esperan decision (deducidos del transcript)
 *   GET  /api/sesiones/<id>/detalle    ultimos intercambios
 *   GET  /api/sesiones/<id>/pendiente  que espera + clasificacion
 *   POST /api/sesiones/<id>/meta       { pinned?, archived?, note?, custom_title?, seen?, auto_accept? }
 *   POST /api/sesiones/<id>/enviar     { text }          (teclado.mjs; desactivado si config.keyboard = false)
 *   POST /api/sesiones/<id>/adjunto?name=  (cuerpo binario, 25 MB) → { path } en ADJUNTOS.dir (adjuntos.mjs)
 *   POST /api/sesiones/<id>/cerrar     (teclado.mjs: enfoca su pestaña, verifica el titulo y pulsa Ctrl+F4)
 *   GET  /api/choques?ruta=&horas=     sesiones abiertas que tocan el mismo archivo o repo (choques.mjs)
 *   POST /api/sesiones/<id>/responder { keys | options } (teclado.mjs; desactivado si config.keyboard = false)
 *   GET  /api/permisos                 modo de aprobacion remota + pedidos
 *   POST /api/permisos/modo            { on, hours }
 *   POST /api/permisos/decidir         { ids, decision, skip_risky? }
 */
import { collectSessions, pendingRequest, sessionDetail, sessionRow, setSessionMeta } from "../core.mjs";
import { dayActivity } from "../actividad.mjs";
import { searchTranscripts } from "../buscar.mjs";
import { gitInfo } from "../git.mjs";
import { dailyMarkdown } from "../hoy.mjs";
import { WAIT_SECS, assessRisk, decide, getHookSeen, getMode, listRequests, setMode } from "../permisos.mjs";
import { num } from "../http/base.mjs";
import { closeSession, pressKeys, sendToSession } from "../teclado.mjs";
import { detectarChoques, marcarRepos } from "../choques.mjs";
import { guardarAdjunto } from "../adjuntos.mjs";
import { buscarArchivo, revelar } from "../revelar.mjs";
import { ADJUNTOS } from "../config.mjs";

const SID = "([0-9a-f-]{36})";
const sid = (suffix) => new RegExp(`^\\/api\\/sesiones\\/${SID}\\/${suffix}$`, "i");

export function register(router) {
  router.get("/api/sesiones", (c) => {
    const data = collectSessions({
      hours: num(c.query.get("hours"), 12, 1, 168),
      includeArchived: c.query.get("archivadas") === "1",
      staleHours: num(c.query.get("pausa_h"), undefined, 0.25, 168),
      conflictHours: num(c.query.get("conflicto_h"), undefined, 1, 168),
    });
    marcarRepos(data.sessions, detectarChoques(data.sessions));
    c.json(200, data);
  });
  // Chequeo previo de un chat antes de editar (regla 2): ¿hay otra sesion abierta tocando ese repo o archivo?
  router.get("/api/choques", (c) => c.json(200, { choques: detectarChoques(collectSessions({ hours: 48 }).sessions,
    { ruta: c.query.get("ruta"), horas: num(c.query.get("horas"), undefined, 1, 72) }) }));
  router.get("/api/hoy", (c) => c.send(200, "text/markdown; charset=utf-8", dailyMarkdown()));
  router.get("/api/actividad", (c) => {
    const dia = c.query.get("dia");
    c.json(200, dayActivity(/^\d{4}-\d{2}-\d{2}$/.test(dia ?? "") ? dia : undefined));
  });
  router.get("/api/buscar", (c) => c.json(200, searchTranscripts(String(c.query.get("q") ?? "").slice(0, 200),
    { days: num(c.query.get("dias"), 14, 1, 120) })));
  router.get("/api/git", (c) => c.json(200, gitInfo(collectSessions({ hours: 24 }).sessions)));

  // Solo sesiones vivas de VS Code que esperan tu decision (necesita_input). NO viene del hook (la politica lo bloquea).
  router.get("/api/pendientes", (c) => {
    const out = [];
    for (const s of collectSessions({ hours: 24 }).sessions) {
      if (!s.pid || s.entrypoint !== "claude-vscode" || s.state !== "necesita_input") continue;
      let p = null;
      try { p = pendingRequest(s.session_id); } catch {}
      if (!p || p.pending === false) continue;
      const risk = p.kind === "command" ? assessRisk(p.tool, { command: p.detail?.command }) : null;
      out.push({
        session_id: s.session_id, title: s.title, open_url: s.open_url, workspace: s.workspace,
        kind: p.kind, manual: !!p.manual, tool: p.tool, summary: p.summary,
        detail: p.detail ?? null, questions: p.questions ?? null, risky: !!risk, risk_reason: risk,
      });
    }
    c.json(200, { pendientes: out, generated_at: new Date().toISOString() });
  });

  router.get(sid("detalle"), (c) => c.json(200, sessionDetail(c.params[0], { maxTurns: num(c.query.get("turnos"), 8, 1, 400) })));
  // Fila de cualquier sesion (aunque sea vieja): para abrir su conversacion en el panel desde Proyectos.
  router.get(sid("fila"), (c) => {
    const row = sessionRow(c.params[0]);
    if (row) marcarRepos([row], []);
    c.json(row ? 200 : 404, row ?? { error: "Sesión no encontrada" });
  });
  router.get(sid("pendiente"), (c) => {
    let p = null;
    try { p = pendingRequest(c.params[0]); } catch {}
    c.json(200, p ?? { pending: false });
  });
  router.post(sid("meta"), (c) => c.json(200, setSessionMeta(c.params[0], c.body)));
  router.post(sid("enviar"), async (c) => c.json(200, await sendToSession(c.params[0], String(c.body.text ?? ""))), { limit: 64 * 1024 });
  router.post(sid("adjunto"), (c) => c.json(200, guardarAdjunto(c.params[0], c.query.get("name"), c.body)),
    { limit: ADJUNTOS.maxBytes, raw: true });
  // Abrir la carpeta de un archivo que la sesion menciona (lo ubica por nombre en sus documentos o su transcripcion).
  router.post(sid("revelar"), (c) => {
    const p = buscarArchivo(c.params[0], c.body.nombre);
    c.json(200, p ? revelar(p) : { ok: false, reason: "no_encontrado" });
  });
  router.post("/api/revelar", (c) => c.json(200, revelar(c.body.path)));
  router.post(sid("cerrar"), async (c) => c.json(200, await closeSession(c.params[0])));
  router.post(sid("responder"), async (c) => c.json(200, await pressKeys(c.params[0], { keys: c.body.keys, options: c.body.options })));

  router.get("/api/permisos", (c) => c.json(200, { mode: getMode(), wait_secs: WAIT_SECS, requests: listRequests(), hook: getHookSeen() }));
  router.post("/api/permisos/modo", (c) => c.json(200, setMode(!!c.body.on, Number(c.body.hours) || 4)));
  router.post("/api/permisos/decidir", (c) => {
    const ids = Array.isArray(c.body.ids) ? c.body.ids.filter((x) => typeof x === "string").slice(0, 100) : [];
    c.json(200, { changed: decide(ids, c.body.decision, { skipRisky: !!c.body.skip_risky }) });
  });
}
