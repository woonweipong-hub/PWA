#!/usr/bin/env node
// Generate the proposed RBAC rules per collection and diff against the
// current rules in deploy/pocketbase/pb_schema.json. Phased apply path:
//
//   Phase 1 (lowest blast — applied first): ontology_*, counters,
//           location_presets, component_presets, map_markups
//   Phase 2 (auth-adjacent): companies, members, invites
//   Phase 3 (mid-traffic):   projects, drawings
//   Phase 4 (hot path):      defects, activity, conquas_observations,
//                            pins, map_pins, settings
//
// Run modes:
//   node tools/migrate-rbac.js                                  # local dry-run
//   PB_URL=… PB_EMAIL=… PB_PASSWORD=… node tools/migrate-rbac.js  # live dry-run
//   …                                            --apply-rbac --phase=1
//
// Pre-deploy checklist (before any RBAC apply touching the hot path):
//   1. tools/migrate-schema.js --apply    — fix the schema drift first
//   2. Deploy main.pb.js to VM            — companyId autofill must be live
//   3. Backfill any defects/etc with NULL companyId (one-off SQL)
//   4. Verify Telegram-bridge user role >= Inspector
//   5. Verify all members.role values are in canonical Title Case

const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "..", "deploy", "pocketbase", "pb_schema.json");

const PB_URL = process.env.PB_URL;
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;
const APPLY = process.argv.includes("--apply-rbac");
const PHASE = (() => {
  const a = process.argv.find((x) => x.startsWith("--phase="));
  if (!a) return null;
  const v = a.split("=")[1];
  // Allow "2a" / "2b" alongside numeric phases
  return /^\d+$/.test(v) ? parseInt(v, 10) : v;
})();
const HAS_CREDS = !!(PB_URL && PB_EMAIL && PB_PASSWORD);

if (APPLY && !HAS_CREDS) {
  console.error("--apply-rbac requires PB_URL, PB_EMAIL, PB_PASSWORD env vars.");
  process.exit(1);
}
if (APPLY && !PHASE) {
  console.error("--apply-rbac requires --phase=N (1, 2, 3, or 4).");
  process.exit(1);
}

// Per-phase collection list. Phase 1 is the lowest-blast set: collections
// that have either no user data (location_presets/component_presets/
// map_markups created 2026-05-04, empty), or are reference data already
// locked at the create/update/delete level (ontology_*, counters).
// Phase 2 split: 2a = companies + members (read tightening, low blast),
// 2b = invites (needs custom redeem-flow handling, parked).
// Phase 4 = hot path (defects + activity + settings + conquas_observations
// + pins + map_pins) — needs goja-safe companyId autofill hook before
// applying so missing-companyId writes auto-fill rather than 403.
const PHASE_COLLECTIONS = {
  1: ["ontology_components", "ontology_defect_types", "ontology_checkpoints", "ontology_trades", "counters", "location_presets", "component_presets", "map_markups"],
  "2a": ["companies", "members"],
  "2b": ["invites"],
  3: ["projects", "drawings"],
  4: ["defects", "activity", "conquas_observations", "pins", "map_pins", "settings"],
};

