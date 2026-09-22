import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const PORT = 8799;
const ROOT = path.resolve("/Users/ray/Documents/MyTypst");

async function waitForServer(url, tries = 40) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const res = await fetch(url);
      if (res.ok) return res;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error("server did not start");
}

test("http API: health, compile, path sandbox, export", async () => {
  const sample = path.join(ROOT, "sample");
  const child = spawn(
    process.execPath,
    [path.join(ROOT, "server/index.js"), "--root", sample, "--port", String(PORT), "--host", "127.0.0.1"],
    { env: { ...process.env }, stdio: ["ignore", "pipe", "pipe"] },
  );
  try {
    await waitForServer(`http://127.0.0.1:${PORT}/api/health`);
    const health = await fetch(`http://127.0.0.1:${PORT}/api/health`).then((r) => r.json());
    assert.equal(health.ok, true);

    const project = await fetch(`http://127.0.0.1:${PORT}/api/project`).then((r) => r.json());
    assert.ok(Array.isArray(project.files));

    const esc = await fetch(
      `http://127.0.0.1:${PORT}/api/file?path=${encodeURIComponent("../package.json")}`,
    );
    assert.equal(esc.status, 400);

    const put = await fetch(`http://127.0.0.1:${PORT}/api/file`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: "tmp-http.typ", content: "= HTTP\n" }),
    });
    assert.equal(put.status, 200);

    const compile = await fetch(`http://127.0.0.1:${PORT}/api/compile`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entry: "tmp-http.typ" }),
    }).then((r) => r.json());
    assert.equal(compile.ok, true, JSON.stringify(compile));

    const pdf = await fetch(`http://127.0.0.1:${PORT}/api/pdf`);
    assert.equal(pdf.status, 200);
    assert.equal(pdf.headers.get("content-type"), "application/pdf");

    const exportPdf = await fetch(`http://127.0.0.1:${PORT}/api/export?format=pdf`);
    assert.equal(exportPdf.status, 200);

    // cleanup temp file via API
    await fetch(`http://127.0.0.1:${PORT}/api/file?path=tmp-http.typ`, { method: "DELETE" });
  } finally {
    child.kill("SIGTERM");
  }
});
