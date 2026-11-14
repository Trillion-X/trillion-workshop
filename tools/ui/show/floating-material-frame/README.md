# floating-material-frame/

Pure browser-local frame for renderer-mounted material.

| Path | Purpose |
|---|---|
| `FloatingMaterialFrame.tsx` | Applies fixed browser placement from caller-provided numeric props, natural inline mounting for parent-owned scroll lanes, or bounded fill mounting for caller-sized material. |
| `index.ts` | Local barrel export. |

Rules:

- No addressed reads, target invokes, owner actions, or package-specific meaning.
- Callers own the material meaning and placement data.
- `mode: "inline"` keeps material in normal document flow with visible overflow. The parent surface owns scrolling.
- `mode: "fill"` fills the caller box and clips overflow for already-bounded material such as canvas-like panes.
- Frame mode does not decide what the material is.
