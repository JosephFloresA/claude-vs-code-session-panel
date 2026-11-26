// Pruebas de pseudoproyectos: escrituras + historial en git. Corren sobre una carpeta temporal (nunca la real).
//   npm test
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "flujos-test-"));
process.env.PANEL_PROJECTS_DIR = DIR;
process.env.PANEL_CONFIG = path.join(DIR, "no-config.json");   // nunca la configuracion real
process.env.PANEL_SCRIBE = "0";
const WS = fs.mkdtempSync(path.join(os.tmpdir(), "panel-ws-"));
process.env.PANEL_WORKSPACE_ROOTS = WS;

const { listFlujos } = await import("../src/flujos/modelo.mjs");
const C = await import("../src/flujos/cambios.mjs");
const H = await import("../src/flujos/historial.mjs");

const log = () => execFileSync("git", ["-C", DIR, "log", "--format=%an|%s"], { encoding: "utf8" }).trim().split("\n");
const ficha = (p) => fs.readFileSync(path.join(DIR, p, "ficha.md"), "utf8");

before(async () => { await H.iniciarHistorial("inicial: prueba"); });
after(() => { for (const d of [DIR, WS]) fs.rmSync(d, { recursive: true, force: true }); });

test("historial: crea el repo con .gitignore e identidad propia", () => {
  assert.ok(fs.existsSync(path.join(DIR, ".git")));
  assert.match(fs.readFileSync(path.join(DIR, ".gitignore"), "utf8"), /\.escriba\.json/);
  const name = execFileSync("git", ["-C", DIR, "config", "user.name"], { encoding: "utf8" }).trim();
  assert.equal(name, "sistema");
  assert.equal(H.estadoHistorial().ready, true);
});

test("crear proyecto e hilo: archivos, fila en la tabla y commits con actor panel", async () => {
  assert.equal(C.createProyecto("proy_a", "Proyecto A", "objetivo A").ok, true);
  assert.equal(C.createProyecto("proy_b", "Proyecto B").ok, true);
  assert.equal(C.createProyecto("proy_a", "otra vez").reason, "ya_existe");
  assert.equal(C.createProyecto("../x", "mal").reason, "parametros");
  assert.equal(C.createHilo("proy_a", "hilo-uno", "obj").ok, true);
  await H.esperarHistorial();
  assert.match(ficha("proy_a"), /\| hilo-uno \| — \| Nuevo \| \[hilos\/hilo-uno\.md\]/);
  const l = log();
  assert.equal(l[0], "panel|crear_hilo: proy_a/hilo-uno");
  assert.ok(l.includes("panel|crear_proyecto: proy_a"));
  const p = listFlujos([]).projects.find((x) => x.slug === "proy_a");
  assert.equal(p.hilos.length, 1);
  assert.equal(p.hilos[0].exists, true);
});

test("guardar hilo: detecta conflicto por mtime y registra la edicion", async () => {
  const p = listFlujos([]).projects.find((x) => x.slug === "proy_a");
  const h = p.hilos[0];
  assert.equal(C.saveHilo("proy_a", h.file, "# Hilo: hilo-uno\n\neditado\n", "2000-01-01T00:00:00.000Z").reason, "cambiado");
  assert.equal(C.saveHilo("proy_a", "../../x.md", "a", null).reason, "no_existe");
  const r = C.saveHilo("proy_a", h.file, "# Hilo: hilo-uno\n\neditado\n", h.mtime);
  assert.equal(r.ok, true);
  await H.esperarHistorial();
  assert.equal(log()[0], "panel|editar_hilo: proy_a/hilo-uno");
});

test("mover hilo: archivo y fila pasan al destino; el historial lo sigue", async () => {
  const r = C.moveHilo("proy_a", "hilo-uno.md", "proy_b");
  assert.equal(r.ok, true);
  await H.esperarHistorial();
  assert.ok(fs.existsSync(path.join(DIR, "proy_b", "hilos", "hilo-uno.md")));
  assert.doesNotMatch(ficha("proy_a"), /hilo-uno/);
  assert.match(ficha("proy_b"), /\| hilo-uno \| — \| Nuevo \(desde proy_a\) \|/);
  assert.equal(log()[0], "panel|mover_hilo: proy_b/hilo-uno");
  const h = await H.historial({ archivo: "proy_b/hilos/hilo-uno.md" });
  assert.deepEqual(h.items.map((x) => x.accion), ["mover_hilo", "editar_hilo", "crear_hilo"]);
  assert.equal(h.items[0].actor, "panel");
});

