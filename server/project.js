import path from "node:path";
import fs from "node:fs/promises";

const VISIBLE = new Set([
  ".typ",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".bib",
  ".yaml",
  ".yml",
  ".json",
  ".csv",
  ".toml",
  ".xml",
  ".ttf",
  ".otf",
  ".woff",
  ".woff2",
  ".txt",
  ".md",
]);

const SKIP = new Set([".git", ".ripplytypst", "node_modules", ".DS_Store"]);

/** @typedef {{name:string,path:string,type:"file"|"dir",children?:TreeNode[]}} TreeNode */

function denied(message) {
  const err = new Error(message);
  err.code = "EACCES";
  err.status = 400;
  return err;
}

function invalid(message = "Invalid path") {
  const err = new Error(message);
  err.code = "EINVAL";
  err.status = 400;
  return err;
}

export class Project {
  constructor(root) {
    this.root = path.resolve(root);
    this.rootReal = null;
  }

  async realRoot() {
    if (!this.rootReal) {
      this.rootReal = await fs.realpath(this.root);
    }
    return this.rootReal;
  }

  async assertDir() {
    const st = await fs.stat(this.root);
    if (!st.isDirectory()) {
      throw Object.assign(new Error("Project root is not a directory"), {
        code: "ENOTDIR",
      });
    }
    this.rootReal = await fs.realpath(this.root);
  }

  /** Sync lexical resolve: rejects escapes and hidden/blocked segments. */
  resolve(rel) {
    const clean = String(rel ?? "").replace(/\\/g, "/");
    if (!clean || path.isAbsolute(clean) || clean.includes("\0")) {
      throw invalid();
    }
    const parts = clean.split("/").filter((p) => p.length > 0 && p !== ".");
    for (const part of parts) {
      if (part === "..") {
        throw denied("Path escapes project root");
      }
      if (part.startsWith(".") || SKIP.has(part)) {
        throw denied("Path segment is not allowed");
      }
    }
    const abs = path.resolve(this.root, ...parts);
    const rootWithSep = this.root.endsWith(path.sep) ? this.root : this.root + path.sep;
    if (abs !== this.root && !abs.startsWith(rootWithSep)) {
      throw denied("Path escapes project root");
    }
    return abs;
  }

  /**
   * After symlink resolution, ensure abs (or its nearest existing ancestor)
   * still lives under the real project root.
   */
  async ensureWithinRoot(abs) {
    const realRoot = await this.realRoot();
    const rootWithSep = realRoot.endsWith(path.sep) ? realRoot : realRoot + path.sep;
    let cur = abs;
    for (;;) {
      try {
        const real = await fs.realpath(cur);
        if (real !== realRoot && !real.startsWith(rootWithSep)) {
          throw denied("Path escapes project root");
        }
        return;
      } catch (e) {
        if (e.code === "EACCES" || e.status === 400) throw e;
        if (e.code !== "ENOENT") {
          // Unreadable intermediate (e.g. broken symlink target) is a denial.
          if (e.code === "ELOOP" || e.code === "ENOTDIR") {
            throw denied("Path escapes project root");
          }
          throw e;
        }
        const parent = path.dirname(cur);
        if (parent === cur) throw denied("Path escapes project root");
        cur = parent;
      }
    }
  }

  async resolveChecked(rel) {
    const abs = this.resolve(rel);
    await this.ensureWithinRoot(abs);
    return abs;
  }

  toRel(abs) {
    return path.relative(this.root, abs).split(path.sep).join("/");
  }

  isVisibleFile(name) {
    if (name.startsWith(".")) return false;
    const ext = path.extname(name).toLowerCase();
    return VISIBLE.has(ext);
  }

  async tree(rel = ".") {
    const abs = rel === "." ? this.root : await this.resolveChecked(rel);
    const entries = await fs.readdir(abs, { withFileTypes: true });
    entries.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    /** @type {TreeNode[]} */
    const out = [];
    for (const e of entries) {
      if (SKIP.has(e.name) || e.name.startsWith(".")) continue;
      const childAbs = path.join(abs, e.name);
      const childRel = this.toRel(childAbs);
      if (e.isDirectory()) {
        out.push({
          name: e.name,
          path: childRel,
          type: "dir",
          children: await this.tree(childRel),
        });
      } else if (e.isFile() && this.isVisibleFile(e.name)) {
        out.push({ name: e.name, path: childRel, type: "file" });
      }
    }
    return out;
  }

