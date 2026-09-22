import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  syntaxHighlighting,
  defaultHighlightStyle,
  StreamLanguage,
  bracketMatching,
} from "@codemirror/language";

/** Minimal Typst markup highlighter */
const typstHighlighting = syntaxHighlighting(defaultHighlightStyle);
const typst = StreamLanguage.define({
  name: "typst",
  startState: () => ({ inCode: false, inHash: false }),
  token(stream) {
    if (stream.sol()) {
      // markers
    }
    if (stream.match(/^\/\/\/.*/)) return "comment";
    if (stream.match(/^\/\/.*/)) return "comment";
    if (stream.match(/^\/\*[\s\S]*?\*\//)) return "comment";
    if (stream.match(/^`[^`]*`/)) return "string";
    if (stream.match(/^```.*/)) return "string";
    if (stream.match(/^#.*/)) return "keyword";
    if (stream.match(/^[A-Za-z_][\w.-]*/)) return "variableName";
    if (stream.match(/^[0-9]+(\.[0-9]+)?(pt|em|in|cm|mm|%)?/)) return "number";
    if (stream.match(/^[\$=+\-*/<>!&|]+/)) return "operator";
    if (stream.match(/^[{}[\]()]/)) return "bracket";
    if (stream.match(/^"([^"\\]|\\.)*"/)) return "string";
    stream.next();
    return null;
  },
});

const languageConf = new Compartment();

const state = {
  path: null,
  content: "",
  dirty: false,
  saving: false,
  loading: false,
  zoom: 1,
  saveTimer: null,
  compileTimer: null,
  pdfDoc: null,
};

const el = {
  tree: document.getElementById("file-tree"),
  editor: document.getElementById("editor"),
  activeFile: document.getElementById("active-file"),
  saveState: document.getElementById("save-state"),
  status: document.getElementById("status"),
  diagnostics: document.getElementById("diagnostics"),
  preview: document.getElementById("preview"),
  previewEmpty: document.getElementById("preview-empty"),
  pdfContainer: document.getElementById("pdf-container"),
  zoomLabel: document.getElementById("zoom-label"),
  rootInput: document.getElementById("root-input"),
  openError: document.getElementById("open-error"),
};

function setStatus(text, cls = "") {
  el.status.textContent = text;
  el.status.className = `status ${cls}`.trim();
}

function api(pathname, opts = {}) {
  return fetch(pathname, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  }).then(async (res) => {
    const ct = res.headers.get("content-type") || "";
    const body = ct.includes("application/json") ? await res.json() : await res.blob();
    if (!res.ok) {
      const msg = body?.error || res.statusText;
      throw new Error(msg);
    }
    return body;
  });
}

const view = new EditorView({
  parent: el.editor,
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      highlightSelectionMatches(),
      bracketMatching(),
      languageConf.of(typst),
      typstHighlighting,
      keymap.of([
        ...defaultKeymap,
        ...historyKeymap,
        ...searchKeymap,
        indentWithTab,
        {
          key: "Mod-s",
          preventDefault: true,
          run: () => {
            saveNow(true);
            return true;
          },
        },
        {
          key: "Mod-Enter",
          preventDefault: true,
          run: () => {
            compileNow();
            return true;
          },
        },
      ]),
      EditorView.updateListener.of((u) => {
        if (u.docChanged && state.path && !state.loading) {
          state.content = u.state.doc.toString();
          state.dirty = true;
          el.saveState.textContent = "未保存";
          scheduleSave();
          scheduleCompile();
        }
      }),
      EditorView.theme({
        "&": { height: "100%", backgroundColor: "var(--bg)" },
        ".cm-content": { caretColor: "var(--accent)" },
        ".cm-cursor": { borderLeftColor: "var(--accent)" },
        ".cm-selectionBackground": { backgroundColor: "#314056 !important" },
      }),
    ],
  }),
});

function setDoc(text) {
  state.loading = true;
  view.dispatch({
    changes: { from: 0, to: view.state.doc.length, insert: text },
  });
  state.loading = false;
}

function scheduleSave() {
  clearTimeout(state.saveTimer);
  state.saveTimer = setTimeout(() => saveNow(false), 400);
}

