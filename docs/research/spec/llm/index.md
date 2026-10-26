# Aholo Viewer — AI-Friendly Documentation

This directory is the machine-readable corpus of the Aholo Viewer docs. 
It is regenerated on every `pnpm build` from the same sources that produce the public website.

## Entry Points

- [Manual](./manual/index.md) — 9 pages
- [API Reference](./api/index.md) — 154 symbols
- [Examples](./examples/index.md) — 7 runnable demos

## Recommended Reading Order

1. `manual/getting-started.md` — install and bootstrap a viewer in minutes.
2. `manual/basic-concepts.md` — mental model for scene, camera, renderer.
3. Browse `api/` and `examples/` on demand.

## Directory Layout

```
llm/
  index.md       # this file
  manual/        # user manual (markdown)
  api/           # API reference (converted from TypeDoc HTML)
  examples/      # runnable examples with TypeScript source
```

