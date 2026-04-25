#!/usr/bin/env node
/**
 * Backfill `defects.iso_filename` for existing rows that pre-date the
 * post-save ISO 19650 caching code path (Step 1 / Phase 3.9).
 *
 * Reuses the same filename builder shipped in js/app.js (the testable
 * ISO19650-EXPORT-START/END region) so production filenames stay in sync
 * with whatever the app generates on new saves — no separate codepath.
 *
 * Usage:
 *
 *   PB_URL=https://api.siteshrimp.org \
 *   PB_ADMIN_EMAIL=woonwei.pong@gmail.com \
 *   PB_ADMIN_PASSWORD=*** \
 *   node tools/backfill-iso-filename.js [--dry-run] [--limit N] [--force]
 *
 * Flags:
 *   --dry-run   List the planned filenames without PATCHing.
 *   --limit N   Process at most N records this run (default: all).
 *   --force     Recompute even when iso_filename already has a value.
 *
 * Safety:
 *   - PocketBase admin auth required; no anonymous writes.
 *   - One PATCH at a time, sequential (no parallel writes), to keep the
 *     hook + rate-limit pipeline calm.
 *   - Skips the record (logs a warning, continues) if isoNameForDefect()
 *     throws — most often because block/level/trade are missing on legacy
 *     rows. Re-run after data cleanup to pick those up.
 */

const fs = require("fs");
const path = require("path");

// ── Args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const force = args.includes("--force");
const limitArg = args.find(a => a.startsWith("--limit="));
const limit = limitArg ? parseInt(limitArg.split("=")[1], 10) : (
  args.indexOf("--limit") >= 0 ? parseInt(args[args.indexOf("--limit") + 1], 10) : 0
);

// ── Env ─────────────────────────────────────────────────────────────────
const PB_URL = (process.env.PB_URL || "").replace(/\/+$/, "");
const PB_EMAIL = process.env.PB_ADMIN_EMAIL || "";
const PB_PASSWORD = process.env.PB_ADMIN_PASSWORD || "";
if (!PB_URL || !PB_EMAIL || !PB_PASSWORD) {
  console.error("Missing PB_URL / PB_ADMIN_EMAIL / PB_ADMIN_PASSWORD env vars.");
  console.error("Example:");
  console.error("  PB_URL=https://api.siteshrimp.org \\");
  console.error("  PB_ADMIN_EMAIL=admin@... \\");
  console.error("  PB_ADMIN_PASSWORD=*** \\");
  console.error("  node tools/backfill-iso-filename.js --dry-run");
  process.exit(1);
}

// ── Extract ISO functions from js/app.js ─────────────────────────────────
const ROOT = path.resolve(__dirname, "..");
const APP = fs.readFileSync(path.join(ROOT, "js", "app.js"), "utf8");
const m = APP.match(/ISO19650-EXPORT-START[^\n]*\n([\s\S]*?)\n[^\n]*ISO19650-EXPORT-END/);
if (!m) {
  console.error("FAIL: ISO19650-EXPORT-START/END markers not found in js/app.js");
  process.exit(1);
}
const isoExports = {};
new Function("__out",
  m[1] + "\n" +
  "Object.assign(__out,{isoNameForDefect});"
)(isoExports);
const { isoNameForDefect } = isoExports;

// ── Inline-load constants helpers (conquasElementOf + conquasElementCode) ──
// Read constants.js and eval its content in a sandboxed Function scope so
// we don't depend on a build step. Constants.js is plain script-style code
// (no imports/exports), so a single Function() captures every declaration.
const CONSTS = fs.readFileSync(path.join(ROOT, "js", "constants.js"), "utf8");
const constExports = {};
new Function("__out",
  CONSTS + "\n" +
  "Object.assign(__out,{conquasElementOf,conquasElementCode});"
)(constExports);
const { conquasElementOf, conquasElementCode } = constExports;

// ── PB client (minimal — admin auth + list + patch) ──────────────────────
async function pbFetch(url, opts = {}, token) {
  const headers = { "content-type": "application/json", ...(opts.headers || {}) };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(`${PB_URL}${url}`, { ...opts, headers });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`PB ${opts.method || "GET"} ${url} → ${res.status}: ${txt.slice(0, 200)}`);
  }
  return res.json();
}

