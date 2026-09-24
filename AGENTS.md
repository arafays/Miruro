# AGENTS.md

React 18 + Vite 5 SPA (anime streaming) with Bun as the primary package runner.
Deploys three ways: Vercel (static + `api/`), Cloudflare Pages (`functions/`), or
self-hosted Express (`server/`). Single package — no monorepo/workspace.

## Commands

```bash
bun install                 # deps (npm works too; all lockfiles are gitignored)
cp .env.example .env.local  # required before dev/build; VITE_BACKEND_URL is NOT optional
bun run dev                 # vite --host; port from VITE_PORT (default 5173), auto-opens browser
bun run build               # vite build → dist/ (this is the only green verification gate)
bun start                   # vite build && bun run ./server/server.ts (serves dist/ on VITE_PORT)
bun run lint                # eslint, --max-warnings 0
bun run format              # prettier --write . (rewrites the WHOLE repo)
```

- **No test suite exists.** Don't look for one; don't add test-runner config unless asked.
- **No `typecheck` script.** `bunx tsc --noEmit` reports 14 pre-existing errors (strict +
  `noUnusedLocals`), so treat it as informational. `tsconfig.json` only includes `src/` and
  `api/` — `server/` and `functions/` are not type-checked at all (`vite.config.ts` is
  covered by `tsconfig.node.json`).
- **`bun run lint` currently fails** (~25 pre-existing errors, 20 warnings; `--max-warnings 0`
  makes warnings fatal). These are not your regressions — only fix lint errors in files you
  touched.
- **Prefer targeted `bunx prettier --write <file>` over `bun run format`** — the latter also
  reformats ~5 currently-unformatted files unrelated to your change, creating diff noise.
- There is no CI (`.github/` has only dependabot/SECURITY/FUNDING) and no pre-commit hooks.
  Verification order when changing code: touch-up `lint` on changed files → `bun run build`.

## Architecture

- Entry: `index.html` → `src/main.tsx` → `src/App.tsx` (react-router routes defined there).
- **`src/index.ts` is a central barrel** that re-exports components/hooks/pages, and `App.tsx`
  plus several pages/hooks import *from the barrel*, not from source files. New shared exports
  must be added there or importers won't see them. Beware filename typo `src/hooks/useTIme.ts`
  (capital I) — imports must match case exactly.
- **The AniList OAuth token-exchange endpoint exists in three parallel implementations** that
  must be kept in sync:
  - `api/exchange-token.ts` — Vercel serverless (`POST /api/exchange-token`)
  - `functions/exchange-token.js` — Cloudflare Pages Function (`POST /exchange-token`, plain JS)
  - `server/server.ts` — Express route (`POST /api/exchange-token`)
  `src/pages/Callback.tsx` picks the URL via `import.meta.env.VITE_DEPLOY_PLATFORM`
  (`'VERCEL'` → `/api/exchange-token`, anything else → `/exchange-token`).
- **Styling is mixed**: styled-components *plus* plain CSS loaded directly from
  `index.html` (`src/styles/globals.css`, `animations.css`, `themes.css`). Dark mode is a
  `.dark-mode` class on `<html>` set both by an inline script in `index.html` (pre-paint) and
  `src/components/ThemeContext.tsx` — keep both in sync when touching theming.
- **All env vars are `VITE_`-prefixed and therefore inlined into the client bundle** —
  including `VITE_CLIENT_SECRET` read in `src/client/authService.ts`. Never introduce
  server-only secrets under a `VITE_` name. `vite.config.ts` merges `loadEnv()` into
  `process.env`; the Express server reads the same vars when run under Bun.
- `src/hooks/useApi.ts` builds the backend axios client from `VITE_BACKEND_URL` (required),
  `VITE_PROXY_URL`, `VITE_API_KEY`, `VITE_SKIP_TIMES`.

## Constraints

- License is custom BY-NC (see `LICENSE` / README): non-commercial use only, attribution
  required. Don't strip license headers or relicense.
- `vercel.json` rewrites all paths to `/` (SPA fallback); new Vercel API routes live in `api/`.
- `wrangler` is a dependency (Cloudflare deploys); `functions/` uses the Pages Functions
  `onRequest` format — no npm imports there, plain JS only.
