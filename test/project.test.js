import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { newProject, parseTypstStderr } from "../server/project.js";
import { compileProject, typstVersion } from "../server/compile.js";

async function tmpProject() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ripplytypst-"));
  const project = newProject(dir);
  await project.writeFile("main.typ", "= Hello\n\nWorld.\n");
  return { dir, project };
}

test("resolve rejects path traversal", async () => {
  const { project, dir } = await tmpProject();
  assert.throws(() => project.resolve("../outside.txt"), /escapes|not allowed/);
  assert.throws(() => project.resolve("/etc/passwd"), /Invalid path|escapes/);
  const ok = project.resolve("sub/file.typ");
  assert.equal(ok.startsWith(dir), true);
});

test("resolve rejects hidden and blocked segments", async () => {
  const { project } = await tmpProject();
  assert.throws(() => project.resolve(".git/config"), /not allowed/);
  assert.throws(() => project.resolve(".ripplytypst/out.pdf"), /not allowed/);
  assert.throws(() => project.resolve("docs/.secret"), /not allowed/);
  assert.throws(() => project.resolve("node_modules/x"), /not allowed/);
});

test("file CRUD under root", async () => {
  const { project } = await tmpProject();
  await project.writeFile("notes/chapter.typ", "= Chapter\n");
  const data = await project.readFile("notes/chapter.typ");
  assert.equal(data.content, "= Chapter\n");
  await project.writeFile("notes/chapter.typ", "= Updated\n");
  const again = await project.readFile("notes/chapter.typ");
  assert.equal(again.content, "= Updated\n");
  await project.deleteFile("notes/chapter.typ");
  await assert.rejects(() => project.readFile("notes/chapter.typ"), /ENOENT|Not a file|no such/i);
});

test("deleteFile refuses directories", async () => {
  const { project } = await tmpProject();
  await project.writeFile("notes/a.typ", "x\n");
  await assert.rejects(() => project.deleteFile("notes"), /directory/i);
  // still present
  const data = await project.readFile("notes/a.typ");
  assert.equal(data.content, "x\n");
});

test("symlink escape is rejected", async () => {
  const { project, dir } = await tmpProject();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "ripplytypst-out-"));
  await fs.writeFile(path.join(outside, "secret.txt"), "secret");
  await fs.symlink(outside, path.join(dir, "escape"));
  await assert.rejects(() => project.readFile("escape/secret.txt"), /escapes|not allowed/);
  await assert.rejects(() => project.writeFile("escape/evil.typ", "x"), /escapes|not allowed/);
  await assert.rejects(() => project.deleteFile("escape/secret.txt"), /escapes|not allowed/);
});

test("pickEntry prefers main.typ and errors on missing preferred", async () => {
  const { project } = await tmpProject();
  await project.writeFile("other.typ", "other");
  assert.equal(await project.pickEntry(), "main.typ");
  await assert.rejects(() => project.pickEntry("nope.typ"), /Entry not found/);
  await project.deleteFile("main.typ");
  assert.equal(await project.pickEntry(), "other.typ");
});

test("parseTypstStderr extracts error location", () => {
  const stderr = `error: unknown variable: x
  ┌─ main.typ:3:8
  │
3 │ hello x
  │        ^

help: a variable with a similar name exists
`;
  const diags = parseTypstStderr(stderr);
  assert.equal(diags.length, 1);
  assert.equal(diags[0].severity, "error");
  assert.match(diags[0].message, /unknown variable/);
  assert.equal(diags[0].file, "main.typ");
  assert.equal(diags[0].line, 3);
  assert.equal(diags[0].col, 8);
});

test("compile sample and syntax error diagnostics", async () => {
  const version = await typstVersion();
  if (!version) {
    console.log("SKIP: typst CLI not available");
    return;
  }
  const { project } = await tmpProject();
  const ok = await compileProject(project, {});
  assert.equal(ok.ok, true, JSON.stringify(ok));
  assert.equal(ok.format, "pdf");

  await project.writeFile("main.typ", "= Hello\n\n#unknown-func()\n");
  const bad = await compileProject(project, {});
  assert.equal(bad.ok, false);
  assert.ok(bad.diagnostics.length > 0);
  assert.equal(bad.diagnostics[0].severity, "error");
});

test("compile multi-file include", async () => {
  const version = await typstVersion();
  if (!version) return;
  const { project } = await tmpProject();
  await project.writeFile("main.typ", "= Doc\n\n#include \"part.typ\"\n");
  await project.writeFile("part.typ", "Part body.\n");
  const result = await compileProject(project, {});
  assert.equal(result.ok, true, JSON.stringify(result));
});
