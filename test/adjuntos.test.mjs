import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { guardarAdjunto, nombreSeguro } from "../src/adjuntos.mjs";

const SID = "0123abcd-0000-4000-8000-00000000abcd";

test("adjuntos: guarda dentro de la carpeta de la sesion, sin escaparse", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adj-"));
  const r = guardarAdjunto(SID, "..\..\evil.png", Buffer.from("x"), { dir });
  assert.equal(r.ok, true);
  assert.equal(path.dirname(r.path), path.join(dir, SID));
  assert.match(path.basename(r.path), /^\d{8}-\d{6}_evil\.png$/);
  const r2 = guardarAdjunto(SID, "evil.png", Buffer.from("y"), { dir });
  assert.notEqual(r2.path, r.path, "no pisa un adjunto con el mismo nombre");
  assert.equal(fs.readFileSync(r2.path, "utf8"), "y");
});

test("adjuntos: rechaza sesion invalida y cuerpo vacio; limpia nombres", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "adj-"));
  assert.equal(guardarAdjunto("../x", "a.txt", Buffer.from("x"), { dir }).reason, "sesion_invalida");
  assert.equal(guardarAdjunto(SID, "a.txt", Buffer.alloc(0), { dir }).reason, "vacio");
  assert.equal(nombreSeguro(""), "archivo");
  assert.equal(nombreSeguro("a<b>:c?.txt"), "a_b_c_.txt");
  assert.ok(nombreSeguro("x".repeat(200) + ".pdf").endsWith(".pdf"));
  assert.ok(nombreSeguro("x".repeat(200) + ".pdf").length <= 80);
});
