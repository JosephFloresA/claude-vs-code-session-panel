/**
 * Rutas de pseudoproyectos (ficha + hilos), escribano, historial y apertura de chats.
 *   GET  /api/flujos                              proyectos (sin el texto de fichas e hilos), choques, etiquetas
 *   GET  /api/flujos/texto?project=&file=         texto de la ficha (file vacio) o de hilos/<file>
 *   POST /api/flujos/proyecto                     { slug, title, objetivo, semillas, etiquetas }
 *   POST /api/flujos/hilo                         { project, name, objetivo }
 *   POST /api/flujos/hilo/guardar                 { project, file, markdown, mtime }
 *   POST /api/flujos/hilo/mover                   { project, file, destino }
 *   POST /api/flujos/hilo/sacar                   { project, file }
 *   POST /api/flujos/liberar                      { project, line }
 *   POST /api/flujos/etiquetas                    { project, etiquetas[] }   proyecto.json
 *   POST /api/flujos/historia                     { project, id }   vincula un work item (lo lee de ADO, solo lectura)
 *   POST /api/flujos/historia/lote                { project, ids[] } varias en un commit
 *   POST /api/flujos/historia/quitar              { project, id }
 *   POST /api/flujos/historia/refrescar           { project }       vuelve a leer de ADO sus historias
 *   GET  /api/flujos/sesiones                     { sid: { project, hilo, via } | { sugerencias[] } } de las sesiones de 7 dias
 *   POST /api/flujos/asignar                      { session, project, hilo, nuevo_hilo, objetivo, reciente }
 *   POST /api/flujos/desasignar                   { session }
 *   GET  /api/flujos/sesion/<id>                  estado del escribano para esa sesion
 *   POST /api/flujos/sesion/guardar               { session }  fuerza su pasada del escribano
 *   POST /api/flujos/sesion/terminar              { session, cerrar? }  hilo → ficha → cierra la pestaña (flujos/terminar.mjs)
 *   GET  /api/flujos/sesion/<id>/terminar         progreso de ese cierre (paso, detalle, error)
 *   POST /api/escriba/ahora                       { project, hilo }
 *   GET  /api/flujos/historial?project=&file=&limit=   commits (actor, accion, archivos); file = ruta relativa a flujos/
 *   GET  /api/flujos/historial/diff?hash=&file=        diff de un commit
 *   POST /api/flujos/restaurar                    { hash, file }  ficha, hilo o proyecto.json a su version en ese commit
 *   POST /api/abrir                               { url, send }   chat de Claude Code en VS Code (flujos/abrir.mjs)
 */
import path from "node:path";
import { collectSessions } from "../core.mjs";
import { FLUJOS_DIR, SLUG, listFlujos, read } from "../flujos/modelo.mjs";
import { archiveHilo, asignarSesion, createHilo, createProyecto, desasignarSesion, desvincularHistoria, moveHilo, parseWorkItemId,
  releaseReserva, restaurar, saveHilo, setEtiquetas, vincularHistoria, vincularHistorias } from "../flujos/cambios.mjs";
import { consultar, infoDe } from "../flujos/ado.mjs";
import { annotate, estadoSesion, forceHilo, forceSesion, sembrar } from "../flujos/escriba.mjs";
import { diffCommit, estadoHistorial, historial } from "../flujos/historial.mjs";
import { asignaciones } from "../flujos/sugerir.mjs";
import { detectarChoques } from "../choques.mjs";
import { openInVsCode } from "../flujos/abrir.mjs";
import { estadoTerminar, terminar } from "../flujos/terminar.mjs";

const sesiones7d = () => collectSessions({ hours: 168, includeArchived: true }).sessions;
const SIDP = /^\/api\/flujos\/sesion\/([0-9a-f-]{36})$/i;
const SIDT = /^\/api\/flujos\/sesion\/([0-9a-f-]{36})\/terminar$/i;

/** Quita el texto completo (se pide aparte con /api/flujos/texto): de ~330 KB a ~30 KB por consulta. */
function aligerar(data) {
  for (const p of data.projects) {
    delete p.markdown;
    for (const h of p.hilos) delete h.markdown;
  }
  return data;
}

