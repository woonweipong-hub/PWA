# SiteShrimp — Project Context for Claude

SiteShrimp is a phone-first construction site-defect PWA (also packaged as a TWA on Google Play) for SMEs. The product offers free/open user features but the codebase is closed-source.

This file contains only stable, project-wide instructions that should apply in most sessions. If a behavior is ambiguous, changed recently, or appears to conflict with the current request, ask before acting.

## Core stack

- Frontend source of truth: `js/app.js`
- Built frontend artifact: `js/app.compiled.js` (generated; never edit directly)
- PocketBase client / offline queue: `js/db.js`
- Service worker: `sw.js`
- PocketBase hooks: `deploy/pocketbase/pb_hooks/main.pb.js`
- PocketBase schema: `deploy/pocketbase/pb_schema.json`
- i18n source: `lang/en.json`
- Fallback inline dictionary: `js/lang.js`
- Telegram bridge: `bot/telegram-bridge.js`

## Canonical product/module names

Use these exact names in code, tickets, comments, and UI copy.

- **LOG** — capture a new defect entry (photo + optional voice + form)
- **TAG** — drawing viewer, markup, pin placement, map snapshot, compare two PDFs
- **REVIEW**
  - **ENTRIES** — defect list, filters, AI search, consolidated GPS MAP view
  - **DRAWINGS** — per-drawing card list showing pin/markup counts
  - **COMPARISONS** — saved PDF diffs
- **REPORT** — CSV / PDF / email / Google Sheets export, plus Contract Advisor
- **Settings** — profile, storage & hosting, i18n, AI config, Telegram, help
- **Offline queue** — IndexedDB writes replayed on reconnect via service worker

## Product behavior rules

These reflect intended behavior, not accidental legacy behavior.

- Say **"23 languages"** in user-facing copy, never bare "22".
- Phone-first always; design and verify at **360 px width** minimum.
- Assume one-handed, right-thumb use on site; no hover-only interactions.
- Keep BCA / HDB / CONQUAS defect wording verbatim; do not paraphrase contractual terminology.
- Do not show third-party pricing in-app; use **"paid tier, at your own cost"**.
- Do not prompt end users about GitHub accounts or GitHub setup.
- **REVIEW > COMPARISONS must remain in comparison review/edit context; do not route users back into TAG unless explicitly requested.**
- **Do not assume DRAWINGS and COMPARISONS should share the same routing behavior.**
- If current code behavior conflicts with the user's stated desired behavior, treat the user's current instruction as higher priority and flag the conflict clearly.

## Working style

- Make the smallest effective change that solves the requested problem.
- Prefer targeted fixes over broad refactors.
- Do not rename modules, terms, or flows unless explicitly asked.
- Do not create extra planning/design docs unless explicitly asked.
- Add comments only when explaining **why**, not obvious **what**.
- Do not add emoji to repository files unless requested.
- **Do not include time estimates** ("~30 min", "~2 hours") in plans, summaries, or recommendations. Estimates are noise; just describe scope and proceed step by step on the user's signal.

## Mandatory workflow rules

- If you edit `js/app.js`, always run `npm run build` afterward.
- Build must update:
  - `js/app.compiled.js`
  - cache-busting version/hash in `index.html`
- Never edit `js/app.compiled.js` directly.
- After every build, verify that the cache-busting value in `index.html` changed.
- If you add or change user-facing UI strings:
  1. update `lang/en.json`
  2. run `npm run translate`
- Never commit:
  - `planning/`
  - `deploy/pocketbase/SELFHOST_SETUP_GUIDE.md`

## Task routing

Start here based on the work requested.

