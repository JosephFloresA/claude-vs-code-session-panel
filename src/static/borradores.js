// Borradores de la caja de respuesta, uno por sesión: lo que escribiste no se pierde al cambiar de sesión
// en la bandeja, al abrir otro cajón ni al recargar la página. Se borra al enviar.
// localStorage es solo una comodidad: si no está disponible, el borrador vive en memoria mientras la página siga abierta.
const KEY = "monitor.borradores.v1";
const MAX_DIAS = 7;
const mem = new Map(); // session_id -> { text, at }

try {
  const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}");
  const limite = Date.now() - MAX_DIAS * 864e5;
  for (const [sid, d] of Object.entries(raw)) if (d?.text && d.at > limite) mem.set(sid, d);
} catch {}

let timer = null;
function persist() {
  clearTimeout(timer);
  timer = setTimeout(() => {
    try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(mem))); } catch {}
  }, 300);
}

export const getDraft = (sid) => (sid && mem.get(sid)?.text) || "";

export function setDraft(sid, text) {
  if (!sid) return;
  if (text && text.trim()) mem.set(sid, { text, at: Date.now() });
  else mem.delete(sid);
  persist();
}

export const clearDraft = (sid) => setDraft(sid, "");

// Guarda mientras escribes en cualquier caja de respuesta (bandeja o cajón).
document.addEventListener("input", (e) => {
  if (!e.target.matches?.("[data-replytext]")) return;
  setDraft(e.target.closest("[data-replyform]")?.dataset.sid, e.target.value);
});