export function register(router) {
  router.get("/api/flujos", (c) => {
    const sessions = sesiones7d();
    const data = annotate(listFlujos(sessions));
    data.historial = estadoHistorial();
    // Historias: lo vinculado + titulo/tipo/estado desde la cache de ADO (lo vencido se refresca en segundo plano).
    for (const p of data.projects) {
      const info = infoDe(p.historias.map((h) => h.id));
      p.historias = p.historias.map((h, i) => ({ ...info[i], ...h }));
      p.us_detectadas = infoDe(p.us_detectadas);
    }
    data.etiquetas = [...new Set(data.projects.flatMap((p) => p.etiquetas))].sort();
    data.choques = detectarChoques(sessions);
    c.json(200, aligerar(data));
  });
  router.get("/api/flujos/texto", (c) => {
    const project = c.query.get("project") ?? "", file = c.query.get("file") ?? "";
    if (!SLUG.test(project) || project.startsWith(".") || (file && !/^[\w.-]+\.md$/.test(file))) return c.json(400, { ok: false, reason: "parametros" });
    const p = file ? path.join(FLUJOS_DIR, project, "hilos", file) : path.join(FLUJOS_DIR, project, "ficha.md");
    const text = read(p);
    c.json(200, text === null ? { ok: false, reason: "no_existe" } : { ok: true, text });
  });

  router.post("/api/flujos/proyecto", (c) => c.json(200, createProyecto(c.body.slug, c.body.title, c.body.objetivo, c.body.semillas,
    { etiquetas: c.body.etiquetas })));
  router.post("/api/flujos/hilo", (c) => c.json(200, createHilo(c.body.project, c.body.name, c.body.objetivo)));
  router.post("/api/flujos/hilo/guardar", (c) => c.json(200, saveHilo(c.body.project, c.body.file, c.body.markdown, c.body.mtime)), { limit: 200_000 });
  router.post("/api/flujos/hilo/mover", (c) => c.json(200, moveHilo(c.body.project, c.body.file, c.body.destino)));
  router.post("/api/flujos/hilo/sacar", (c) => c.json(200, archiveHilo(c.body.project, c.body.file)));
  router.post("/api/flujos/liberar", (c) => c.json(200, releaseReserva(c.body.project, c.body.line)));

  router.post("/api/flujos/etiquetas", (c) => c.json(200, setEtiquetas(c.body.project, c.body.etiquetas)));
  router.post("/api/flujos/historia", async (c) => {
    const id = parseWorkItemId(c.body.id);
    if (!id) return c.json(200, { ok: false, reason: "id_invalido" });
    const info = await consultar(id);
    const r = vincularHistoria(c.body.project, id, info);
    c.json(200, r.ok ? { ...r, info } : r);
  });
  router.post("/api/flujos/historia/lote", async (c) => {
    const ids = (Array.isArray(c.body.ids) ? c.body.ids : []).map(parseWorkItemId).filter(Boolean).slice(0, 40);
    if (!ids.length) return c.json(200, { ok: false, reason: "sin_ids" });
    const infos = Object.fromEntries(infoDe(ids).map((x) => [x.id, x]));
    for (const id of ids) if (!infos[id]?.title) infos[id] = await consultar(id);   // lo que no estaba en cache
    c.json(200, vincularHistorias(c.body.project, ids, infos));
  }, { limit: 16 * 1024 });
  router.post("/api/flujos/historia/quitar", (c) => c.json(200, desvincularHistoria(c.body.project, c.body.id)));
  router.post("/api/flujos/historia/refrescar", async (c) => {
    const p = listFlujos([]).projects.find((x) => x.slug === c.body.project);
    if (!p) return c.json(200, { ok: false, reason: "no_existe" });
    for (const h of p.historias) await consultar(h.id);
    c.json(200, { ok: true, n: p.historias.length });
  }, { limit: 4096 });

  // ---------- sesiones <-> proyectos ----------
  router.get("/api/flujos/sesiones", (c) => {
    const sessions = sesiones7d();
    const flujos = listFlujos(sessions);
    c.json(200, { asignaciones: asignaciones(sessions, flujos),
      proyectos: flujos.projects.map((p) => ({ slug: p.slug, title: p.title, etiquetas: p.etiquetas, hilos: p.hilos.map((h) => h.name) })) });
  });
  router.post("/api/flujos/asignar", (c) => {
    const sid = String(c.body.session ?? "").toLowerCase();
    let hilo = c.body.hilo || null;
    if (c.body.nuevo_hilo) {
      const r = createHilo(c.body.project, c.body.nuevo_hilo, c.body.objetivo ?? "");
      if (!r.ok) return c.json(200, { ...r, paso: "crear_hilo" });
      hilo = String(c.body.nuevo_hilo).trim();
    }
    const s = sesiones7d().find((x) => x.session_id === sid);
    const r = asignarSesion(c.body.project, sid, hilo, { titulo: s?.title ?? "" });
    if (r.ok && hilo && s?.transcript_path) r.escriba = sembrar(sid, { project: c.body.project, hilo, transcript: s.transcript_path, reciente: !!c.body.reciente });
    c.json(200, r);
  });
  router.post("/api/flujos/desasignar", (c) => c.json(200, desasignarSesion(c.body.session)));
  router.get(SIDP, (c) => c.json(200, estadoSesion(c.params[0].toLowerCase())));
  router.post("/api/flujos/sesion/guardar", (c) => c.json(200, forceSesion(String(c.body.session ?? "").toLowerCase())));
  router.post("/api/flujos/sesion/terminar", (c) => c.json(200, terminar(c.body.session, { cerrar: c.body.cerrar !== false })));
  router.get(SIDT, (c) => c.json(200, estadoTerminar(c.params[0])));

  router.post("/api/escriba/ahora", (c) => c.json(200, forceHilo(c.body.project, c.body.hilo)));

  router.get("/api/flujos/historial", async (c) => {
    const project = c.query.get("project"), file = c.query.get("file");
    c.json(200, await historial({
      proyecto: /^[\w-]+$/.test(project ?? "") ? project : null,
      archivo: /^[\w.-]+\/(ficha\.md|proyecto\.json|hilos\/[\w.-]+\.md)$/.test(file ?? "") ? file : null,
      limit: c.query.get("limit"),
    }));
  });
  router.get("/api/flujos/historial/diff", async (c) => c.json(200, await diffCommit(c.query.get("hash"), c.query.get("file") || null)));
  router.post("/api/flujos/restaurar", async (c) => c.json(200, await restaurar(c.body.hash, c.body.file)));

  router.post("/api/abrir", async (c) => c.json(200, await openInVsCode(c.body.url, { send: !!c.body.send })), { limit: 64 * 1024 });
}
