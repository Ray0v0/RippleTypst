import { EditorView, basicSetup } from "codemirror";
import { EditorState, Compartment } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import { defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import { searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import {
  defaultHighlightStyle,
  StreamLanguage,
  bracketMatching,
  HighlightStyle,
  syntaxHighlighting,
} from "@codemirror/language";
import { tags as t } from "@lezer/highlight";

/* ── Theme ─────────────────────────────────────────── */

const state = {
  path: null,
  content: "",
  dirty: false,
  saving: false,
  loading: false,
  zoom: 1,
  saveTimer: null,
  compileTimer: null,
  caretTimer: null,
  pdfDoc: null,
  compiling: false,
  sync: {
    lineToPage: [],
    pageToLine: [],
    pageStartLine: [],
    pageEndLine: [],
    pageEls: [],
    activeToExpanded: [],
    ready: false,
  },
  syncing: false,
  userScrolledPreviewAt: 0,
  userScrolledEditorAt: 0,
};

const el = {
  tree: document.getElementById("file-tree"),
  editor: document.getElementById("editor"),
  activeFile: document.getElementById("active-file"),
  saveState: document.getElementById("save-state"),
  status: document.getElementById("status"),
  diagnostics: document.getElementById("diagnostics"),
  diagCount: document.getElementById("diag-count"),
  preview: document.getElementById("preview"),
  previewEmpty: document.getElementById("preview-empty"),
  pdfContainer: document.getElementById("pdf-container"),
  zoomLabel: document.getElementById("zoom-label"),
  rootInput: document.getElementById("root-input"),
  openError: document.getElementById("open-error"),
  themeBtn: document.getElementById("theme-btn"),
};

function setStatus(text, cls = "") {
  // Fixed 8px dot only — never reflows the topbar. Detail in title tooltip.
  el.status.title = text || "";
  el.status.textContent = "";
  const busy = /编译中|保存中|导出/.test(text || "");
  const kind = cls === "err" ? "err" : cls === "ok" ? "ok" : busy ? "busy" : "";
  el.status.className = `status-dot ${kind}`.trim();
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

/* ── CodeMirror language + high-contrast highlight ── */

const typst = StreamLanguage.define({
  name: "typst",
  startState: () => ({}),
  token(stream) {
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
const themeConf = new Compartment();

function highlightFor(dark) {
  if (dark) {
    return HighlightStyle.define([
      { tag: t.comment, color: "#8b98a8", fontStyle: "italic" },
      { tag: t.keyword, color: "#7cb8f5", fontWeight: "600" },
      { tag: t.string, color: "#8fd6a8" },
      { tag: t.number, color: "#e0b06a" },
      { tag: t.variableName, color: "#e8eef6" },
      { tag: t.operator, color: "#a8b4c2" },
      { tag: t.bracket, color: "#a8b4c2" },
      { tag: t.bool, color: "#e0b06a" },
      { tag: t.null, color: "#e0b06a" },
    ]);
  }
  return HighlightStyle.define([
    { tag: t.comment, color: "#6b7887", fontStyle: "italic" },
    { tag: t.keyword, color: "#0b6dca", fontWeight: "600" },
    { tag: t.string, color: "#0f7a4a" },
    { tag: t.number, color: "#9a5b00" },
    { tag: t.variableName, color: "#1a2330" },
    { tag: t.operator, color: "#5c6b7a" },
    { tag: t.bracket, color: "#5c6b7a" },
    { tag: t.bool, color: "#9a5b00" },
    { tag: t.null, color: "#9a5b00" },
  ]);
}

function isDark() {
  return document.documentElement.getAttribute("data-theme") !== "light";
}

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  try {
    localStorage.setItem("ripple-typst-theme", theme);
  } catch {
    /* ignore */
  }
  if (el.themeBtn) {
    el.themeBtn.textContent = theme === "dark" ? "浅色" : "深色";
    el.themeBtn.title = theme === "dark" ? "切换到浅色" : "切换到深色";
  }
  if (typeof view !== "undefined") {
    view.dispatch({
      effects: themeConf.reconfigure(syntaxHighlighting(highlightFor(theme === "dark"))),
    });
  }
}

/* ── Sync maps (text match + mass fill) ───────────── */

function tokenize(text) {
  const s = String(text || "").toLowerCase();
  const out = [];
  const wordRe = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = wordRe.exec(s))) {
    if (m[0].length >= 2) out.push(m[0]);
  }
  const cjkSegs = s.match(/[\p{Script=Han}]{2,}/gu) || [];
  for (const seg of cjkSegs) {
    for (let i = 0; i + 2 <= seg.length; i += 1) out.push(seg.slice(i, i + 2));
  }
  return out;
}

function plainLine(line) {
  let s = String(line || "").replace(/\/\/.*/, "");
  s = s.replace(/#[a-zA-Z_][\w.-]*/g, " ");
  s = s.replace(/[#$=+\-*/<>!&|()[\]{}`]/g, " ");
  return tokenize(s);
}

function buildSyncMaps(source, pageTexts) {
  const lines = source.split("\n");
  const nLines = lines.length;
  const nPages = pageTexts.length;
  const lineTokens = lines.map(plainLine);
  const pageTokens = pageTexts.map((tok) => new Set(tokenize(tok)));
  const lineMass = lineTokens.map((toks) => 1 + toks.length * 3);
  const pageMass = pageTexts.map((tok) => Math.max(1, tokenize(tok).length));
  const lineToPage = new Array(nLines).fill(-1);

  function scoreWindow(lineIdx) {
    const window = new Set();
    for (let i = Math.max(0, lineIdx - 1); i <= Math.min(nLines - 1, lineIdx + 2); i += 1) {
      for (const tok of lineTokens[i]) window.add(tok);
    }
    if (!window.size) return new Array(nPages).fill(0);
    return pageTokens.map((set) => {
      let hit = 0;
      for (const tok of window) if (set.has(tok)) hit += 1;
      return hit / window.size;
    });
  }

  for (let i = 0; i < nLines; i += 1) {
    if (!lineTokens[i].length) continue;
    const scores = scoreWindow(i);
    let best = 0;
    let bestIdx = 0;
    for (let p = 0; p < nPages; p += 1) {
      if (scores[p] > best) {
        best = scores[p];
        bestIdx = p;
      }
    }
    if (best >= 0.2) lineToPage[i] = bestIdx + 1;
  }

  const lineCum = [0];
  for (let i = 0; i < nLines; i += 1) lineCum.push(lineCum[i] + lineMass[i]);
  const totalLineMass = Math.max(1, lineCum[nLines]);
  const pageCum = [0];
  for (let p = 0; p < nPages; p += 1) pageCum.push(pageCum[p] + pageMass[p]);
  const totalPageMass = Math.max(1, pageCum[nPages]);

  for (let i = 0; i < nLines; i += 1) {
    if (lineToPage[i] >= 0) continue;
    const mid = (lineCum[i] + lineCum[i + 1]) / 2;
    const target = (mid / totalLineMass) * totalPageMass;
    let page = nPages || 1;
    for (let p = 0; p < nPages; p += 1) {
      if (target <= pageCum[p + 1]) {
        page = p + 1;
        break;
      }
    }
    lineToPage[i] = page;
  }

  for (let i = 1; i < nLines; i += 1) {
    if (lineToPage[i] < lineToPage[i - 1]) lineToPage[i] = lineToPage[i - 1];
  }

  const pageStartLine = new Array(nPages).fill(0);
  const pageEndLine = new Array(nPages).fill(Math.max(0, nLines - 1));
  const seen = new Array(nPages).fill(false);
  for (let i = 0; i < nLines; i += 1) {
    const p = lineToPage[i] - 1;
    if (p >= 0 && p < nPages) {
      if (!seen[p]) {
        pageStartLine[p] = i;
        seen[p] = true;
      }
      pageEndLine[p] = i;
    }
  }
  let acc = 0;
  for (let p = 0; p < nPages; p += 1) {
    if (!seen[p]) {
      const span = Math.max(1, Math.round((pageMass[p] / totalPageMass) * nLines));
      pageStartLine[p] = acc;
      pageEndLine[p] = Math.min(nLines - 1, acc + span - 1);
    }
    acc = Math.max(acc, pageEndLine[p] + 1);
  }
  for (let p = 0; p < nPages - 1; p += 1) {
    if (pageEndLine[p] < pageStartLine[p]) pageEndLine[p] = pageStartLine[p];
    if (pageStartLine[p + 1] <= pageEndLine[p]) pageStartLine[p + 1] = pageEndLine[p] + 1;
  }
  if (nPages > 0) {
    pageStartLine[0] = 0;
    pageEndLine[nPages - 1] = Math.max(pageEndLine[nPages - 1], nLines - 1);
  }

  return {
    lineToPage,
    pageToLine: pageStartLine.slice(),
    pageStartLine,
    pageEndLine,
    ready: nPages > 0 && nLines > 0,
  };
}

async function expandSourceForMap(source, seen = new Set()) {
  const out = [];
  for (const line of source.split("\n")) {
    const m = line.match(/^\s*#include\s+"([^"]+)"\s*$/);
    if (!m) {
      out.push(line);
      continue;
    }
    const rel = m[1];
    if (seen.has(rel)) {
      out.push(line);
      continue;
    }
    seen.add(rel);
    try {
      const data = await api(`/api/file?path=${encodeURIComponent(rel)}`);
      out.push(line);
      out.push(...(await expandSourceForMap(data.content, seen)));
    } catch {
      out.push(line);
    }
  }
  return out;
}

function mapActiveToExpanded(source, expanded) {
  const sLines = source.split("\n");
  const eLines = expanded.split("\n");
  const map = new Array(sLines.length);
  let e = 0;
  for (let i = 0; i < sLines.length; i += 1) {
    while (e < eLines.length && eLines[e] !== sLines[i]) e += 1;
    if (e < eLines.length) {
      map[i] = e;
      e += 1;
    } else {
      map[i] = i;
    }
  }
  return map;
}

function activeLineToExpanded(lineIdx) {
  const map = state.sync.activeToExpanded;
  if (!map?.length) return lineIdx;
  return map[Math.max(0, Math.min(map.length - 1, lineIdx))];
}

function caretLineIndex() {
  return view.state.doc.lineAt(view.state.selection.main.head).number - 1;
}

function firstVisibleLineIndex() {
  const scroller = view.scrollDOM;
  const rect = scroller.getBoundingClientRect();
  const pos = view.posAtCoords({ x: rect.left + 24, y: rect.top + 4 });
  if (pos != null) return view.state.doc.lineAt(pos).number - 1;
  const total = scroller.scrollHeight - scroller.clientHeight;
  const frac = total <= 0 ? 0 : scroller.scrollTop / total;
  return Math.max(0, Math.min(view.state.doc.lines - 1, Math.floor(frac * (view.state.doc.lines - 1))));
}

function lineToFracInPage(lineIdx) {
  const s = state.sync;
  if (!s.ready) return { page: 1, frac: 0 };
  const expandedLine = activeLineToExpanded(lineIdx);
  const page = s.lineToPage[expandedLine] || 1;
  const p = Math.max(0, Math.min(s.pageStartLine.length - 1, page - 1));
  const start = s.pageStartLine[p] ?? 0;
  const end = s.pageEndLine[p] ?? start;
  const span = Math.max(1, end - start);
  return { page: p + 1, frac: Math.max(0, Math.min(1, (expandedLine - start) / span)) };
}

function pageFracToLine(page, frac) {
  const s = state.sync;
  if (!s.ready) return 0;
  const p = Math.max(0, Math.min(s.pageStartLine.length - 1, page - 1));
  const start = s.pageStartLine[p] ?? 0;
  const end = s.pageEndLine[p] ?? start;
  const span = Math.max(1, end - start);
  const expandedLine = Math.round(start + frac * span);
  const map = s.activeToExpanded || [];
  if (!map.length) return Math.max(0, Math.min(view.state.doc.lines - 1, expandedLine));
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < map.length; i += 1) {
    const d = Math.abs(map[i] - expandedLine);
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

function syncPreviewFromEditorLine(lineIdx, behavior = "auto") {
  if (state.syncing || !state.sync.ready) return;
  state.syncing = true;
  try {
    const { page, frac } = lineToFracInPage(lineIdx);
    const wrap = state.sync.pageEls[page - 1];
    if (!wrap) return;
    const top = wrap.offsetTop + wrap.offsetHeight * frac - el.preview.clientHeight * 0.25;
    el.preview.scrollTo({ top: Math.max(0, top), behavior });
  } finally {
    setTimeout(() => {
      state.syncing = false;
    }, 80);
  }
}

function syncEditorFromPreview() {
  if (state.syncing || !state.sync.ready) return;
  state.syncing = true;
  try {
    const preview = el.preview;
    const focusY = preview.scrollTop + preview.clientHeight * 0.25;
    let page = 1;
    let frac = 0;
    for (let i = 0; i < state.sync.pageEls.length; i += 1) {
      const wrap = state.sync.pageEls[i];
      const top = wrap.offsetTop;
      const bottom = top + wrap.offsetHeight;
      if (focusY < bottom || i === state.sync.pageEls.length - 1) {
        page = i + 1;
        frac = Math.max(0, Math.min(1, (focusY - top) / Math.max(1, wrap.offsetHeight)));
        break;
      }
    }
    const lineIdx = pageFracToLine(page, frac);
    const line = view.state.doc.line(lineIdx + 1);
    const coords = view.coordsAtPos(line.from);
    const scroller = view.scrollDOM;
    if (coords) {
      const target =
        scroller.scrollTop +
        (coords.top - scroller.getBoundingClientRect().top) -
        scroller.clientHeight * 0.25;
      scroller.scrollTo({ top: Math.max(0, target), behavior: "auto" });
    }
  } finally {
    setTimeout(() => {
      state.syncing = false;
    }, 80);
  }
}

function scheduleCaretSync() {
  clearTimeout(state.caretTimer);
  state.caretTimer = setTimeout(() => {
    // Only follow caret when user isn't actively scrolling the preview
    if (Date.now() - state.userScrolledPreviewAt < 400) return;
    syncPreviewFromEditorLine(caretLineIndex(), "auto");
  }, 120);
}

/* ── Editor ───────────────────────────────────────── */

const view = new EditorView({
  parent: el.editor,
  state: EditorState.create({
    doc: "",
    extensions: [
      basicSetup,
      EditorView.lineWrapping,
      highlightSelectionMatches(),
      bracketMatching(),
      languageConf.of(typst),
      themeConf.of(syntaxHighlighting(highlightFor(false))),
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
        // Caret/selection: follow preview, but not during compile rebuilds
        if (u.selectionSet && !state.loading && !state.compiling) {
          scheduleCaretSync();
        }
      }),
      EditorView.theme({
        "&": { height: "100%" },
      }),
    ],
  }),
});

view.scrollDOM.addEventListener(
  "scroll",
  () => {
    state.userScrolledEditorAt = Date.now();
    if (state.syncing) return;
    clearTimeout(state.caretTimer);
    state.caretTimer = setTimeout(() => {
      if (state.compiling) return;
      syncPreviewFromEditorLine(firstVisibleLineIndex(), "auto");
    }, 50);
  },
  { passive: true },
);

el.preview.addEventListener(
  "scroll",
  () => {
    state.userScrolledPreviewAt = Date.now();
    if (state.syncing) return;
    clearTimeout(state.caretTimer);
    state.caretTimer = setTimeout(() => {
      if (state.compiling) return;
      syncEditorFromPreview();
    }, 50);
  },
  { passive: true },
);

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
  if (state.dirty && state.path && state.path !== rel) await saveNow(false);
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
      if (node.type === "file") await openFile(node.path);
      else {
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
  el.diagCount.textContent = diags.length ? String(diags.length) : "";
  const wrap = document.querySelector(".diagnostics-wrap");
  if (wrap) wrap.classList.toggle("is-empty", !diags.length);
  for (const d of diags) {
    const li = document.createElement("li");
    li.className = d.severity || "error";
    const loc = d.file ? `${d.file}${d.line ? `:${d.line}:${d.col || 1}` : ""} · ` : "";
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
  const ln = Math.max(1, Math.min(doc.lines, line));
  const lineObj = doc.line(ln);
  const p = Math.min(lineObj.from + Math.max(0, (col || 1) - 1), lineObj.to);
  view.dispatch({ selection: { anchor: p }, scrollIntoView: true });
  view.focus();
  syncPreviewFromEditorLine(ln - 1, "smooth");
}

async function compileNow() {
  if (state.compiling) return;
  if (state.dirty) await saveNow(false);
  state.compiling = true;
  setStatus("编译中…");
  try {
    const result = await api("/api/compile", {
      method: "POST",
      body: JSON.stringify({}),
    });
    renderDiagnostics(result.diagnostics || []);
    if (result.ok) {
      setStatus(`编译成功 ${result.durationMs}ms`, "ok");
      await loadPdfPreview({ preserveScroll: true });
    } else {
      setStatus("编译失败", "err");
    }
  } catch (e) {
    setStatus(e.message, "err");
    renderDiagnostics([{ severity: "error", message: e.message }]);
  } finally {
    state.compiling = false;
  }
}

/* ── PDF preview: atomic swap, no flicker, keep scroll ── */

function capturePreviewAnchor() {
  const preview = el.preview;
  const focusY = preview.scrollTop + preview.clientHeight * 0.25;
  let page = 1;
  let frac = 0;
  for (let i = 0; i < state.sync.pageEls.length; i += 1) {
    const wrap = state.sync.pageEls[i];
    if (!wrap) continue;
    const top = wrap.offsetTop;
    const bottom = top + wrap.offsetHeight;
    if (focusY < bottom || i === state.sync.pageEls.length - 1) {
      page = i + 1;
      frac = Math.max(0, Math.min(1, (focusY - top) / Math.max(1, wrap.offsetHeight)));
      break;
    }
  }
  return { page, frac, scrollTop: preview.scrollTop, ratio: 0 };
}

function restorePreviewAnchor(anchor) {
  const wrap = state.sync.pageEls[anchor.page - 1];
  if (!wrap) {
    el.preview.scrollTop = anchor.scrollTop;
    return;
  }
  const top = wrap.offsetTop + wrap.offsetHeight * anchor.frac - el.preview.clientHeight * 0.25;
  el.preview.scrollTop = Math.max(0, top);
}

async function loadPdfPreview(opts = {}) {
  const preserveScroll = opts.preserveScroll !== false;
  const anchor = preserveScroll ? capturePreviewAnchor() : null;
  const url = `/api/pdf?ts=${Date.now()}`;
  const pdfjs = await import("pdfjs-dist");
  pdfjs.GlobalWorkerOptions.workerSrc = "/dist/pdf.worker.mjs";
  const doc = await pdfjs.getDocument(url).promise;
  state.pdfDoc = doc;
  el.previewEmpty.classList.add("hidden");

  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const maxCssW = Math.max(200, Math.min(420, (el.preview.clientWidth || 480) - 48)) * state.zoom;
  const maxCssH = Math.max(240, Math.min((el.preview.clientHeight || 600) - 48, 720)) * state.zoom;

  // Render into a detached fragment first — no intermediate empty flash
  const frag = document.createDocumentFragment();
  const pageEls = [];
  const pageTexts = [];

  for (let i = 1; i <= doc.numPages; i += 1) {
    const page = await doc.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const cssScale = Math.min(maxCssW / base.width, maxCssH / base.height);
    const scale = cssScale * dpr;
    const viewport = page.getViewport({ scale });
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(viewport.width));
    canvas.height = Math.max(1, Math.floor(viewport.height));
    canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
    canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
    canvas.dataset.page = String(i);
    await page.render({ canvasContext: canvas.getContext("2d"), viewport }).promise;

    const wrap = document.createElement("div");
    wrap.className = "page-wrap";
    wrap.dataset.page = String(i);
    const label = document.createElement("div");
    label.className = "page-label";
    label.textContent = `${i} / ${doc.numPages}`;
    wrap.appendChild(canvas);
    wrap.appendChild(label);
    frag.appendChild(wrap);
    pageEls.push(wrap);

    try {
      const tc = await page.getTextContent();
      pageTexts.push(tc.items.map((it) => ("str" in it ? it.str : "")).join(" "));
    } catch {
      pageTexts.push("");
    }

    canvas.addEventListener("click", (ev) => {
      const rect = canvas.getBoundingClientRect();
      const frac = Math.max(0, Math.min(1, (ev.clientY - rect.top) / rect.height));
      const lineIdx = pageFracToLine(i, frac);
      const line = view.state.doc.line(lineIdx + 1);
      view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
      view.focus();
    });
  }

  // Atomic swap
  el.pdfContainer.replaceChildren(frag);

  const source = view.state.doc.toString();
  const expanded = (await expandSourceForMap(source)).join("\n");
  const maps = buildSyncMaps(expanded, pageTexts);
  state.sync = {
    ...maps,
    pageEls,
    activeToExpanded: mapActiveToExpanded(source, expanded),
  };

  // Restore scroll position instead of jumping to caret
  if (anchor) restorePreviewAnchor(anchor);
  else syncPreviewFromEditorLine(caretLineIndex(), "auto");
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
  if (state.pdfDoc) loadPdfPreview({ preserveScroll: true });
}

document.getElementById("theme-btn")?.addEventListener("click", () => {
  applyTheme(isDark() ? "light" : "dark");
});

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
  applyTheme(isDark() ? "dark" : "light");
  const health = await api("/api/health").catch(() => null);
  if (!health?.ok) {
    el.openError.textContent = "未找到 typst CLI，请安装或设置 TYPST_BIN";
    el.openError.classList.remove("hidden");
  }
  await loadProject();
  await compileNow();
}

boot();