test("historial de un hilo nuevo no hereda el de otro hilo parecido (misma plantilla)", async () => {
  assert.equal(C.createHilo("proy_a", "gemelo-uno").ok, true);
  assert.equal(C.createHilo("proy_a", "gemelo-dos").ok, true);
  const h = await H.historial({ archivo: "proy_a/hilos/gemelo-dos.md" });
  assert.deepEqual(h.items.map((x) => x.accion), ["crear_hilo"]);
  assert.equal(C.archiveHilo("proy_a", "gemelo-uno.md").ok, true);
  assert.equal(C.archiveHilo("proy_a", "gemelo-dos.md").ok, true);
});

test("edicion externa: el barrido la atribuye a 'chat' por proyecto", async () => {
  fs.appendFileSync(path.join(DIR, "proy_b", "ficha.md"), "\n<!-- editado por un chat -->\n");
  const hs = await H.barrerExternos();
  assert.equal(hs.length, 1);
  assert.equal(log()[0], "chat|edicion_externa: proy_b");
  assert.equal((await H.barrerExternos()).length, 0);
});

test("escribano y reservas: actor escriba", async () => {
  C.writeHiloEscriba("proy_b", "hilo-uno.md", "# Hilo: hilo-uno\n\nresumen\n", "chat abcd1234");
  fs.appendFileSync(path.join(DIR, "proy_b", "ficha.md"), "");
  const md = ficha("proy_b").replace(/## En curso \/ reservas\n/, "## En curso / reservas\n- [2026-11-22 10:00] hilo-uno · repo/ruta · prueba\n");
  fs.writeFileSync(path.join(DIR, "proy_b", "ficha.md"), md);
  await H.barrerExternos();
  assert.equal(C.releaseReserva("proy_b", "[2026-11-22 10:00] hilo-uno · repo/ruta · prueba", { actor: "escriba" }).ok, true);
  await H.esperarHistorial();
  const l = log();
  assert.equal(l[0], "escriba|liberar_reserva: proy_b");
  assert.ok(l.includes("escriba|resumen_escriba: proy_b/hilo-uno"));
});

test("restaurar: vuelve a una version anterior como cambio nuevo", async () => {
  const h = await H.historial({ archivo: "proy_b/hilos/hilo-uno.md" });
  const editado = h.items.find((x) => x.accion === "editar_hilo");
  // En ese commit el hilo vivia en proy_a: restaurarlo ahi lo recrea y vuelve a poner su fila en la tabla.
  const r = await C.restaurar(editado.hash, "proy_a/hilos/hilo-uno.md");
  assert.equal(r.ok, true);
  assert.match(ficha("proy_a"), /\| hilo-uno \| — \| Restaurado \|/);
  assert.equal((await C.restaurar(editado.hash, "proy_b/hilos/no-existe.md")).reason, "no_esta_en_ese_commit");
  assert.equal((await C.restaurar(editado.hash, "../etc/passwd")).reason, "ruta");
  const mov = h.items.find((x) => x.accion === "mover_hilo");
  const ok = await C.restaurar(mov.hash, "proy_b/hilos/hilo-uno.md");
  assert.equal(ok.ok, true);
  await H.esperarHistorial();
  assert.match(fs.readFileSync(path.join(DIR, "proy_b", "hilos", "hilo-uno.md"), "utf8"), /editado/);
  assert.equal(log()[0], "panel|restaurar: proy_b/hilo-uno");
  const d = await H.diffCommit(mov.hash);
  assert.equal(d.ok, true);
  assert.match(d.text, /hilo-uno\.md/);
  assert.equal((await H.diffCommit("zzz")).reason, "hash");
});

test("sacar hilo: a .archivo, fuera de la tabla, registrado", async () => {
  const r = C.archiveHilo("proy_b", "hilo-uno.md");
  assert.equal(r.ok, true);
  await H.esperarHistorial();
  assert.doesNotMatch(ficha("proy_b"), /\| hilo-uno \|/);
  assert.equal(fs.readdirSync(path.join(DIR, "proy_b", ".archivo")).length, 1);
  assert.equal(log()[0], "panel|sacar_hilo: proy_b/hilo-uno");
  assert.equal(listFlujos([]).projects.find((x) => x.slug === "proy_b").hilos.length, 0);
});

test("etiquetas e historias: proyecto.json, registradas en git, detectadas y chats por AB#", async () => {
  assert.equal(C.normEtiqueta("  Tracking DCH! "), "tracking-dch");
  assert.equal(C.parseWorkItemId("AB#82637"), 82637);
  assert.equal(C.parseWorkItemId("https://dev.azure.com/acme/x/_workitems/edit/83723"), 83723);
  assert.equal(C.parseWorkItemId("hola"), null);

  assert.equal(C.createProyecto("proy_t", "Proyecto T", "", [], { etiquetas: ["DCH", "dch", "alertas"] }).ok, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(DIR, "proy_t", "proyecto.json"), "utf8")).etiquetas, ["dch", "alertas"]);
  assert.equal(C.setEtiquetas("proy_t", ["dch", "Calidad de datos"]).ok, true);
  assert.equal(C.setEtiquetas("proy_t", ["dch", "calidad-de-datos"]).sin_cambios, true);
  assert.equal(log()[0], "panel|etiquetas: proy_t");

  fs.appendFileSync(path.join(DIR, "proy_t", "ficha.md"), "\nSe cita AB#81856 y AB#82637.\n");
  H.barrerExternos();
  assert.equal(C.vincularHistoria("proy_t", "AB#82637", { title: "Alertas", type: "User Story" }).ok, true);
  assert.equal(C.vincularHistoria("proy_t", "82637").reason, "ya_vinculada");
  assert.equal(log()[0], "panel|vincular_historia: proy_t");

  const ses = [{ session_id: "aaaaaaaa-0000-4000-8000-000000000001", first_prompt: "sin el slug", work_items: [{ id: 82637 }] },
    { session_id: "aaaaaaaa-0000-4000-8000-000000000002", first_prompt: "otra cosa", work_items: [{ id: 11111 }] }];
  const p = listFlujos(ses).projects.find((x) => x.slug === "proy_t");
  assert.deepEqual(p.etiquetas, ["dch", "calidad-de-datos"]);
  assert.deepEqual(p.historias.map((h) => h.id), [82637]);
  assert.deepEqual(p.us_detectadas, [81856], "sugiere lo citado que no esta vinculado");
  assert.deepEqual(p.chats.map((c) => [c.session_id.slice(-1), c.via_us]), [["1", 82637]]);

  assert.equal(C.desvincularHistoria("proy_t", 82637).ok, true);
  assert.equal(log()[0], "panel|desvincular_historia: proy_t");
  const hist = await H.historial({ archivo: "proy_t/proyecto.json" });
  assert.deepEqual(hist.items.map((i) => i.accion).slice(0, 3), ["desvincular_historia", "vincular_historia", "etiquetas"], "proyecto.json tiene su propio historial");
});

