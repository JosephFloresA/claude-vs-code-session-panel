// Barra superior de permisos pendientes.
// Los permisos se DEDUCEN del transcript de cada sesión (GET /api/pendientes), no del hook PermissionRequest
// (la política allowManagedHooksOnly lo bloquea). Aprobar/Rechazar llama a aprobar.ps1 (POST /responder), que
// pulsa el botón Yes/No del diálogo por UI Automation. No se salta ninguna política: automatiza tu mismo clic.
import { $, esc, toast } from "./ui.js";
import { icon } from "./icons.js";
import { openVs } from "./abrir.js";

export const TOKEN = document.querySelector('meta[name="monitor-token"]')?.content ?? "";
const KIND = { command: "Comando", edit: "Edición", plan: "Plan", choice: "Pregunta", tool: "Herramienta" };

let pend = [];                 // pendientes actuales (del endpoint)
let sessionsById = new Map();
let openDet = new Set();        // sesiones con el detalle desplegado
let collapsed = false;          // barra plegada a mano

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function post(url, body) {
  const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-monitor-token": TOKEN }, body: JSON.stringify(body) });
  return res.json().catch(() => ({ ok: false, reason: "red" }));
}

export async function loadPerms(sessions) {
  if (sessions) sessionsById = new Map(sessions.map((s) => [s.session_id, s]));
  try { pend = (await (await fetch("/api/pendientes", { cache: "no-store" })).json()).pendientes ?? []; } catch { return; }
  paint();
}

function paint() {
  const n = pend.length;
  const binary = pend.filter((r) => !r.manual);
  const btn = $("#btn-perm");
  if (btn) {
    btn.classList.toggle("on", n > 0);
    btn.innerHTML = `${icon(n ? "shieldCheck" : "shield")}${n ? "Aprobar aquí" : "Sin pendientes"}${n ? ` <span class="perm-n">${n}</span>` : ""}`;
    btn.title = n
      ? `${n} permiso(s) esperando tu decisión (deducidos del transcript). Clic para mostrar/ocultar.`
      : "No hay permisos pendientes.";
  }
  const bar = $("#permbar");
  if (!bar) return;
  if (!n || collapsed) { bar.innerHTML = ""; return; }
  const safe = binary.filter((r) => !r.risky);
  bar.innerHTML = `<div class="permbar">
    <div class="ph">${icon("shield")}<b>${n} permiso${n > 1 ? "s" : ""} pendiente${n > 1 ? "s" : ""}</b>
      <span class="muted">revisa antes de aprobar · los riesgosos y las preguntas, uno por uno</span><span class="spacer"></span>
      ${safe.length ? `<button class="btn primary" data-perm-bulk="allow">${icon("checkAll")}Aprobar ${safe.length === binary.length ? "todos" : `${safe.length} seguros`}</button>` : ""}
      ${binary.length ? `<button class="btn danger" data-perm-bulk="deny">${icon("x")}Rechazar todos</button>` : ""}
    </div>
    <ul class="plist">${pend.map(item).join("")}</ul>
  </div>`;
}

function detailHtml(r) {
  const d = r.detail ?? {};
  if (r.kind === "edit") return `<div class="diff"><pre class="del">${esc(d.old || "—")}</pre><pre class="add">${esc(d.new || "—")}</pre></div>`;
  if (d.command) return `<pre class="cmd">${esc(d.command)}</pre>`;
  if (d.plan) return `<pre class="cmd">${esc(d.plan)}</pre>`;
  if (r.kind === "choice") return `<div class="pq">${(r.questions ?? []).map((q) => `<b>${esc(q.question)}</b>${(q.options ?? []).length ? `<ul class="popts">${q.options.map((o) => `<li>${esc(o.label)}</li>`).join("")}</ul>` : ""}`).join("")}</div>`;
  if (d.input) return `<pre class="cmd">${esc(d.input)}</pre>`;
  return "";
}

