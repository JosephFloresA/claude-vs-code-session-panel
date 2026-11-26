/**
 * Base HTTP del panel: respuestas, cuerpo con limite, token de escritura y un enrutador minimo.
 *
 * Cada modulo de rutas (rutas/*.mjs) exporta register(router) y declara sus rutas:
 *   router.get("/api/x", (c) => c.json(200, {...}))
 *   router.post(/^\/api\/y\/([a-z]+)$/, (c) => c.json(200, hacer(c.params[0], c.body)), { limit: 64 * 1024 })
 * Los POST exigen X-Monitor-Token por defecto (auth: false para excepciones) y reciben el JSON en c.body.
 * Con { raw: true } el cuerpo llega como Buffer sin interpretar (p. ej. adjuntos binarios).
 * Una ruta que coincide en la ruta pero no en el metodo responde 405.
 */
import crypto from "node:crypto";

export const send = (res, code, type, body, headers = {}) => {
  res.writeHead(code, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
};
export const json = (res, code, obj) => send(res, code, "application/json; charset=utf-8", JSON.stringify(obj));

export function readBody(req, limit = 8192, raw = false) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error("cuerpo demasiado grande"), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on("end", () => { const b = Buffer.concat(chunks); resolve(raw ? b : b.toString("utf8")); });
    req.on("error", reject);
  });
}

/** Token por arranque: solo la pagina del panel lo conoce (va dentro de su HTML). */
export function createToken() {
  const value = crypto.randomBytes(24).toString("hex");
  const check = (req) => {
    const t = String(req.headers["x-monitor-token"] ?? "");
    return t.length === value.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(value));
  };
  return { value, check };
}

export const num = (v, def, min, max) => { const n = Number(v); return Number.isFinite(n) && v !== null ? Math.min(max, Math.max(min, n)) : def; };

export function createRouter({ token }) {
  const routes = [];
  const add = (method, pattern, handler, opts = {}) => routes.push({ method, pattern, handler, auth: opts.auth ?? method === "POST", limit: opts.limit ?? 8192, raw: !!opts.raw });
  const test = (pattern, pathname) => {
    if (typeof pattern === "string") return pattern === pathname ? [] : null;
    const m = pathname.match(pattern);
    return m ? m.slice(1) : null;
  };

  /** Devuelve true si alguna ruta atendio el pedido. */
  async function handle(req, res, url) {
    let pathMatched = false;
    for (const r of routes) {
      const params = test(r.pattern, url.pathname);
      if (!params) continue;
      pathMatched = true;
      if (r.method !== req.method) continue;
      if (r.auth && !token.check(req)) { json(res, 403, { error: "token inválido" }); return true; }
      let body = {};
      if (req.method === "POST") {
        try { body = r.raw ? await readBody(req, r.limit, true) : JSON.parse((await readBody(req, r.limit)) || "{}"); }
        catch (e) { json(res, e.status ?? 400, { ok: false, reason: e.status === 413 ? "demasiado_grande" : "json_invalido" }); return true; }
      }
      await r.handler({ req, res, url, params, body, query: url.searchParams,
        json: (code, obj) => json(res, code, obj), send: (code, type, b, h) => send(res, code, type, b, h) });
      return true;
    }
    if (pathMatched) { send(res, 405, "text/plain", "método no permitido"); return true; }
    return false;
  }

  return { get: (p, h, o) => add("GET", p, h, o), post: (p, h, o) => add("POST", p, h, o), handle, routes };
}