test("ado: cache con lector inyectado; un error no rompe", async () => {
  const A = await import("../src/flujos/ado.mjs");
  A.setLector(async (id) => { if (id === 2) throw new Error("az sin sesion"); return { type: "User Story", title: `US ${id}`, state: "Active" }; });
  assert.equal((await A.consultar(1)).title, "US 1");
  assert.match((await A.consultar(2)).error, /az sin sesion/);
  assert.equal(A.infoDe([1])[0].state, "Active");
  assert.match(fs.readFileSync(path.join(DIR, ".gitignore"), "utf8"), /\.ado\.json/);
});

test("asignar sesion: va a un proyecto/hilo, sale del anterior, manda sobre el nombre y queda en git", async () => {
  const SID = "bbbbbbbb-0000-4000-8000-000000000001";
  assert.equal(C.createProyecto("proy_s1", "Proyecto S1").ok, true);
  assert.equal(C.createProyecto("proy_s2", "Proyecto S2").ok, true);
  assert.equal(C.createHilo("proy_s2", "frente-x").ok, true);
  assert.equal(C.asignarSesion("proy_s2", SID, "no-existe").reason, "hilo_no_existe");
  assert.equal(C.asignarSesion("proy_s1", SID).ok, true);
  const r = C.asignarSesion("proy_s2", SID, "frente-x");
  assert.equal(r.desde, "proy_s1");
  assert.equal(log()[0], "panel|asignar_sesion: proy_s2/frente-x");
  assert.equal(C.asignarSesion("proy_s2", SID, "frente-x").sin_cambios, true);

  // El primer mensaje nombra proy_s1, pero la asignacion a proy_s2 manda.
  const ses = [{ session_id: SID, first_prompt: "Proyecto proy_s1, hilo cualquiera", work_items: [] }];
  const L = listFlujos(ses).projects;
  assert.equal(L.find((p) => p.slug === "proy_s1").chats.length, 0);
  const p2 = L.find((p) => p.slug === "proy_s2");
  assert.deepEqual(p2.chats.map((c) => [c.hilo, c.via]), [["frente-x", "asignada"]]);
  assert.deepEqual(p2.hilos.find((h) => h.name === "frente-x").chats.map((c) => c.session_id), [SID], "el escribano lo toma desde h.chats");

  const { asignaciones } = await import("../src/flujos/sugerir.mjs");
  const a = asignaciones([...ses, { session_id: "bbbbbbbb-0000-4000-8000-000000000002", title: "Proyecto S1 otra", first_prompt: "sigo con proy_s1", work_items: [] }], listFlujos(ses));
  assert.equal(a[SID].project, "proy_s2");
  assert.equal(a["bbbbbbbb-0000-4000-8000-000000000002"].sugerencias[0].project, "proy_s1");

  assert.equal(C.desasignarSesion(SID).ok, true);
  assert.equal(log()[0], "panel|desasignar_sesion: proy_s2/frente-x");
});

