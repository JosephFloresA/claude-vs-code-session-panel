// Panel del dia: linea de tiempo por sesion, costo/tokens y resumen en Markdown.
import { esc, toast } from "./ui.js";
import { icon } from "./icons.js";
import { projectColor } from "./store.js";

let tab = "linea";
let day = null;        // YYYY-MM-DD; null = hoy
let data = null;
let mdText = "";

const hm = (msv) => {
  const m = Math.round(msv / 60000);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")}`;
};
const usd = (n) => `US$ ${n.toFixed(2)}`;
const fmtTok = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} M` : n >= 1e3 ? `${(n / 1e3).toFixed(0)} k` : String(n));
const localDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

export async function openDay() {
  let dlg = document.getElementById("dlg-dia");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "dlg-dia";
    dlg.className = "dia";
    document.body.append(dlg);
    dlg.addEventListener("click", onClick);
  }
  if (!dlg.open) dlg.showModal();
  await load();
}

async function load() {
  const dlg = document.getElementById("dlg-dia");
  paint(true);
  const q = day ? `?dia=${day}` : "";
  try {
    [data, mdText] = await Promise.all([
      fetch(`/api/actividad${q}`, { cache: "no-store" }).then((r) => r.json()),
      fetch("/api/hoy", { cache: "no-store" }).then((r) => r.text()),
    ]);
  } catch {
    data = null;
  }
  if (dlg.open) paint(false);
}

async function onClick(e) {
  const t = e.target.closest("[data-dtab]");
  if (t) { tab = t.dataset.dtab; paint(false); return; }
  const nav = e.target.closest("[data-dnav]");
  if (nav) {
    const base = day ? new Date(`${day}T12:00:00`) : new Date();
    base.setDate(base.getDate() + Number(nav.dataset.dnav));
    const today = localDay(new Date());
    day = localDay(base) >= today ? null : localDay(base);
    await load();
    return;
  }
  if (e.target.closest("[data-dclose]")) { document.getElementById("dlg-dia").close(); return; }
  if (e.target.closest("[data-dcopy]")) { await navigator.clipboard?.writeText(mdText); toast("Resumen copiado", "copy"); }
}

function paint(loading) {
  const dlg = document.getElementById("dlg-dia");
  const isToday = !day;
  const label = isToday ? "Hoy" : new Date(`${day}T12:00:00`).toLocaleDateString("es-CL", { weekday: "long", day: "numeric", month: "long" });
  const t = data?.total;
  dlg.innerHTML = `
    <div class="dh"><h2>${icon("sun")}${esc(label)}</h2>
      <button class="btn ghost icon" data-dnav="-1" title="Día anterior">${icon("chevron", { cls: "rot90" })}</button>
      <button class="btn ghost icon" data-dnav="1" title="Día siguiente" ${isToday ? "disabled" : ""}>${icon("chevron", { cls: "rot-90" })}</button>
      <span class="spacer"></span>
      ${t ? `<span class="dkpi"><b>${hm(t.working_ms)}</b> trabajando</span><span class="dkpi wait"><b>${hm(t.waiting_ms)}</b> esperándote</span><span class="dkpi"><b>${t.prompts}</b> pedidos</span><span class="dkpi cost" title="Equivalente a precios de la API"><b>${usd(t.cost_usd)}</b> equiv. API</span>` : ""}
      <button class="btn ghost icon" data-dclose aria-label="Cerrar">${icon("x")}</button></div>
    <div class="stabs">
      ${[["linea", "Línea de tiempo"], ["costo", "Costo y tokens"], ["resumen", "Resumen para el daily"]].map(([k, l]) => `<button data-dtab="${k}" class="${k === tab ? "on" : ""}">${l}</button>`).join("")}
    </div>
    <div class="dbody">${loading || !data ? `<div style="padding:30px"><div class="skeleton"></div><div class="skeleton" style="width:80%"></div></div>` : body()}</div>`;
}

function body() {
  if (!data.sessions.length) return `<div class="empty">${icon("clock", { size: 32 })}Sin actividad registrada este día.</div>`;
  if (tab === "costo") return costView();
  if (tab === "resumen") return `<div class="mdhead"><span class="muted">Markdown listo para pegar (sesiones de hoy, por proyecto).</span><span class="spacer"></span><button class="btn" data-dcopy>${icon("copy")}Copiar</button></div><pre class="mdpre">${esc(mdText)}</pre>`;
  return timeline();
}

function timeline() {
  const start = Date.parse(data.day_start);
  const end = Math.min(start + 864e5, Date.parse(data.now));
  // Escala: desde la primera actividad (redondeada a la hora) hasta ahora o el fin del dia.
  const first = Math.min(...data.sessions.flatMap((s) => s.segments.map((x) => Date.parse(x.a))), end - 3600e3);
  const from = Math.max(start, Math.floor(first / 3600e3) * 3600e3);
  const to = Math.max(from + 3600e3, Math.ceil(end / 3600e3) * 3600e3);
  const pct = (t) => ((t - from) / (to - from)) * 100;
  const hours = [];
  for (let h = from; h <= to; h += 3600e3) hours.push(h);
  const step = hours.length > 14 ? 2 : 1;
  const nowLine = Date.parse(data.now) <= to ? `<i class="nowline" style="left:${pct(Date.parse(data.now))}%"></i>` : "";
  return `<div class="tl">
    <div class="tlrow tlhead"><div class="tllabel"></div><div class="tltrack">${hours.map((h, i) => i % step ? "" : `<span class="tick" style="left:${pct(h)}%">${new Date(h).getHours()}:00</span>`).join("")}</div><div class="tltot">trab. / espera</div></div>
    ${data.sessions.map((s) => `<div class="tlrow">
      <div class="tllabel" title="${esc(s.title)}"><span class="proj" style="--c:${projectColor(s.repos?.[0] ?? s.workspace)}"><i></i></span><a href="${esc(s.open_url)}">${esc(s.title)}</a></div>
      <div class="tltrack">${hours.map((h) => `<i class="grid" style="left:${pct(h)}%"></i>`).join("")}${nowLine}
        ${s.segments.map((x) => {
          const a = Date.parse(x.a), b = Date.parse(x.b);
          const tip = `${x.k === "trabajando" ? "Trabajando" : "Esperándote"} ${new Date(a).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })}–${new Date(b).toLocaleTimeString("es-CL", { hour: "2-digit", minute: "2-digit" })} (${hm(b - a)})`;
          return `<span class="seg ${x.k}" style="left:${pct(a)}%;width:${Math.max(0.35, pct(b) - pct(a))}%" title="${tip}"></span>`;
        }).join("")}</div>
      <div class="tltot"><b>${hm(s.working_ms)}</b> <span class="muted">/ ${hm(s.waiting_ms)}</span></div>
    </div>`).join("")}
    <div class="tllegend"><span><span class="seg trabajando"></span>Claude trabajando</span><span><span class="seg esperando"></span>esperando tu respuesta</span>
      <span class="muted">Las esperas de más de 12 h cuentan como inactividad. Pasa el mouse por una barra para ver el horario.</span></div>
  </div>`;
}

function costView() {
  const rows = [...data.sessions].sort((a, b) => b.cost_usd - a.cost_usd);
  const max = Math.max(...rows.map((r) => r.cost_usd), 0.01);
  const t = data.total;
  return `<div class="costwrap">
    <p class="muted">Costo <b>equivalente a precios de la API</b> (USD por millón de tokens según el modelo, con caché). Si usas una suscripción, no es lo que pagas: sirve para comparar sesiones. Incluye subagentes.</p>
    <table class="grid cost"><thead><tr><th>Sesión</th><th class="r">Pedidos</th><th class="r">Entrada</th><th class="r">Salida</th><th class="r">Caché leída</th><th class="r">Caché escrita</th><th>Costo</th></tr></thead><tbody>
    ${rows.map((r) => `<tr><td class="ttl"><span class="proj" style="--c:${projectColor(r.repos?.[0] ?? r.workspace)}"><i></i></span> ${esc(r.title)}${r.unknown_model ? ` <span class="muted" title="Modelo sin precio conocido: estimado como Opus 5.5">*</span>` : ""}</td>
      <td class="r mono">${r.prompts}</td><td class="r mono">${fmtTok(r.tokens.in)}</td><td class="r mono">${fmtTok(r.tokens.out)}</td>
      <td class="r mono">${fmtTok(r.tokens.cr)}</td><td class="r mono">${fmtTok(r.tokens.cw5 + r.tokens.cw1)}</td>
      <td><div class="costbar"><i style="width:${(r.cost_usd / max) * 100}%"></i><span class="mono">${usd(r.cost_usd)}</span></div>
        <div class="muted" style="font-size:11px">${Object.entries(r.by_model).map(([m, c]) => `${esc(m)} ${usd(c)}`).join(" · ")}</div></td></tr>`).join("")}
    </tbody><tfoot><tr><td><b>Total</b></td><td class="r mono"><b>${t.prompts}</b></td><td class="r mono">${fmtTok(t.tokens.in)}</td><td class="r mono">${fmtTok(t.tokens.out)}</td><td class="r mono">${fmtTok(t.tokens.cr)}</td><td class="r mono">${fmtTok(t.tokens.cw5 + t.tokens.cw1)}</td><td class="mono"><b>${usd(t.cost_usd)}</b></td></tr></tfoot></table>
  </div>`;
}