function scheduleCompile() {
  clearTimeout(state.compileTimer);
  state.compileTimer = setTimeout(() => compileNow(), 500);
}

async function saveNow(manual) {
  if (!state.path) return;
  clearTimeout(state.saveTimer);
  state.saving = true;
  el.saveState.textContent = "保存中…";
  try {
    const content = view.state.doc.toString();
    await api("/api/file", {
      method: "PUT",
      body: JSON.stringify({ path: state.path, content }),
    });
    state.content = content;
    state.dirty = false;
    el.saveState.textContent = "已保存";
    if (manual) {
      setStatus("已保存", "ok");
      await compileNow();
    }
  } catch (e) {
    el.saveState.textContent = "保存失败";
    setStatus(e.message, "err");
  } finally {
    state.saving = false;
  }
}

async function openFile(rel) {
  if (state.dirty && state.path && state.path !== rel) {
    await saveNow(false);
  }
  try {
    clearTimeout(state.saveTimer);
    const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
    state.path = data.path;
    state.content = data.content;
    state.dirty = false;
    setDoc(data.content);
    el.activeFile.textContent = data.path;
    el.saveState.textContent = "已保存";
    renderTreeActive();
    scheduleCompile();
  } catch (e) {
    setStatus(e.message, "err");
  }
}

function renderTree(nodes, container) {
  container.innerHTML = "";
  for (const node of nodes) {
    const li = document.createElement("li");
    li.className = node.type === "dir" ? "dir" : "file";
    const row = document.createElement("div");
    row.className = "item";
    row.dataset.path = node.path;
    row.textContent = (node.type === "dir" ? "▸ " : "") + node.name;
    row.addEventListener("click", async () => {
      if (node.type === "file") {
        await openFile(node.path);
      } else {
        const sub = li.querySelector("ul");
        if (sub) {
          sub.classList.toggle("hidden");
          row.textContent = (sub.classList.contains("hidden") ? "▸ " : "▾ ") + node.name;
        }
      }
    });
    li.appendChild(row);
    if (node.children) {
      const ul = document.createElement("ul");
      ul.classList.add("hidden");
      renderTree(node.children, ul);
      li.appendChild(ul);
    }
    container.appendChild(li);
  }
}

function renderTreeActive() {
  el.tree.querySelectorAll(".item").forEach((n) => {
    n.classList.toggle("active", n.dataset.path === state.path);
  });
}

async function loadProject() {
  try {
    const data = await api("/api/project");
    el.rootInput.value = data.root;
    state.projectId = data.root;
    el.openError.classList.add("hidden");
    renderTree(data.files, el.tree);
    renderTreeActive();
    if (!state.path) {
      const first = findFirstTyp(data.files);
      if (first) await openFile(first);
    }
  } catch (e) {
    el.openError.textContent = e.message;
    el.openError.classList.remove("hidden");
  }
}

function findFirstTyp(nodes) {
  for (const n of nodes) {
    if (n.type === "file" && n.name.endsWith(".typ")) return n.path;
    if (n.children) {
      const hit = findFirstTyp(n.children);
      if (hit) return hit;
    }
  }
  return null;
}

function renderDiagnostics(diags) {
  el.diagnostics.innerHTML = "";
  for (const d of diags) {
    const li = document.createElement("li");
    li.className = d.severity || "error";
    const loc = d.file
      ? `${d.file}${d.line ? `:${d.line}:${d.col || 1}` : ""} · `
      : "";
    li.textContent = `${loc}${d.message}`;
    if (d.file && d.line) {
      li.addEventListener("click", () => jumpTo(d.file, d.line, d.col || 1));
    }
    el.diagnostics.appendChild(li);
  }
}