  async readFile(rel) {
    const abs = await this.resolveChecked(rel);
    const st = await fs.stat(abs);
    if (!st.isFile()) {
      throw Object.assign(new Error("Not a file"), { status: 400, code: "EISDIR" });
    }
    const content = await fs.readFile(abs, "utf8");
    return { path: this.toRel(abs), content, mtimeMs: st.mtimeMs };
  }

  async writeFile(rel, content) {
    const abs = await this.resolveChecked(rel);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.ensureWithinRoot(abs);
    await fs.writeFile(abs, content, "utf8");
    const st = await fs.stat(abs);
    return { ok: true, path: this.toRel(abs), mtimeMs: st.mtimeMs };
  }

  async createFile(rel, content = "") {
    const abs = this.resolve(rel);
    await this.ensureWithinRoot(abs);
    await fs.mkdir(path.dirname(abs), { recursive: true });
    await this.ensureWithinRoot(path.dirname(abs));
    try {
      await fs.writeFile(abs, content, { encoding: "utf8", flag: "wx" });
    } catch (e) {
      if (e.code === "EEXIST") {
        const err = new Error("File already exists");
        err.code = "EEXIST";
        err.status = 409;
        throw err;
      }
      throw e;
    }
    return { ok: true, path: this.toRel(abs) };
  }

  async deleteFile(rel) {
    const abs = await this.resolveChecked(rel);
    if (abs === this.root) {
      throw invalid("Cannot delete project root");
    }
    const st = await fs.lstat(abs);
    if (st.isDirectory()) {
      throw Object.assign(new Error("Refusing to delete a directory"), {
        code: "EISDIR",
        status: 400,
      });
    }
    await fs.unlink(abs);
    return { ok: true };
  }

  outDir() {
    return path.join(this.root, ".ripplytypst");
  }

  outPath(ext = "pdf") {
    return path.join(this.outDir(), `out.${ext}`);
  }

  async ensureOutDir() {
    await fs.mkdir(this.outDir(), { recursive: true });
  }

  async pickEntry(preferred) {
    if (preferred) {
      const abs = await this.resolveChecked(preferred);
      try {
        await fs.access(abs);
        return this.toRel(abs);
      } catch {
        throw Object.assign(new Error(`Entry not found: ${preferred}`), {
          code: "ENOENT",
          status: 404,
        });
      }
    }
    const main = path.join(this.root, "main.typ");
    try {
      await fs.access(main);
      return "main.typ";
    } catch {
      /* fall through */
    }
    const files = await this.tree();
    const stack = [...files];
    while (stack.length) {
      const n = stack.shift();
      if (n.type === "file" && n.name.endsWith(".typ")) return n.path;
      if (n.children) stack.push(...n.children);
    }
    return null;
  }
}

export function parseTypstStderr(stderr) {
  const diags = [];
  const lines = String(stderr || "").split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const m = lines[i].match(/^(error|warning):\s*(.*)$/);
    if (!m) {
      i += 1;
      continue;
    }
    const severity = m[1] === "error" ? "error" : "warning";
    let message = m[2];
    let file;
    let line;
    let col;
    let help;
    let j = i + 1;
    while (j < lines.length && !/^(error|warning):/.test(lines[j])) {
      const raw = lines[j];
      const loc = raw.match(/┌─\s+(.+):(\d+):(\d+)/);
      if (loc) {
        file = loc[1].trim();
        line = Number(loc[2]);
        col = Number(loc[3]);
      } else if (/^help:/.test(raw)) {
        help = raw.replace(/^help:\s*/, "").trim();
      }
      j += 1;
    }
    if (help) message = `${message}${message.endsWith(".") ? "" : "."} ${help}`;
    diags.push({ severity, message, file, line, col });
    i = j;
  }
  if (!diags.length && stderr.trim()) {
    diags.push({ severity: "error", message: stderr.trim().slice(0, 2000) });
  }
  return diags;
}

export function newProject(root) {
  return new Project(root);
}
