// Token de escritura (X-Monitor-Token): el servidor genera uno por arranque y lo pone en el HTML del panel.
// Si el panel se reinicia con la pestaña abierta, el token de la pagina queda viejo y todo POST da 403
// («token inválido»). Este envoltorio de fetch siempre manda el token vigente y, ante ese 403, relee el token
// de la pagina del servidor y reintenta una vez: no hace falta recargar.
const HDR = "x-monitor-token";
let actual = document.querySelector('meta[name="monitor-token"]')?.content ?? "";

async function renovar() {
  try {
    const html = await (await origFetch("/", { cache: "no-store" })).text();
    const t = html.match(/name="monitor-token"\s+content="([0-9a-f]+)"/i)?.[1];
    if (t) { actual = t; document.querySelector('meta[name="monitor-token"]')?.setAttribute("content", t); return true; }
  } catch { /* servidor caido: el reintento fallara igual */ }
  return false;
}

/** Copia de init con el token vigente, si la peticion lo llevaba. null si no lo lleva. */
function conToken(init) {
  const h = init?.headers;
  if (!h) return null;
  if (h instanceof Headers) {
    if (!h.has(HDR)) return null;
    const n = new Headers(h); n.set(HDR, actual);
    return { ...init, headers: n };
  }
  const k = Object.keys(h).find((x) => x.toLowerCase() === HDR);
  if (!k) return null;
  return { ...init, headers: { ...h, [k]: actual } };
}

const origFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const first = conToken(init);
  if (!first) return origFetch(input, init);
  const res = await origFetch(input, first);
  if (res.status !== 403 || !(await renovar())) return res;
  return origFetch(input, conToken(init));
};

export const token = () => actual;