async function adminAuth() {
  // PB v0.22+ uses /api/collections/_superusers/auth-with-password.
  // Fall back to the legacy /api/admins/auth-with-password if 404.
  try {
    const r = await pbFetch("/api/collections/_superusers/auth-with-password",
      { method: "POST", body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }) });
    return r.token;
  } catch (e) {
    if (!String(e.message).includes("404")) throw e;
    const r = await pbFetch("/api/admins/auth-with-password",
      { method: "POST", body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }) });
    return r.token;
  }
}

async function listAllDefectsMissingIso(token) {
  // PB list endpoint with pagination; perPage=200 is the documented sweet spot
  // for admin reads. iso_filename = "" matches both empty strings and (in
  // practice) nulls on a text field.
  const filter = force ? "" : `iso_filename = ""`;
  const all = [];
  let page = 1, totalPages = 1;
  do {
    const url = `/api/collections/defects/records?page=${page}&perPage=200`
      + (filter ? `&filter=${encodeURIComponent(filter)}` : "");
    const r = await pbFetch(url, {}, token);
    all.push(...(r.items || []));
    totalPages = r.totalPages || 1;
    page++;
    if (limit && all.length >= limit) break;
  } while (page <= totalPages);
  return limit ? all.slice(0, limit) : all;
}

const _companyCache = new Map();
const _projectCache = new Map();
async function getCompany(token, id) {
  if (!id) return null;
  if (_companyCache.has(id)) return _companyCache.get(id);
  try {
    const r = await pbFetch(`/api/collections/companies/records/${id}`, {}, token);
    _companyCache.set(id, r);
    return r;
  } catch { _companyCache.set(id, null); return null; }
}
async function getProject(token, id) {
  if (!id) return null;
  if (_projectCache.has(id)) return _projectCache.get(id);
  try {
    const r = await pbFetch(`/api/collections/projects/records/${id}`, {}, token);
    _projectCache.set(id, r);
    return r;
  } catch { _projectCache.set(id, null); return null; }
}

async function patchIso(token, id, isoName) {
  return pbFetch(`/api/collections/defects/records/${id}`,
    { method: "PATCH", body: JSON.stringify({ iso_filename: isoName }) }, token);
}

// ── Build the ISO name for one defect record ────────────────────────────
function buildIsoNameFor(defect, company, project) {
  const element = conquasElementOf(defect.component) || "";
  const code = conquasElementCode(element) || "";
  const hashShort = String(defect.media_hash || "")
    .replace(/[^a-fA-F0-9]/g, "").slice(0, 8);
  return isoNameForDefect(defect, company || {}, project || {}, {
    seq: 1,
    element: code || undefined,
    hashShort: hashShort || undefined,
    ext: "jpg",
  });
}

// ── Main ────────────────────────────────────────────────────────────────
(async function main() {
  console.log(`PB: ${PB_URL}`);
  console.log(`Mode: ${dryRun ? "DRY-RUN" : "APPLY"}${force ? " · --force" : ""}${limit ? ` · limit=${limit}` : ""}`);

  let token;
  try { token = await adminAuth(); }
  catch (e) { console.error("Admin auth failed:", e.message); process.exit(2); }
  console.log("Authenticated.");

  let candidates;
  try { candidates = await listAllDefectsMissingIso(token); }
  catch (e) { console.error("List failed:", e.message); process.exit(3); }
  console.log(`Found ${candidates.length} candidate record${candidates.length === 1 ? "" : "s"}.`);
  if (!candidates.length) { console.log("Nothing to do."); return; }

  let ok = 0, skipped = 0, failed = 0;
  for (let i = 0; i < candidates.length; i++) {
    const d = candidates[i];
    try {
      const company = await getCompany(token, d.companyId);
      const project = await getProject(token, d.projectId);
      const isoName = buildIsoNameFor(d, company, project);
      if (!isoName) { skipped++; console.log(`  SKIP ${d.id} (builder returned empty)`); continue; }
      const tag = `[${i + 1}/${candidates.length}] ${d.id}`;
      if (dryRun) {
        console.log(`  ${tag} → ${isoName}`);
        ok++;
      } else {
        await patchIso(token, d.id, isoName);
        ok++;
        if (ok % 25 === 0 || i === candidates.length - 1) {
          console.log(`  patched ${ok}/${candidates.length}`);
        }
      }
    } catch (e) {
      failed++;
      console.warn(`  FAIL ${d.id}: ${e.message}`);
    }
  }

  console.log("");
  console.log(`Done. ${dryRun ? "Would patch" : "Patched"}: ${ok}. Skipped: ${skipped}. Failed: ${failed}.`);
  if (failed) process.exit(4);
})().catch(e => { console.error("Unhandled:", e); process.exit(99); });
