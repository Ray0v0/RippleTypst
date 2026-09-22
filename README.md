# MyTypst

Lightweight local Typst editor (inspired by typst.app/play).

## Quick start

```bash
npm install
npm start
# open http://127.0.0.1:8787
```

Open a project directory in the UI, or:

```bash
node server/index.js --root /path/to/your/typst-project
```

Requires the `typst` CLI on PATH (override with `TYPST_BIN`).

## Scripts

- `npm start` — run server
- `npm run build` — bundle frontend
- `npm test` — server tests