async function api(p, opts = {}) {
  const url = PB_URL.replace(/\/$/, "") + p;
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${opts.method || "GET"} ${p} → ${res.status} ${body}`);
  }
  return res.json();
}

// ── Helpers for rule expressions ────────────────────────────────────────
// PocketBase v0.23+ filter syntax. `?=` is "any" (returns true if at least
// one related record matches). Membership lookup pattern:
//   @collection.members.userId ?= @request.auth.id
//     && @collection.members.companyId = <field>
//     && @collection.members.role ?~ "<allowed>"

// Role-set guards. PB doesn't have an `IN` operator on string lists, so
// we OR the equality checks. ?~ is "contains" — using = is safer.
function rolesIn(roles) {
  return "(" + roles.map((r) => `@collection.members.role = "${r}"`).join(" || ") + ")";
}

// The most common rule shape: same-company AND auth-user has one of the
// allowed roles. Used for defects, projects, drawings, etc.
function sameCompanyAndRole(roles, companyIdField = "companyId") {
  return [
    `@request.auth.id != ""`,
    `@collection.members.userId ?= @request.auth.id`,
    `@collection.members.companyId = ${companyIdField}`,
    rolesIn(roles),
  ].join(" && ");
}

// Same-company-only (any role). Used for read access.
function sameCompany(companyIdField = "companyId") {
  return [
    `@request.auth.id != ""`,
    `@collection.members.userId ?= @request.auth.id`,
    `@collection.members.companyId = ${companyIdField}`,
  ].join(" && ");
}

// Create-time variant: companyId on the new record may be empty (autofill
// hook will set it from the auth user's membership). If supplied, must
// match. The hook runs after rule validation, so we accept empty here.
function createRuleSameCompany(roles) {
  return [
    `@request.auth.id != ""`,
    `@collection.members.userId ?= @request.auth.id`,
    rolesIn(roles),
    `(@request.body.companyId:isset = false || @request.body.companyId = "" || @collection.members.companyId = @request.body.companyId)`,
  ].join(" && ");
}

// Read-only-for-everyone (used for ontology_* — cross-tenant reference data).
const ANY_AUTH = `@request.auth.id != ""`;
// Server-only (no client should ever write — hook-emit only).
const SERVER_ONLY = null; // PB treats null as "superuser only".

const ALL = ["Admin", "Manager", "Inspector", "Viewer"];
const WRITERS = ["Admin", "Manager", "Inspector"];
const MANAGERS = ["Admin", "Manager"];
const ADMINS = ["Admin"];

// ── Per-collection rule matrix ──────────────────────────────────────────
const PLAN = {
  defects: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Read open to all roles in same company. Write/update Inspector+. Hard-delete Admin only (the soft-archive path uses update, not delete).",
  },
  activity: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Audit trail. Write-only via server hooks; clients can read but never write directly.",
  },
  projects: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(MANAGERS),
    updateRule: sameCompanyAndRole(MANAGERS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Project CRUD restricted to Manager+; only Admin can delete.",
  },
  drawings: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Inspectors can upload drawings (per existing UI). Admin-only delete matches client canBulkDeleteDrawingsRv.",
  },
  pins: {
    listRule: sameCompany("@collection.drawings.companyId via drawingId"),
    viewRule: sameCompany("@collection.drawings.companyId via drawingId"),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(WRITERS),
    note: "TROUBLE: pins has no companyId field — it inherits via drawingId. Either (a) add companyId field via migration, or (b) write a more complex rule joining through drawings. Recommend (a) for simplicity.",
    needsFollowup: true,
  },
  map_pins: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(WRITERS),
    note: "Has companyId. Standard pattern.",
  },
  map_markups: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(MANAGERS),
    note: "Slightly stricter delete — Manager+ — matches client canBulkDeleteComparisonsRv pattern.",
  },
  conquas_observations: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(WRITERS),
    updateRule: sameCompanyAndRole(WRITERS),
    deleteRule: sameCompanyAndRole(MANAGERS),
    note: "CONQUAS workflow — Inspector+ writes, Manager+ deletes.",
  },
  location_presets: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(MANAGERS),
    updateRule: sameCompanyAndRole(MANAGERS),
    deleteRule: sameCompanyAndRole(MANAGERS),
    note: "Dropdown configuration — Manager+ to maintain.",
  },
  component_presets: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(MANAGERS),
    updateRule: sameCompanyAndRole(MANAGERS),
    deleteRule: sameCompanyAndRole(MANAGERS),
    note: "Same as location_presets.",
  },
  companies: {
    listRule: `@request.auth.id != "" && @collection.members.userId ?= @request.auth.id && @collection.members.companyId = id`,
    viewRule: `@request.auth.id != "" && @collection.members.userId ?= @request.auth.id && @collection.members.companyId = id`,
    createRule: `@request.auth.id != ""`,
    updateRule: `@request.auth.id != "" && @collection.members.userId ?= @request.auth.id && @collection.members.companyId = id && ${rolesIn(ADMINS)}`,
    deleteRule: SERVER_ONLY,
    note: "User can only see their own company. Create open to any auth (registration flow). Update Admin-only. Delete server-only (data preservation).",
  },
  members: {
    listRule: `@request.auth.id != "" && @collection.members.userId ?= @request.auth.id && @collection.members.companyId = companyId`,
    viewRule: `@request.auth.id != "" && @collection.members.userId ?= @request.auth.id && @collection.members.companyId = companyId`,
    createRule: createRuleSameCompany(ADMINS),
    updateRule: sameCompanyAndRole(ADMINS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Members visible to same-company users. Admin-only writes (role assignments, removals).",
  },
  invites: {
    listRule: sameCompanyAndRole(ADMINS),
    viewRule: sameCompanyAndRole(ADMINS),
    createRule: createRuleSameCompany(ADMINS),
    updateRule: sameCompanyAndRole(ADMINS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Security-sensitive. Admin-only across the board. (Acceptance-flow uses a separate code-redeem path with no auth — see invites usage in js/db.js for compatibility check before applying.)",
    needsFollowup: true,
  },
  settings: {
    listRule: sameCompany(),
    viewRule: sameCompany(),
    createRule: createRuleSameCompany(ADMINS),
    updateRule: sameCompanyAndRole(ADMINS),
    deleteRule: sameCompanyAndRole(ADMINS),
    note: "Read-open-to-team, Admin-only writes. Stores AI keys / SMTP / etc. — sensitive.",
  },
  counters: {
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Atomic counters. Read-open for app introspection; writes server-only via hooks.",
  },
  ontology_components: {
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Reference data (CONQUAS / building-defects ontology). Cross-tenant read; admin via PB UI only.",
  },
  ontology_defect_types: {
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Same as ontology_components.",
  },
  ontology_checkpoints: {
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Same as ontology_components.",
  },
  ontology_trades: {
    listRule: ANY_AUTH,
    viewRule: ANY_AUTH,
    createRule: SERVER_ONLY,
    updateRule: SERVER_ONLY,
    deleteRule: SERVER_ONLY,
    note: "Same as ontology_components.",
  },
};

// ── Apply path (when --apply-rbac --phase=N) ────────────────────────────
async function applyPhase(phase) {
  console.log(`\n=== APPLY MODE — Phase ${phase} ===`);
  const auth = await api("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
  });
  const headers = { Authorization: "Bearer " + auth.token };
  console.log("Authenticated as " + auth.record.email);

  const targets = PHASE_COLLECTIONS[phase];
  if (!targets) throw new Error("Unknown phase: " + phase);

  let applied = 0;
  let skipped = 0;
  for (const name of targets) {
    const proposed = PLAN[name];
    if (!proposed) {
      console.log(`  ! ${name}: no plan defined — skipping`);
      skipped++;
      continue;
    }
    if (proposed.needsFollowup) {
      console.log(`  ! ${name}: needs follow-up before apply — skipping`);
      skipped++;
      continue;
    }
    const live = await api("/api/collections/" + name, { headers });
    const patch = {
      listRule: proposed.listRule,
      viewRule: proposed.viewRule,
      createRule: proposed.createRule,
      updateRule: proposed.updateRule,
      deleteRule: proposed.deleteRule,
    };
    const same = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"].every((f) => live[f] === patch[f]);
    if (same) {
      console.log(`  = ${name}: rules already match — skipping`);
      skipped++;
      continue;
    }
    await api("/api/collections/" + live.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify(patch),
    });
    console.log(`  ✓ ${name}: rules updated`);
    applied++;
  }
  console.log(`\n=== Phase ${phase} done: ${applied} applied, ${skipped} skipped ===`);
}

// ── Main flow ────────────────────────────────────────────────────────────
if (APPLY) {
  applyPhase(PHASE).catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
} else dryRunDiff();

// ── Diff against current schema ─────────────────────────────────────────
function dryRunDiff() {
const all = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
const followups = [];
let changedCount = 0;
let unchangedCount = 0;

console.log("=== SiteShrimp RBAC plan ===");
console.log("(read-only — proposes new rules vs current schema)");
console.log("");

Object.keys(PLAN).forEach((name) => {
  const collection = all.find((c) => c.name === name);
  if (!collection) {
    console.log(`!! ${name}: NOT FOUND in pb_schema.json — skipping`);
    return;
  }
  const proposed = PLAN[name];
  const fields = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];
  const diff = fields.filter((f) => collection[f] !== proposed[f]);

  console.log(`--- ${name} ---`);
  console.log(`note: ${proposed.note}`);
  if (proposed.needsFollowup) {
    followups.push(name);
    console.log(`!! needs follow-up before apply`);
  }
  if (diff.length === 0) {
    console.log("  no change");
    unchangedCount++;
  } else {
    changedCount++;
    diff.forEach((f) => {
      console.log(`  ${f}:`);
      console.log(`    OLD: ${truncate(collection[f])}`);
      console.log(`    NEW: ${truncate(proposed[f])}`);
    });
  }
  console.log("");
});

function truncate(v) {
  if (v === null) return "null (superusers only)";
  if (v === undefined) return "(undefined)";
  const s = String(v);
  return s.length > 200 ? s.slice(0, 197) + "..." : s;
}

console.log("=== Summary ===");
console.log(`Collections with rule changes: ${changedCount}`);
console.log(`Collections unchanged:         ${unchangedCount}`);
console.log(`Collections needing follow-up: ${followups.length}${followups.length ? " (" + followups.join(", ") + ")" : ""}`);
console.log("");
console.log("This is a plan only — nothing has been applied.");
console.log("To apply: PB_URL=… PB_EMAIL=… PB_PASSWORD=… node tools/migrate-rbac.js --apply-rbac --phase=N");
console.log("");
console.log("Pre-apply checklist (see header comment).");
} // end dryRunDiff
