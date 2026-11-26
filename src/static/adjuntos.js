// Adjuntos de la caja de respuesta: clip, Ctrl+V de una imagen o arrastrar archivos.
// Quedan pendientes por sesión (sobreviven al repintado del detalle) y se suben al enviar:
// el servidor los guarda en una carpeta local y la ruta se agrega al mensaje para que Claude los lea con Read.
import { esc, toast } from "./ui.js";
import { icon } from "./icons.js";

const TOKEN = document.querySelector('meta[name="monitor-token"]')?.content ?? "";
const MAX = 25 * 1024 * 1024;
const pend = new Map(); // session_id -> [{ id, file, name, url }]
let seq = 0;

const kb = (n) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1048576).toFixed(1)} MB`);
const listFor = (sid) => pend.get(sid) ?? [];

/** Chips de los adjuntos pendientes de una sesión (lo pinta el composer). */
export function attsHtml(sid) {
  const l = listFor(sid);
  if (!l.length) return "";
  return l.map((a) => `<span class="attchip" title="${esc(a.name)} · ${kb(a.file.size)}">
      ${a.url ? `<img src="${a.url}" alt="">` : icon("file", { size: 14 })}
      <span class="attname">${esc(a.name)}</span><span class="attsize">${kb(a.file.size)}</span>
      <button type="button" class="attrm" data-attrm="${a.id}" aria-label="Quitar ${esc(a.name)}">${icon("x", { size: 12 })}</button>
    </span>`).join("");
}

export const hasAtts = (sid) => listFor(sid).length > 0;

function repaint(sid) {
  document.querySelectorAll(`[data-atts="${sid}"]`).forEach((el) => { el.innerHTML = attsHtml(sid); el.hidden = !hasAtts(sid); });
}

function addFiles(sid, files) {
  if (!sid) return;
  const l = listFor(sid);
  for (const f of files) {
    if (!f || !f.size) continue;
    if (f.size > MAX) { toast(`${f.name || "archivo"} pesa más de 25 MB`, "alert"); continue; }
    let name = f.name || "";
    if (!name || name === "image.png") name = `captura_${new Date().toTimeString().slice(0, 8).replace(/:/g, "")}.${(f.type.split("/")[1] || "png").replace("jpeg", "jpg")}`;
    l.push({ id: ++seq, file: f, name, url: f.type.startsWith("image/") ? URL.createObjectURL(f) : null });
  }
  pend.set(sid, l);
  repaint(sid);
}

function dropAtt(sid, id) {
  const l = listFor(sid);
  const a = l.find((x) => x.id === id);
  if (a?.url) URL.revokeObjectURL(a.url);
  pend.set(sid, l.filter((x) => x.id !== id));
  repaint(sid);
}

/** Sube los adjuntos pendientes. Devuelve las rutas locales; si alguno falla, no envía nada y los conserva. */
export async function uploadAtts(sid) {
  const l = listFor(sid);
  const paths = [];
  for (const a of l) {
    let res;
    try {
      res = await (await fetch(`/api/sesiones/${sid}/adjunto?name=${encodeURIComponent(a.name)}`, {
        method: "POST", headers: { "content-type": "application/octet-stream", "x-monitor-token": TOKEN }, body: a.file,
      })).json();
    } catch { res = { ok: false, reason: "red" }; }
    if (!res.ok) throw new Error(`${a.name}: ${res.reason ?? "error"}`);
    paths.push(res.path);
  }
  return paths;
}

export function clearAtts(sid) {
  listFor(sid).forEach((a) => a.url && URL.revokeObjectURL(a.url));
  pend.delete(sid);
  repaint(sid);
}

/** Texto final: lo escrito + la lista de rutas para que Claude las abra. */
export function withAtts(text, paths) {
  if (!paths.length) return text;
  const head = paths.length === 1 ? "Adjunto (ábrelo con Read):" : "Adjuntos (ábrelos con Read):";
  return `${text ? `${text}\n\n` : ""}${head}\n${paths.map((p) => `- ${p}`).join("\n")}`;
}

const sidOf = (el) => el?.closest("[data-replyform]")?.dataset.sid ?? el?.closest(".composer")?.querySelector("[data-replyform]")?.dataset.sid;

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-attach]");
  if (b) { b.closest("[data-replyform]")?.querySelector("[data-attinput]")?.click(); return; }
  const rm = e.target.closest("[data-attrm]");
  if (rm) dropAtt(sidOf(rm), Number(rm.dataset.attrm));
});
document.addEventListener("change", (e) => {
  if (!e.target.matches?.("[data-attinput]")) return;
  addFiles(sidOf(e.target), [...e.target.files]);
  e.target.value = "";
});
document.addEventListener("paste", (e) => {
  if (!e.target.matches?.("[data-replytext]")) return;
  const files = [...(e.clipboardData?.files ?? [])];
  if (!files.length) return;
  e.preventDefault();
  addFiles(sidOf(e.target), files);
});
document.addEventListener("dragover", (e) => {
  const c = e.target.closest?.(".composer");
  if (!c || !e.dataTransfer?.types?.includes("Files")) return;
  e.preventDefault();
  c.classList.add("dropping");
});
document.addEventListener("dragleave", (e) => {
  const c = e.target.closest?.(".composer");
  if (c && !c.contains(e.relatedTarget)) c.classList.remove("dropping");
});
document.addEventListener("drop", (e) => {
  const c = e.target.closest?.(".composer");
  if (!c) return;
  e.preventDefault();
  c.classList.remove("dropping");
  addFiles(sidOf(c.querySelector("[data-replyform]")), [...(e.dataTransfer?.files ?? [])]);
});
