---
feature: typst-local-editor
status: delivered
updated: 2026-09-22
branch: feat/typst-local-editor
commits: (root) fd5d379..0848d99
---

# Local Typst Editor

## Report

**What was built** — A lightweight local Typst playground (inspired by typst.app/play) at `~/Documents/MyTypst`. A Node/Express process serves a three-pane UI (file tree · CodeMirror 6 · pdf.js live preview) and a JSON file API sandboxed to one opened project directory. Compilation shells out to the system `typst` CLI (`--root` restricted), with stderr parsed into clickable diagnostics. Multi-file projects work (`#include`), autosave/compile are debounced, and PDF/SVG/PNG export is available (SVG/PNG multi-page currently first page only). Default bind is `127.0.0.1:8787`.

**Verification** — `node --test test/project.test.js test/http.test.js` PASS 10/10 (path traversal, hidden segments, symlink escape, delete-dir refusal, CRUD, entry selection, stderr parse, compile happy/error, multi-file include, HTTP API). `npm run build` PASS. HTTP smoke: health/compile/pdf/export + sandbox 400s PASS. Playwright UI: three-pane layout, 3-page PDF preview, live diagnostics (`unknown variable: broken`) PASS. Re-review after critical fixes: APPROVE (symlink realpath sandbox, non-recursive delete, hidden-path deny).

**Journey log** —
- typst SVG/PNG multi-page needs `{p}` in the output path; `out.svg` fails on 3-page sample — use `out{p}.ext`.
- String `startsWith(root)` path checks miss symlink escapes; always `realpath` the deepest existing ancestor against `realpath(root)`.
- `fs.rm(..., { recursive: true })` on a file-delete API is a silent tree-wipe; use `unlink` + reject `EISDIR`.
- Programmatic CodeMirror doc replace must be flagged (`state.loading`) or every file open looks dirty and double-compiles.
- First HTTP delete-dir assertion used a non-existent `notes` path (404 vs 400) — create a real directory before asserting rejection.

## [S1] Problem
Users want a lightweight Typst playground similar to https://typst.app/play/ that runs fully locally: open a port, edit `.typ` files in the browser, see live PDF preview, and export — without cloud accounts, collaboration, or vendor lock-in.

## [S2] Design

### Product shape
A single Node process serves a browser UI and a small JSON/file API. Compilation shells out to the local `typst` CLI (system binary, default `typst`, overridable via `TYPST_BIN`). The user opens **one local project directory** (the document root). Multi-file projects are first-class.

Threat model: trusted local user. Default bind `127.0.0.1`. File APIs can re-root via `POST /api/project/open` to any local directory the OS user can read — intentional for a local editor. Non-loopback bind prints a warning.

### Runtime
- Listen on `127.0.0.1:8787` by default; override with `HOST` / `PORT`.
- CLI: `node server/index.js [--root <dir>] [--port <n>] [--host <addr>]`.
- If `--root` is omitted, serve the bundled `sample/` project and allow switching root via the UI (path input) or `POST /api/project/open`.
- Only paths under the active project root are readable/writable: lexical reject of absolute/NUL/`..`/hidden segments, then `realpath` containment (symlink-safe). `DELETE` is file-only (`unlink`); directories are rejected (`EISDIR`).

### UI layout (playground-like)
```
┌────────────┬──────────────────────┬─────────────────────┐
│ File tree  │ CodeMirror 6 editor  │ PDF preview         │
│ (left)     │ + diagnostics list   │ (pdf.js, zoom/pages)│
└────────────┴──────────────────────┴─────────────────────┘
```
- Editor: CodeMirror 6 with Typst-ish highlighting (markup/code mode light), line numbers, tab=2 spaces.
- Autosave: debounce 400ms on idle; status chip (saved / saving / error). Programmatic loads do not mark dirty.
- Compile: debounce 500ms after edit; also `Ctrl/Cmd+S` (save+compile) and `Ctrl/Cmd+Enter` (compile).
- Diagnostics: parse `typst` stderr into `{severity, message, file, line, col}`; click jumps to source.
- Preview: render PDF via pdf.js into canvas stack (continuous pages), fit-width default, zoom 50–200%.
- Export: Download PDF always full document; SVG/PNG via `typst compile --format` with `out{p}` — multi-page returns first page in v1.

