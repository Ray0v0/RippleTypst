import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { parseTypstStderr } from "./project.js";

const TYPST_BIN = process.env.TYPST_BIN || "typst";
const TIMEOUT_MS = 15_000;

function run(cmd, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, TIMEOUT_MS);
    child.stdout.on("data", (d) => {
      stdout += d;
    });
    child.stderr.on("data", (d) => {
      stderr += d;
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ code: 127, stdout, stderr: String(err), timedOut: false, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, stdout, stderr, timedOut });
    });
  });
}

export async function typstVersion() {
  const r = await run(TYPST_BIN, ["--version"]);
  if (r.code !== 0) return null;
  return r.stdout.trim() || null;
}

/**
 * @param {import('./project.js').Project} project
 * @param {{entry?: string, format?: 'pdf'|'svg'|'png'}} opts
 */
export async function compileProject(project, opts = {}) {
  const format = opts.format === "svg" || opts.format === "png" ? opts.format : "pdf";
  let entryRel;
  try {
    entryRel = await project.pickEntry(opts.entry);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", message: e.message }],
      durationMs: 0,
    };
  }
  if (!entryRel) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", message: "No .typ entry file found (expected main.typ)" }],
      durationMs: 0,
    };
  }
  await project.ensureOutDir();
  // Multi-page SVG/PNG need a page-number template in the output path.
  const outAbs = project.outPath(format === "pdf" ? "pdf" : format);
  const outRel =
    format === "pdf"
      ? path.relative(project.root, outAbs)
      : path.join(".mytypst", `out{p}.${format}`);
  const start = Date.now();
  // Restrict FS access to project root via --root; cwd=root keeps paths simple.
  const r = await run(
    TYPST_BIN,
    ["compile", "--root", project.root, "--format", format, entryRel, outRel],
    { cwd: project.root },
  );
  const durationMs = Date.now() - start;
  if (r.spawnError) {
    return {
      ok: false,
      diagnostics: [
        {
          severity: "error",
          message: `Failed to run typst (${TYPST_BIN}): ${r.spawnError.message}`,
        },
      ],
      durationMs,
    };
  }
  if (r.timedOut) {
    return {
      ok: false,
      diagnostics: [{ severity: "error", message: "Compile timed out (15s)" }],
      durationMs,
    };
  }
  if (r.code !== 0) {
    return {
      ok: false,
      diagnostics: parseTypstStderr(r.stderr),
      durationMs,
      entry: entryRel,
    };
  }
  // warnings still on stderr
  const warnings = parseTypstStderr(r.stderr).filter((d) => d.severity === "warning");
  let outSize = 0;
  const dir = await fs.readdir(project.outDir()).catch(() => []);
  const artifacts = dir.filter((n) => n.startsWith("out") && n.endsWith(`.${format}`));
  for (const n of artifacts) {
    const st = await fs.stat(path.join(project.outDir(), n));
    outSize += st.size;
  }
  return {
    ok: true,
    diagnostics: warnings,
    durationMs,
    entry: entryRel,
    format,
    outPath: project.toRel(outAbs),
    artifacts,
    outSize,
  };
}

export async function exportArtifact(project, format) {
  const fmt = format === "pdf" || format === "svg" || format === "png" ? format : "pdf";
  // Clean previous artifacts so multi-page naming is predictable.
  try {
    const dir = await fs.readdir(project.outDir());
    for (const n of dir) {
      if (/^out.*\.(pdf|svg|png)$/.test(n)) {
        await fs.rm(path.join(project.outDir(), n), { force: true });
      }
    }
  } catch {
    /* ignore */
  }
  const result = await compileProject(project, { format: fmt });
  if (!result.ok) return result;
  const abs = project.outPath(fmt);
  const outDir = project.outDir();
  let buffer = await fs.readFile(abs).catch(() => null);
  let filename = `${path.basename(project.root) || "document"}.${fmt}`;
  if (!buffer) {
    const dir = await fs.readdir(outDir);
    const matches = dir
      .filter((n) => n.startsWith("out") && n.endsWith(`.${fmt}`))
      .sort();
    if (!matches.length) {
      return {
        ok: false,
        diagnostics: [{ severity: "error", message: "Export produced no output" }],
      };
    }
    if (matches.length === 1) {
      buffer = await fs.readFile(path.join(outDir, matches[0]));
    } else {
      // Multi-page SVG/PNG: v1 returns the first page only (see spec S2).
      buffer = await fs.readFile(path.join(outDir, matches[0]));
      filename = `${path.basename(project.root) || "document"}-1.${fmt}`;
    }
  }
  return {
    ok: true,
    format: fmt,
    buffer,
    filename,
    pages: result.artifacts?.length || 1,
    note: result.artifacts?.length > 1 ? "first page only for multi-page SVG/PNG" : undefined,
  };
}
