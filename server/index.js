import express from "express";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { newProject } from "./project.js";
import { compileProject, exportArtifact, typstVersion } from "./compile.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const PUBLIC = path.join(ROOT, "public");
const SAMPLE = path.join(ROOT, "sample");

function parseArgs(argv) {
  const out = { root: null, port: null, host: null };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === "--root" || a === "-r") out.root = argv[++i];
    else if (a === "--port" || a === "-p") out.port = Number(argv[++i]);
    else if (a === "--host" || a === "-h") out.host = argv[++i];
    else if (a.startsWith("--root=")) out.root = a.slice(7);
    else if (a.startsWith("--port=")) out.port = Number(a.slice(7));
    else if (a.startsWith("--host=")) out.host = a.slice(7);
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const PORT = args.port ?? Number(process.env.PORT || 8787);
const HOST = args.host ?? process.env.HOST ?? "127.0.0.1";

let project = newProject(args.root ? path.resolve(args.root) : SAMPLE);

const app = express();
app.use(express.json({ limit: "5mb" }));
app.use(express.static(PUBLIC));

function fail(res, err) {
  const status = err.status || (err.code === "ENOENT" ? 404 : 500);
  res.status(status).json({ error: err.message || String(err), code: err.code });
}

function projectInfo() {
  return {
    root: project.root,
    name: path.basename(project.root),
  };
}

function safeFilename(name) {
  return String(name).replace(/["\\\r\n]/g, "_").slice(0, 120) || "document";
}

app.get("/api/health", async (_req, res) => {
  const version = await typstVersion();
  res.json({ ok: Boolean(version), typstVersion: version, ...projectInfo() });
});

app.get("/api/project", async (_req, res) => {
  try {
    await project.assertDir();
    const files = await project.tree();
    res.json({ ...projectInfo(), files });
  } catch (e) {
    fail(res, e);
  }
});

app.post("/api/project/open", async (req, res) => {
  try {
    const p = req.body?.path;
    if (!p) {
      return res.status(400).json({ error: "path required" });
    }
    const next = newProject(path.resolve(p));
    await next.assertDir();
    project = next;
    const files = await project.tree();
    res.json({ ...projectInfo(), files });
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/file", async (req, res) => {
  try {
    const data = await project.readFile(String(req.query.path || ""));
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

app.put("/api/file", async (req, res) => {
  try {
    const { path: rel, content } = req.body || {};
    if (typeof content !== "string") {
      return res.status(400).json({ error: "content (string) required" });
    }
    const data = await project.writeFile(String(rel || ""), content);
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

app.post("/api/file/create", async (req, res) => {
  try {
    const { path: rel, content } = req.body || {};
    const data = await project.createFile(
      String(rel || ""),
      typeof content === "string" ? content : "",
    );
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

app.delete("/api/file", async (req, res) => {
  try {
    const data = await project.deleteFile(String(req.query.path || ""));
    res.json(data);
  } catch (e) {
    fail(res, e);
  }
});

app.post("/api/compile", async (req, res) => {
  try {
    const result = await compileProject(project, {
      entry: req.body?.entry,
      format: "pdf",
    });
    res.json(result);
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/pdf", async (_req, res) => {
  try {
    const abs = project.outPath("pdf");
    if (!fs.existsSync(abs)) {
      return res.status(404).json({ error: "No PDF yet — compile first" });
    }
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    fs.createReadStream(abs).pipe(res);
  } catch (e) {
    fail(res, e);
  }
});

app.get("/api/export", async (req, res) => {
  try {
    const format = String(req.query.format || "pdf");
    const result = await exportArtifact(project, format);
    if (!result.ok) {
      return res.status(422).json({ ok: false, diagnostics: result.diagnostics });
    }
    const types = {
      pdf: "application/pdf",
      svg: "image/svg+xml",
      png: "image/png",
    };
    res.setHeader("Content-Type", types[result.format]);
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="${safeFilename(result.filename)}"`,
    );
    res.send(result.buffer);
  } catch (e) {
    fail(res, e);
  }
});

// SPA fallback for non-API routes
app.get(/^\/(?!api\/).*/, (_req, res) => {
  res.sendFile(path.join(PUBLIC, "index.html"));
});

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  app.listen(PORT, HOST, async () => {
    const version = await typstVersion();
    console.log(`RippleTypst → http://${HOST}:${PORT}`);
    console.log(`Project root → ${project.root}`);
    console.log(`Typst → ${version || "NOT FOUND"}`);
    if (HOST !== "127.0.0.1" && HOST !== "localhost") {
      console.log(
        "Warning: non-loopback bind exposes local file APIs on the network.",
      );
    }
  });
}

export { app, getProject, setProject };
function getProject() {
  return project;
}
function setProject(p) {
  project = p;
}