test("reservas: la linea «Formato:» de la plantilla no cuenta; vincular US en lote es un commit", () => {
  fs.appendFileSync(path.join(DIR, "proy_s1", "ficha.md"), "");
  const f = path.join(DIR, "proy_s1", "ficha.md");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8").replace("- (vacío) Formato:", "- Formato:"));
  assert.equal(listFlujos([]).projects.find((p) => p.slug === "proy_s1").reservas.length, 0);
  H.barrerExternos();
  const r = C.vincularHistorias("proy_s1", ["AB#11111", 22222, "AB#11111"], { 11111: { title: "Uno" } });
  assert.deepEqual(r.ids, [11111, 22222]);
  assert.equal(log()[0], "panel|vincular_historia: proy_s1");
  assert.equal(C.vincularHistorias("proy_s1", [11111]).sin_cambios, true);
});

test("choques: mismo archivo (sesiones no cerradas) y mismo repo (sesiones vivas); flujos no cuenta", async () => {
  const { detectarChoques, repoDe } = await import("../src/choques.mjs");

  const f = (rel) => path.join(WS, rel).toLowerCase();
  const now = new Date().toISOString();
  const S = [
    { session_id: "1", state: "en_pausa", pid: 1, edited_files: [{ file: f("app_api/a.py"), at: now }, { file: path.join(DIR, "x", "ficha.md").toLowerCase(), at: now }] },
    { session_id: "2", state: "trabajando", pid: 2, edited_files: [{ file: f("app_api/a.py"), at: now }, { file: path.join(DIR, "x", "ficha.md").toLowerCase(), at: now }] },
    { session_id: "3", state: "en_pausa", pid: 3, edited_files: [{ file: f("app_api/b.py"), at: now }] },
    { session_id: "4", state: "cerrada", pid: null, edited_files: [{ file: f("app_api/a.py"), at: now }] },
  ];
  assert.equal(repoDe(f("app_api/a.py")).repo, "app_api");
  const c = detectarChoques(S);
  assert.deepEqual(c.map((x) => [x.nivel, x.repo, x.sesiones.length]), [["archivo", "app_api", 2], ["repo", "app_api", 3]]);
  assert.equal(detectarChoques(S, { ruta: "app_api/b.py" }).length, 1, "b.py: solo el choque de repo");
  assert.equal(detectarChoques(S, { ruta: "app_web" }).length, 0);
});

test("sesion origen: la sesion que la tabla de hilos cita es chat del proyecto (hilo abierto primero) sin asignarla", () => {
  const SID = "cccccccc-0000-4000-8000-000000000001";
  assert.equal(C.createProyecto("proy_o", "Proyecto O").ok, true);
  assert.equal(C.createHilo("proy_o", "diseno").ok, true);
  assert.equal(C.createHilo("proy_o", "pipeline").ok, true);
  const f = path.join(DIR, "proy_o", "ficha.md");
  fs.writeFileSync(f, fs.readFileSync(f, "utf8")
    .replace("| diseno | — | Nuevo |", "| diseno | cccccccc | Cerrado (en develop) |")
    .replace("| pipeline | — | Nuevo |", "| pipeline | cccccccc | Activo |"));
  const ses = [{ session_id: SID, title: "otra cosa", first_prompt: "sin nombrar nada", work_items: [], note: "esperando prod", note_kind: "bloqueo" }];
  const p = listFlujos(ses).projects.find((x) => x.slug === "proy_o");
  assert.deepEqual(p.chats.map((c) => [c.hilo, c.via, c.note_kind]), [["pipeline", "origen", "bloqueo"]]);
  H.barrerExternos();
});