- **UI bugs / card previews / tab flows / rendering / REVIEW behavior** → `js/app.js`
- **Offline queue / sync / reconnect / replay issues** → `js/db.js`, `sw.js`, and `offline-sync`
- **Drawing markup / pins / PDF compare / drawing viewer behavior** → `js/app.js` and `site-drawings`
- **PocketBase collections / rules / schema / hooks** → `deploy/pocketbase/pb_schema.json`, `deploy/pocketbase/pb_hooks/main.pb.js`, and `pocketbase-schema`
- **AI prompt behavior** → `deploy/pocketbase/pb_hooks/main.pb.js` and `construction-ai-prompts`
- **Translations / wording / label rollout** → `lang/en.json`, `js/lang.js`, and `i18n-workflow`
- **Reports / export structure / legal wording** → `report-templates`
- **Telegram behavior** → `bot/telegram-bridge.js` and `telegram-notifications`

## Skills available

Project-specific skills exist under `.claude/skills/`. Use them when relevant; do not guess or invent missing ones.

- `construction-defects` — BCA / HDB / CONQUAS labeling and checklist generation
- `site-safety` — WSH / MOM / active-site hazard labeling
- `mobile-first-ux` — thumb-zone, glove, sunlight, and phone-first UI decisions
- `offline-sync` — service worker, IndexedDB queue, replay/sync traps
- `site-drawings` — construction markup conventions and PDF quirks
- `pocketbase-schema` — PocketBase schema, hooks, rules, and non-obvious constraints
- `construction-ai-prompts` — AI photo/search/contract prompt behavior
- `i18n-workflow` — translation workflow and wording safeguards
- `report-templates` — export/report structure and legal/licensing wording
- `telegram-notifications` — SiteShrimp/OpenClaw bot behavior

## Verification rules

Do not report implementation as complete until the smallest relevant verification has been done.

- For UI changes: inspect the affected flow at phone width (minimum 360 px).
- For routing changes: verify entry and back-navigation behavior explicitly.
- For string changes: confirm `lang/en.json` was updated and translation workflow run.
- For build-affecting changes: confirm cache-busting value in `index.html` changed.
- For offline/sync changes: verify behavior across reconnect or queued-write conditions when feasible.
- If you could not verify something directly, say so clearly.

## Allowed / ask-first / never

### Allowed without asking
- Read files
- Search the codebase
- Edit source files relevant to the task
- Run the normal build/translation workflow
- Propose implementation plans, acceptance criteria, and QA steps

### Ask first
- Installing or upgrading dependencies
- Schema changes or data migrations
- Deleting files
- Changing deployment or infrastructure configuration
- Changing routing/UX behavior where intent is unclear
- Creating new docs, plans, or architecture notes

### Never
- Push to origin unless explicitly asked
- Commit unless explicitly asked
- Edit generated artifacts as source (`js/app.compiled.js`)
- Expose secrets or invent credentials
- Preserve clearly wrong legacy behavior just because it exists in current code

## Known traps

- `js/app.js` is the editable frontend source; `js/app.compiled.js` is generated output.
- String changes are incomplete until `lang/en.json` is updated and translation is run.
- A missing cache-bust update can make a successful fix look undeployed.
- Offline issues may involve both `js/db.js` and `sw.js`, not just one file.
- REVIEW routing behavior is sensitive: do not assume existing behavior is correct if the user has already identified it as a bug.

## How to handle feature or bug requests

For behavior-changing work, first restate:

1. current behavior
2. expected behavior
3. acceptance criteria
4. likely files/skills involved

If the desired behavior is ambiguous, ask before implementing.

## Deployment context

Keep this high-level unless infra work is explicitly requested.

- Frontend: `siteshrimp.org` → GitHub Pages → Cloudflare proxy
- Backend API: `api.siteshrimp.org` → Caddy on GCP VM → PocketBase
- File storage: Cloudflare R2 (S3-compatible)

For deeper infra details, inspect the `deploy/pocketbase/` files.

## Memory

Project memory persists across sessions in auto-memory. Do not duplicate volatile session notes here. Use this file for stable rules and current desired behavior only.

## Reporting format

When reporting back after implementation, prefer:

1. What changed
2. Why it changed
3. What was verified
4. Any follow-up risk or open question