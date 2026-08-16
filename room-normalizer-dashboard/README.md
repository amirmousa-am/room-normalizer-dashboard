# Room Normalizer Dashboard

Separate hosted React app for the Almosafer hotel room name normalization engine.
See `room-normalizer-dashboard-build-prompt.md` (your original spec) for full context.

## Status

- ✅ **Engine Playground** (`/`) — fully wired: runs `normalizeCore` against the live
  Supabase dictionary, renders the token-by-token "why" explanation, and can write
  golden cases / manual review-queue flags back to Supabase.
- 🚧 Regression Tests, Dictionary Manager, Review Queue, Bulk Translator, Rule Review —
  scaffolded routes with placeholder pages, not yet built. Next up per the build order.

## Engine core

`src/engine/normalizerEngine.js` is a **verbatim logic port** of the `ENGINE CORE`
zone from `room-normalizer-panel.user.js` (v1.8.0). Do not hand-edit parsing behavior
here without mirroring the change in the userscript, or the regression-testing premise
(same engine everywhere) breaks. See the comment block at the top of that file for the
two intentional adapter differences (dict passed as a parameter, collector uses
Supabase JS instead of `GM_xmlhttpRequest`) and a known architectural quirk inherited
from the source (`buildLookup` mutates module-level state — read before touching the
Dictionary Manager's save-blocking flow).

## Local setup

\`\`\`bash
npm install
cp .env.example .env   # fill in VITE_SUPABASE_ANON_KEY
npm run dev
\`\`\`

## Deploy

Push to GitHub, import the repo in Vercel, set `VITE_SUPABASE_URL` and
`VITE_SUPABASE_ANON_KEY` as environment variables in the Vercel project settings.