function item(r) {
  const s = sessionsById.get(r.session_id);
  const body = detailHtml(r);
  const isOpen = openDet.has(r.session_id);
  const actions = r.manual
    ? `<a class="btn" href="${esc(r.open_url)}" data-perm-open>${icon("external")}Elegir en VS Code</a>`
    : `<button class="btn" data-perm-one="deny" data-sid="${esc(r.session_id)}">${icon("x")}Rechazar</button>
       <button class="btn primary" data-perm-one="allow" data-sid="${esc(r.session_id)}">${icon("check")}Aprobar</button>`;
  return `<li class="preq ${r.risky ? "risky" : ""}" data-pid="${esc(r.session_id)}">
    <div class="pmain">
      <span class="ptool">${icon(r.tool === "Bash" || r.tool === "PowerShell" ? "terminal" : r.kind === "edit" ? "pencil" : "sparkles", { size: 14 })}${esc(KIND[r.kind] ?? r.tool ?? "Permiso")}</span>
      <div class="pbody">
        <div class="psum" title="${esc(r.summary)}">${esc(r.summary)}</div>
        <div class="pmeta">${s ? `<a href="${esc(r.open_url)}" data-perm-open>${esc(r.title)}</a>` : `<span>${esc(r.title)}</span>`}
          ${r.workspace ? `<span class="muted">· ${esc(r.workspace)}</span>` : ""}
          ${r.risky ? `<span class="pill conflict">${icon("alert", { size: 12 })}${esc(r.risk_reason)}</span>` : ""}
          ${r.manual ? `<span class="pill">preferencia · tú eliges</span>` : ""}</div>
      </div>
      ${body ? `<button class="btn ghost icon" data-perm-toggle title="Ver detalle">${icon("chevron", { cls: isOpen ? "" : "rot-90" })}</button>` : ""}
      ${actions}
    </div>
    ${body && isOpen ? `<div class="pdetail">${body}</div>` : ""}
  </li>`;
}

// Aprobar/Rechazar una sesión: activa su pestaña (para que aprobar.ps1 la identifique por título) y pulsa Yes/No.
async function decideOne(sid, decision) {
  const r = pend.find((x) => x.session_id === sid);
  if (!r) return;
  if (r.risky && decision === "allow" && !confirm(`Pedido riesgoso (${r.risk_reason}):\n\n${r.summary}\n\n¿Aprobarlo igual?`)) return;
  openVs(r.open_url);                         // trae al frente su pestaña en VS Code
  toast(`${decision === "allow" ? "Aprobando" : "Rechazando"}: ${r.title}…`, "external");
  const res = await post(`/api/sesiones/${sid}/responder`, { keys: decision === "allow" ? ["1"] : ["2"] });
  toast(res.ok ? `${decision === "allow" ? "Aprobado" : "Rechazado"}: ${r.title}` : `No se pudo (${res.reason}) en ${r.title}: resuélvelo en VS Code`, res.ok ? (decision === "allow" ? "check" : "x") : "alert");
  setTimeout(() => loadPerms(), 1200);
}

async function decideBulk(decision) {
  const binary = pend.filter((r) => !r.manual);
  const target = decision === "allow" ? binary.filter((r) => !r.risky) : binary;
  if (!target.length) return;
  const list = target.map((r) => `• ${r.title}: ${r.summary.slice(0, 80)}`).join("\n");
  if (!confirm(`${decision === "allow" ? "Aprobar" : "Rechazar"} ${target.length} permiso(s):\n\n${list}\n\nSe hará uno por uno, trayendo su pestaña al frente.`)) return;
  let ok = 0;
  for (const r of target) {
    openVs(r.open_url);                       // activar su pestaña
    await sleep(1400);                                // dar tiempo a que VS Code la muestre
    const res = await post(`/api/sesiones/${r.session_id}/responder`, { keys: decision === "allow" ? ["1"] : ["2"] });
    if (res.ok) { ok++; toast(`${decision === "allow" ? "Aprobado" : "Rechazado"}: ${r.title}`, decision === "allow" ? "check" : "x"); }
    else toast(`Falló ${r.title} (${res.reason})`, "alert");
    await sleep(400);
  }
  toast(`${ok}/${target.length} ${decision === "allow" ? "aprobados" : "rechazados"}`, ok ? "check" : "alert");
  setTimeout(() => loadPerms(), 1200);
}

export function initPerms() {
  document.addEventListener("click", async (e) => {
    try {
      if (e.target.closest("#btn-perm")) { collapsed = !collapsed; paint(); return; }
      const li = e.target.closest("[data-pid]");
      if (e.target.closest("[data-perm-toggle]") && li) {
        const id = li.dataset.pid;
        openDet.has(id) ? openDet.delete(id) : openDet.add(id);
        paint();
        return;
      }
      // Los enlaces data-perm-open abren/activan la pestaña con su href normal: no hay que hacer nada más.
      const one = e.target.closest("[data-perm-one]");
      if (one) { await decideOne(one.dataset.sid, one.dataset.permOne); return; }
      const bulk = e.target.closest("[data-perm-bulk]");
      if (bulk) { await decideBulk(bulk.dataset.permBulk); return; }
    } catch (err) {
      toast(`Error: ${err.message ?? err}`, "alert");
    }
  });
}