### API contracts
| Method | Path | Body / Query | Response |
|--------|------|--------------|----------|
| GET | `/api/health` | — | `{ok, typstVersion}` |
| GET | `/api/project` | — | `{root, name, files: TreeNode[]}` |
| POST | `/api/project/open` | `{path}` | same as GET project |
| GET | `/api/file` | `?path=rel` | `{path, content, mtimeMs}` |
| PUT | `/api/file` | `{path, content}` | `{ok, mtimeMs}` |
| POST | `/api/compile` | `{entry?: "main.typ"}` | `{ok, pdfPath?, diagnostics: Diagnostic[], durationMs}` |
| GET | `/api/pdf` | — | `application/pdf` bytes of last successful compile |
| GET | `/api/export` | `?format=pdf\|svg\|png` | download bytes |
| POST | `/api/file/create` | `{path, content?}` | `{ok}` |
| DELETE | `/api/file` | `?path=rel` | `{ok}` (files only) |

`TreeNode`: `{name, path, type: "file"|"dir", children?}` (hide `.git`, `.mytypst`, `node_modules`, dotfiles).

`Diagnostic`: `{severity: "error"|"warning", message, file?, line?, col?}`.

Compile writes PDF to `<project>/.mytypst/out.pdf` (hidden from tree/API). Errors keep last good preview and show diagnostics. Explicit missing `entry` returns `{ok:false}` (no silent fallback).

### Typst invocation
```
typst compile --root <projectRoot> --format pdf|svg|png <entry> <out>
```
- Default entry: `main.typ` if present, else the active open file, else first `.typ`.
- Timeout 15s; capture stdout/stderr; non-zero exit → diagnostics from stderr.
- `typst --version` at startup for `/api/health`.

### Frontend stack
- Bundled with esbuild: `public/app.js` → `public/dist/app.js`.
- pdf.js from `pdfjs-dist` (bundled worker at `/dist/pdf.worker.mjs`).
- No React; vanilla modules + one small store.

### Error behavior
- Path outside root / hidden segment → 400 `{error}`.
- Missing file → 404.
- Delete directory → 400 `EISDIR`.
- Compile failure → `{ok:false, diagnostics}` (preview unchanged).
- typst missing → health `ok:false` and UI banner.

### Testing boundaries
- Server: path safety (traversal, hidden, symlink), file CRUD, delete-dir refusal, compile happy path + parse error diagnostics (uses real `typst`), HTTP API smoke.
- No browser E2E suite in v1; UI verified with Playwright smoke during delivery.

## [S3] Out of Scope
- Multiplayer / share links / cloud sync / auth
- Package browser UI (CLI `@preview` packages still work if typst can fetch/cache them)
- Presentation mode, comment threads, Git sync UI
- WASM in-browser compilation
- Custom Typst syntax LSP / full language server
- Multi-project workspace dashboard
- Zip multi-page SVG/PNG export (first page only)

## Tasks
- [x] T1: Scaffold Node app + package.json + sample project — acceptance: `npm start` boots and `/api/health` returns typst version (covers: S2)
- [x] T2: File API + project root sandbox — acceptance: CRUD works under root; traversal rejected (covers: S2)
- [x] T3: Compile pipeline + diagnostics parse + export — acceptance: sample `main.typ` compiles to PDF; syntax error yields clickable diagnostic (covers: S2)
- [x] T4: Frontend layout (tree / editor / preview) + autosave + compile loop — acceptance: edit triggers preview update; download PDF works (covers: S2)
- [x] T5: Tests for path safety and compile diagnostics — acceptance: `npm test` passes (covers: S2; depends: T2, T3)
