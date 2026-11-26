// Markdown seguro para el panel (conversacion del detalle y visor de archivos .md).
// Se escapa todo el texto; solo se generan las etiquetas de abajo. Soporta: titulos, parrafos, **negrita**,
// *cursiva*, ~~tachado~~, `codigo` (protegido: lo de adentro no se interpreta), bloques ``` y ::: (wiki ADO),
// tablas GFM (alineacion, \| y | dentro de `codigo`), listas anidadas por sangria y de tareas, citas >,
// separadores, enlaces e imagenes. Los enlaces relativos se resuelven con opts.resolve(url) -> href | null
// (null: se muestra el texto, sin enlace).

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const ABSOLUTE = /^(https?:|vscode:|mailto:|#)/i;
const LIST = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const FENCE = /^\s*(```+|:::)\s*([\w-]*)/;
const ROW = /^\s*\|.*\|\s*$/;
const SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;
// Archivos que se pueden abrir desde la conversacion: documentos, datos e imagenes (con carpeta opcional).
const RUTA = String.raw`(?:[A-Za-z]:[\\/])?(?:[\w.\-]+[\\/])*[\w.\-]+\.(?:md|html?|pdf|pptx|xlsx|xlsm|docx|svg|png|jpe?g|csv|ipynb|zip|txt)`;
const ARCHIVO_EN_TEXTO = new RegExp(String.raw`(^|[\s(>«"])(` + RUTA + String.raw`)(?![\w\-\\/]|\.\w)`, "gi");
const ARCHIVO_SOLO = new RegExp(`^${RUTA}$`, "i");

/** Texto en linea a HTML: codigo y enlaces se apartan antes de escapar y aplicar enfasis. */
function inline(text, opts, links = true) {
  const slots = [];
  const keep = (html) => `\u0000${slots.push(html) - 1}\u0000`;
  let t = String(text ?? "");
  t = t.replace(/(`+)([^`]|[^`][\s\S]*?[^`])\1(?!`)/g, (_, __, c) => {
    // `ruta/o/archivo.pptx` entre comillas invertidas tambien es un archivo mencionado.
    const m = links && opts.mention && ARCHIVO_SOLO.test(c.trim()) ? opts.mention(c.trim()) : null;
    return keep(m ? `<a href="#" class="docmention" data-docmention="${esc(m)}" title="Abrir · ${esc(c.trim())}"><code>${esc(c)}</code></a>` : `<code>${esc(c)}</code>`);
  });
  if (links) {
    t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, u) => {
      const href = ABSOLUTE.test(u) ? u : opts.resolve?.(u);
      return keep(href ? `<img alt="${esc(alt)}" src="${esc(href)}">` : `<span class="ref" title="${esc(u)}">${esc(alt || u)}</span>`);
    });
    t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, u) => {
      const href = ABSOLUTE.test(u) ? u : opts.resolve?.(u);
      const inner = inline(label, opts, false);
      const m = !href && opts.mention?.(u);
      if (m) return keep(`<a href="#" class="docmention" data-docmention="${esc(m)}">${inner}</a>`);
      return keep(href ? `<a href="${esc(href)}" target="_blank" rel="noopener">${inner}</a>` : `<span class="ref" title="${esc(u)}">${inner}</span>`);
    });
    t = t.replace(/(^|[\s(])(https?:\/\/[^\s<>)\]]+)/g, (_, p, u) => p + keep(`<a href="${esc(u)}" target="_blank" rel="noopener">${esc(u)}</a>`));
    // Nombres de archivo sueltos en el texto (sin sintaxis de enlace) que son documentos de la sesión.
    if (opts.mention) {
      t = t.replace(ARCHIVO_EN_TEXTO, (full, pre, fn) => {
        const m = opts.mention(fn);
        return m ? pre + keep(`<a href="#" class="docmention" data-docmention="${esc(m)}" title="Abrir · ${esc(fn)}">${esc(fn)}</a>`) : full;
      });
    }
  }
  t = esc(t)
    .replace(/\*\*(?=\S)([\s\S]*?\S)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)([\s\S]*?\S)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/(^|[^*\w])\*(?=[^\s*])([^*]*?[^\s*])\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/(^|[^\w])_(?=[^\s_])([^_]*?[^\s_])_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)([\s\S]*?\S)~~/g, "<del>$1</del>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => slots[Number(i)]);
}

/** Celdas de una fila de tabla: respeta \| y los | dentro de `codigo`. */
function cells(line) {
  const s = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const out = [];
  let cur = "", tick = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "\\" && s[i + 1] === "|") { cur += "|"; i++; continue; }
    if (c === "`") {
      let n = 1;
      while (s[i + n] === "`") n++;
      tick = tick === 0 ? n : tick === n ? 0 : tick;
      cur += "`".repeat(n); i += n - 1; continue;
    }
    if (c === "|" && tick === 0) { out.push(cur.trim()); cur = ""; continue; }
    cur += c;
  }
  out.push(cur.trim());
  return out;
}

function table(head, sep, rows, opts) {
  const align = cells(sep).map((c) => (c.startsWith(":") && c.endsWith(":") ? "center" : c.endsWith(":") ? "right" : ""));
  const cell = (tag, c, j) => `<${tag}${align[j] ? ` style="text-align:${align[j]}"` : ""}>${inline(c, opts)}</${tag}>`;
  const width = head.length;
  const fit = (r) => (r.length >= width ? r.slice(0, width) : r.concat(Array(width - r.length).fill("")));
  return `<div class="tbl"><table><thead><tr>${head.map((c, j) => cell("th", c, j)).join("")}</tr></thead>` +
    `<tbody>${rows.map((r) => `<tr>${fit(r).map((c, j) => cell("td", c, j)).join("")}</tr>`).join("")}</tbody></table></div>`;
}

/** Lista (con anidamiento por sangria) a partir de sus items { indent, ordered, start, text }. */
function list(items, opts) {
  let html = "";
  const stack = [];
  const top = () => stack[stack.length - 1];
  const open = (it) => {
    const tag = it.ordered ? "ol" : "ul";
    html += it.ordered && it.start !== 1 ? `<ol start="${it.start}">` : `<${tag}>`;
    stack.push({ indent: it.indent, tag });
  };
  for (const it of items) {
    const tag = it.ordered ? "ol" : "ul";
    while (stack.length && it.indent < top().indent) html += `</li></${stack.pop().tag}>`;
    if (stack.length && it.indent === top().indent) {
      if (top().tag !== tag) { html += `</li></${stack.pop().tag}>`; open(it); } else html += "</li>";
    } else open(it);
    const task = it.text.match(/^\[([ xX])\]\s+(.*)$/);
    html += task
      ? `<li class="task"><input type="checkbox" disabled${task[1] !== " " ? " checked" : ""}> ${inline(task[2], opts)}`
      : `<li>${inline(it.text, opts)}`;
  }
  while (stack.length) html += `</li></${stack.pop().tag}>`;
  return html;
}

/**
 * Markdown a HTML. opts.resolve(url): href para enlaces relativos (o null); opts.headingOffset: suma niveles a los
 * titulos (el chat usa 2: # -> h3), con tope en h6.
 */
export function renderMarkdown(src, opts = {}) {
  const lines = String(src ?? "").replace(/\r/g, "").split("\n");
  const off = opts.headingOffset ?? 0;
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const l = lines[i];
    const fence = l.match(FENCE);
    if (fence) {
      const close = fence[1].startsWith("`") ? "```" : ":::";
      const lang = fence[2];
      const body = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(close)) body.push(lines[i++]);
      i++;
      out.push(`<pre class="code" data-lang="${esc(lang)}">${lang ? `<span class="lang">${esc(lang)}</span>` : ""}<code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (ROW.test(l) && SEP.test(lines[i + 1] ?? "")) {
      const head = cells(l), sep = lines[i + 1];
      i += 2;
      const rows = [];
      while (i < lines.length && ROW.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(table(head, sep, rows, opts));
      continue;
    }
    const h = l.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/);
    if (h) {
      const n = Math.min(6, h[1].length + off);
      out.push(`<h${n}>${inline(h[2], opts)}</h${n}>`); i++; continue;
    }
    if (HR.test(l)) { out.push("<hr>"); i++; continue; }
    if (/^\s*>/.test(l)) {
      const q = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ""));
      out.push(`<blockquote>${renderMarkdown(q.join("\n"), opts)}</blockquote>`);
      continue;
    }
    if (LIST.test(l)) {
      const items = [];
      while (i < lines.length) {
        const m = lines[i].match(LIST);
        if (m) {
          items.push({ indent: m[1].replace(/\t/g, "    ").length, ordered: /\d/.test(m[2]), start: parseInt(m[2], 10) || 1, text: m[3] });
          i++;
        } else if (items.length && /^\s{2,}\S/.test(lines[i]) && !FENCE.test(lines[i])) {
          items[items.length - 1].text += " " + lines[i++].trim();        // continuacion del item
        } else if (!lines[i].trim() && LIST.test(lines[i + 1] ?? "") ) {
          i++;                                                           // linea en blanco entre items
        } else break;
      }
      out.push(list(items, opts));
      continue;
    }
    if (!l.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !FENCE.test(lines[i]) && !HR.test(lines[i]) && !LIST.test(lines[i])
      && !/^\s*(#{1,6}\s|>)/.test(lines[i]) && !(ROW.test(lines[i]) && SEP.test(lines[i + 1] ?? ""))) para.push(lines[i++]);
    if (para.length) out.push(`<p>${para.map((p) => inline(p, opts)).join("<br>")}</p>`);
    else i++;
  }
  return out.join("\n");
}