async function jumpTo(file, line, col) {
  const normalize = (f) => String(f).replace(/\\/g, "/").replace(/^\.\//, "");
  const candidates = [...new Set([normalize(file), normalize(file).split("/").slice(-2).join("/")])];
  if (!candidates.includes(state.path)) {
    for (const c of candidates) {
      try {
        await openFile(c);
        break;
      } catch {
        /* try next */
      }
    }
  }
  const doc = view.state.doc;
  let pos = 0;
  let ln = 1;
  while (ln < line && pos < doc.length) {
    const next = doc.lineAt(pos).to;
    pos = next + 1;
    ln += 1;
  }
  const lineObj = doc.lineAt(Math.min(pos, doc.length));
  const p = Math.min(lineObj.from + Math.max(0, col - 1), lineObj.to);
  view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
  view.focus();
}

async function compileNow() {
  if (state.dirty) await saveNow(false);
  setStatus("编译中…");
  try {
    const result = await api("/api/compile", {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderDiagnostics(result.diagnostics || []);
    if (result.ok) {
      setStatus(`编译成功 ${result.durationMs}ms`, "ok");
      await loadPdfPreview();
    } else {
      setStatus("编译失败", "err");
      // keep last preview
    }
  } catch (e) {
    setStatus(e.message, "err");
    renderDiagnostics([{ severity: "error", message: e.message }]);
  }
}

async function loadPdfPreview() {
  const url = `/api/pdf?ts=${Date.now()}`;
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/dist/pdf.worker.mjs";
  const doc = await pdfjs.getDocument(url).promise;
  state.pdfDoc = doc;
  el.previewEmpty.classList.add("hidden");
  el.pdfContainer.innerHTML = "";
  const scale = state.zoom;
  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = viewport.width;
    canvas.height = viewport.height;
    const ctx = canvas.getContext("2d");
    await page.render({ canvasContext: ctx, viewport }).promise;
    el.pdfContainer.appendChild(canvas);
  }
}

async function exportAs(format) {
  setStatus(`导出 ${format.toUpperCase()}…`);
  try {
    const res = await fetch(`/api/export?format=${format}&ts=${Date.now()}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || j.diagnostics?.[0]?.message || res.statusText);
    }
    const blob = await res.blob();
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    const cd = res.headers.get("Content-Disposition") || "";
    const m = cd.match(/filename="([^"]+)"/);
    a.download = m ? m[1] : `document.${format}`;
    a.click();
    URL.revokeObjectURL(a.href);
    setStatus("已导出", "ok");
  } catch (e) {
    setStatus(e.message, "err");
  }
}

function setZoom(z) {
  state.zoom = Math.min(2, Math.max(0.5, z));
  el.zoomLabel.textContent = `${Math.round(state.zoom * 100)}%`;
  if (state.pdfDoc) loadPdfPreview();
}

document.getElementById("open-btn").addEventListener("click", async () => {
  const path = el.rootInput.value.trim();
  if (!path) return;
  state.path = null;
  state.dirty = false;
  await api("/api/project/open", {
    method: "POST",
    body: JSON.stringify({ path }),
  }).catch((e) => setStatus(e.message, "err"));
  await loadProject();
  setStatus("已打开项目", "ok");
  await compileNow();
});

document.getElementById("refresh-btn").addEventListener("click", () => loadProject());
document.getElementById("compile-btn").addEventListener("click", () => compileNow());
document.getElementById("save-btn").addEventListener("click", () => saveNow(true));
document.getElementById("export-pdf").addEventListener("click", () => exportAs("pdf"));
document.getElementById("export-svg").addEventListener("click", () => exportAs("svg"));
document.getElementById("export-png").addEventListener("click", () => exportAs("png"));
document.getElementById("zoom-in").addEventListener("click", () => setZoom(state.zoom + 0.1));
document.getElementById("zoom-out").addEventListener("click", () => setZoom(state.zoom - 0.1));
document.getElementById("new-file-btn").addEventListener("click", async () => {
  const name = prompt("新文件相对路径（如 chapter.typ）");
  if (!name) return;
  try {
    await api("/api/file/create", {
      method: "POST",
      body: JSON.stringify({ path: name, content: "" }),
    });
    await loadProject();
    await openFile(name);
  } catch (e) {
    setStatus(e.message, "err");
  }
});

window.addEventListener("beforeunload", (e) => {
  if (state.dirty) {
    e.preventDefault();
    e.returnValue = "";
  }
});

async function boot() {
  const health = await api("/api/health").catch(() => null);
  if (!health?.ok) {
    el.openError.textContent = "未找到 typst CLI，请安装或设置 TYPST_BIN";
    el.openError.classList.remove("hidden");
  }
  await loadProject();
  await compileNow();
}

boot();
