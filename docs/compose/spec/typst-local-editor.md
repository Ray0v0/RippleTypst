---
feature: typst-local-editor
status: designed
updated: 2026-09-22
branch: feat/typst-local-editor
commits: 
---

# Local Typst Editor

## Report

## [S1] Problem
Users want a lightweight Typst playground similar to https://typst.app/play/ that runs fully locally: open a port, edit `.typ` files in the browser, see live PDF preview, and export — without cloud accounts, collaboration, or vendor lock-in.

## [S2] Design

### Product shape
A single Node process serves a browser UI and a small JSON/file API. Compilation shells out to the local `typst` CLI (system binary, default `typst`, overridable via `TYPST_BIN`). The user opens **one local project directory** (the document root). Multi-file projects are first-class.

### Runtime
- Listen on `127.0.0.1:8787` by default; override with `HOST` / `PORT`.
- CLI: `node server/index.js [--root <dir>] [--port <n>] [--host <addr>]`.
- If `--root` is omitted, serve the bundled `sample/` project and allow switching root via the UI (path input) or `POST /api/project/open`.
- Only paths under the active project root are readable/writable (resolve + prefix check; reject `..` escapes).

### UI layout (playground-like)
```
┌────────────┬──────────────────────┬─────────────────────┐
│ File tree  │ CodeMirror 6 editor  │ PDF preview         │
│ (left)     │ + diagnostics list   │ (pdf.js, zoom/pages)│
└────────────┴──────────────────────┴─────────────────────┘
```
- Editor: CodeMirror 6 with Typst-ish highlighting (markup/code mode light), line numbers, tab=2 spaces.
- Autosave: debounce 400ms on idle; status chip (saved / saving / error).
- Compile: debounce 500ms after edit; also `Ctrl/Cmd+S` (save+compile) and `Ctrl/Cmd+Enter` (compile).
- Diagnostics: parse `typst` stderr into `{severity, message, file, line, col}`; click jumps to source.
- Preview: render PDF via pdf.js into canvas stack (continuous pages), fit-width default, zoom 50–200%.
- Export: Download PDF / SVG / PNG (first page or all pages as zip later — v1: PDF always; SVG/PNG via `typst compile --format`).

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
| DELETE | `/api/file` | `?path=rel` | `{ok}` |

`TreeNode`: `{name, path, type: "file"|"dir", children?}` (files filtered to `.typ`, images, data, fonts, bib, etc. — hide `.git`).

`Diagnostic`: `{severity: "error"|"warning", message, file?, line?, col?}`.

Compile writes PDF to `<project>/.mytypst/out.pdf` (gitignored). Errors keep last good preview and show diagnostics.

### Typst invocation
```
typst compile --root <projectRoot> [--format pdf|svg|png] <entry> <out>
```
- Default entry: `main.typ` if present, else the active open file, else first `.typ`.
- Timeout 15s; capture stdout/stderr; non-zero exit → diagnostics from stderr.
- `typst --version` at startup for `/api/health`.

### Frontend stack
- Bundled with esbuild: `public/app.js` → `public/dist/app.js`.
- pdf.js from `pdfjs-dist` (bundled worker configured).
- No React; vanilla modules + one small store.

### Error behavior
- Path outside root → 400 `{error}`.
- Missing file → 404.
- Compile failure → 200 `{ok:false, diagnostics}` (preview unchanged).
- typst missing → health `ok:false` and UI banner.

### Testing boundaries
- Server: path safety, file CRUD, compile happy path + parse error diagnostics (uses real `typst`).
- No browser E2E in v1; verify UI by manual/headless smoke of critical flows if tooling available.

## [S3] Out of Scope
- Multiplayer / share links / cloud sync / auth
- Package browser UI (CLI `@preview` packages still work if typst can fetch/cache them)
- Presentation mode, comment threads, Git sync UI
- WASM in-browser compilation
- Custom Typst syntax LSP / full language server
- Multi-project workspace dashboard

## Tasks
- [ ] T1: Scaffold Node app + package.json + sample project — acceptance: `npm start` boots and `/api/health` returns typst version (covers: S2)
- [ ] T2: File API + project root sandbox — acceptance: CRUD works under root; traversal rejected (covers: S2)
- [ ] T3: Compile pipeline + diagnostics parse + export — acceptance: sample `main.typ` compiles to PDF; syntax error yields clickable diagnostic (covers: S2)
- [ ] T4: Frontend layout (tree / editor / preview) + autosave + compile loop — acceptance: edit triggers preview update; download PDF works (covers: S2)
- [ ] T5: Tests for path safety and compile diagnostics — acceptance: `npm test` passes (covers: S2; depends: T2, T3)
