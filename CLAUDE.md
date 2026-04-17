# SiteShrimp — Project Context for Claude

Phone-first construction site-defect PWA (TWA on Google Play). Free, open features; closed-source; targets SMEs. Primary frontend: `js/app.js` (single React file, babel-compiled to `js/app.compiled.js`). Backend: PocketBase on a GCP VM (hostname `sitesnag`, public API `api.siteshrimp.org`). Frontend deployed via GitHub Pages on push to `main`; behind Cloudflare DNS.

## Module map (use exact names in code, comments, and UI copy)

- **LOG** — capture a new defect entry (photo + optional voice + form).
- **TAG** — in-app drawing viewer / markup / pin placement. `DrawingsPanel` in `js/app.js`. Sub-features: drawing upload, map snapshot, compare two PDFs.
- **REVIEW** — three sub-tabs (source toggles):
  - **ENTRIES** — defect list with filters, AI search, and a consolidated MAP view of GPS-pinned entries (`DefectsMapView`).
  - **DRAWINGS** — per-drawing card list showing pin/markup counts. Tapping a card opens the drawing in TAG.
  - **COMPARISONS** — saved PDF-diffs.
- **REPORT** — export CSV / PDF / email / Google Sheets, plus Contract Advisor.
- **Settings** — profile, storage & hosting, i18n, AI config, Telegram, help.
- **Offline queue** — IndexedDB writes that replay on reconnect via service worker (`sw.js`).

## Canonical UX rules (do not change without explicit instruction)

- **Say "23 languages"** in all user-facing strings — English plus 22 translated. Never bare "22".
- **Phone-first** — test at 360 px width; thumb zones on the right-side one-handed grip; no hover-only interactions.
- **Verbatim terminology** — BCA/HDB/CONQUAS defect wording is contractual. Never paraphrase.
- **No third-party prices** quoted in-app. Say "paid tier, at your own cost" instead of "$5/mo".
- **No GitHub prompts** for users — don't ask them to verify/ensure GitHub accounts.
- **Don't quote `$` prices**  for hosts — say "paid tier, at your own cost".

## Mandatory workflow rules

- **After editing `js/app.js`:** always run `npm run build` (compiles → `js/app.compiled.js` AND bumps cache version in `index.html`). Deploy is broken otherwise.
- **After adding/changing UI strings:** add to `lang/en.json`, then `npm run translate` (fans out to 22 languages via Google Translate API).
- **After every build:** verify `grep "v=" index.html` shows the new hash.
- **Never commit the self-host setup guide** — `deploy/pocketbase/SELFHOST_SETUP_GUIDE.md` is gitignored (internal / supports paid setup service).
- **Never commit the `planning/` folder** — gitignored, ephemeral working state.

## Deploy topology

- Frontend: `siteshrimp.org` → GitHub Pages (auto-deploys on push to `main` via `.github/workflows/deploy.yml`) → Cloudflare proxy.
- Backend API: `api.siteshrimp.org` → Cloudflare DNS-only (grey cloud) → Caddy on GCP VM (port 443/80) → PocketBase on localhost:8090.
- File storage: Cloudflare R2 (S3-compatible) — configured in PocketBase Admin → Settings → Files storage. Force path-style ON.
- Cost protection: $5 GCP budget → Pub/Sub topic `siteshrimp-budget-alerts` → Cloud Function `stopVM` → automatic VM stop. Static IP `34.124.226.122` (so restarts don't break DNS).

## Where to look, by concern

| Concern | Primary file/path |
|---|---|
| UI rendering, React components | `js/app.js` (edit ONLY this — never `js/app.compiled.js`) |
| PocketBase client / offline queue | `js/db.js` |
| i18n strings | `lang/en.json` → `npm run translate` fans out to 22 others |
| Inline EN dictionary (fallback if network fails) | `js/lang.js` (auto-synced from `en.json` by build) |
| PocketBase hooks (server-side JS) | `deploy/pocketbase/pb_hooks/main.pb.js` |
| PocketBase schema | `deploy/pocketbase/pb_schema.json` |
| Service worker | `sw.js` |
| Self-host operations playbook | `deploy/pocketbase/SELFHOST_SETUP_GUIDE.md` (gitignored) |
| Current session's planning doc | `planning/0417_UIUX_improvements.md` (gitignored) |
| Telegram bridge bot | `bot/telegram-bridge.js` |

## Skills available (project-specific)

The `.claude/skills/` folder has domain-specific skills. Invoke via the Skill tool when relevant — do NOT guess.

- `construction-defects` — BCA/HDB/CONQUAS labelling and checklist generation.
- `site-safety` — WSH / MOM / active-site hazard labelling.
- `mobile-first-ux` — phone-zone, glove, sunlight design rules.
- `offline-sync` — service worker + IndexedDB queue traps.
- `site-drawings` — construction markup conventions, PDF quirks.
- `pocketbase-schema` — non-obvious rules around collections, hooks, API rules.
- `construction-ai-prompts` — the AI photo/search/contract prompt rules (live in `pb_hooks/main.pb.js`).
- `i18n-workflow` — translation pipeline rules to prevent contractual mistakes.
- `report-templates` — legal/licensing rules and section conventions for exports.
- `telegram-notifications` — two-bot architecture (SiteShrimp writes, OpenClaw reads).

## Auto-memory

`~/.claude/projects/c--2026-SiteShrimp/memory/` persists across sessions:
- User role, preferences, feedback on past work.
- Project-level facts (VM details, ongoing initiatives, open decisions).
- External-system pointers (Linear project, Grafana dashboards, Telegram bots).

Never duplicate that content here. Consult it for session-specific context.

## Things I should NOT do unsolicited

- Commit code without the user's "please commit" / "proceed".
- Push to origin — always a separate explicit step.
- Create `.md` planning docs, architecture docs, or design docs unless the user asks.
- Upgrade dependencies, rename modules, or refactor for "cleanliness". Ship only what was asked.
- Add comments explaining WHAT code does — only WHY when non-obvious.
- Add emoji to files — user didn't ask.
