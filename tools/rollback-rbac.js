#!/usr/bin/env node
// EMERGENCY ROLLBACK — restore API rules from local pb_schema.json to the
// live PocketBase. Use this when an RBAC apply has blocked production writes.
//
// What it does:
//   For every collection in deploy/pocketbase/pb_schema.json, PATCH the
//   live collection's listRule/viewRule/createRule/updateRule/deleteRule
//   to exactly match the local file. Other collection settings (fields,
//   indexes, options) are NOT touched.
//
// What it does NOT do:
//   - Does not delete or rename collections
//   - Does not touch fields, indexes, schema
//   - Does not change hooks
//   - Does not modify records
//
// Run modes:
//   Dry run (default — prints diff, no changes):
//     $env:PB_URL='https://api.siteshrimp.org'
//     $env:PB_EMAIL='<superuser email>'
//     $env:PB_PASSWORD='<superuser password>'
//     node tools/rollback-rbac.js
//
//   Apply:
//     node tools/rollback-rbac.js --apply
//
// Idempotent: re-running after success is a no-op (collections already
// matching local schema are skipped).

const fs = require("fs");
const path = require("path");

const SCHEMA = path.join(__dirname, "..", "deploy", "pocketbase", "pb_schema.json");

const PB_URL = process.env.PB_URL;
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;
const APPLY = process.argv.includes("--apply");
const HAS_CREDS = !!(PB_URL && PB_EMAIL && PB_PASSWORD);

if (!HAS_CREDS) {
  console.error("Requires PB_URL, PB_EMAIL, PB_PASSWORD env vars.");
  process.exit(1);
}

const RULE_FIELDS = ["listRule", "viewRule", "createRule", "updateRule", "deleteRule"];

async function api(p, opts = {}) {
  const url = PB_URL.replace(/\/$/, "") + p;
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${opts.method || "GET"} ${p} -> ${res.status} ${body}`);
  }
  return res.json();
}

function truncate(v) {
  if (v === null || v === undefined) return "(null/superuser-only)";
  const s = String(v);
  return s.length > 140 ? s.slice(0, 137) + "..." : s;
}

(async () => {
  console.log("=== SiteShrimp emergency RBAC rollback ===");
  console.log(APPLY ? "MODE: APPLY (live changes)" : "MODE: DRY RUN (no changes)");
  console.log("Target:", PB_URL);
  console.log("");

  const local = JSON.parse(fs.readFileSync(SCHEMA, "utf8"));
  if (!Array.isArray(local)) {
    throw new Error("pb_schema.json: expected top-level array of collections");
  }

  const auth = await api("/api/collections/_superusers/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
  });
  const headers = { Authorization: "Bearer " + auth.token };
  console.log("Authenticated as superuser:", auth.record.email);
  console.log("");

  let patched = 0;
  let unchanged = 0;
  let missing = 0;
  let failed = 0;

  for (const localColl of local) {
    const name = localColl.name;
    if (!name) continue;
    if (name.startsWith("_")) continue; // skip system collections

    let live;
    try {
      live = await api("/api/collections/" + encodeURIComponent(name), { headers });
    } catch (e) {
      console.log(`  ! ${name}: not on live server — skipping`);
      missing++;
      continue;
    }

    const diff = RULE_FIELDS.filter((f) => live[f] !== localColl[f]);
    if (diff.length === 0) {
      unchanged++;
      continue;
    }

    console.log(`--- ${name} ---`);
    diff.forEach((f) => {
      console.log(`  ${f}:`);
      console.log(`    LIVE:  ${truncate(live[f])}`);
      console.log(`    LOCAL: ${truncate(localColl[f])}`);
    });

    if (!APPLY) {
      patched++;
      continue;
    }

    const patch = {};
    RULE_FIELDS.forEach((f) => { patch[f] = localColl[f]; });

    try {
      await api("/api/collections/" + live.id, {
        method: "PATCH",
        headers,
        body: JSON.stringify(patch),
      });
      console.log(`  -> patched`);
      patched++;
    } catch (e) {
      console.log(`  ! PATCH failed: ${e.message}`);
      failed++;
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Collections ${APPLY ? "patched" : "would patch"}: ${patched}`);
  console.log(`Collections unchanged:                 ${unchanged}`);
  console.log(`Collections missing on live:           ${missing}`);
  console.log(`Collections failed:                    ${failed}`);
  if (!APPLY) {
    console.log("");
    console.log("Re-run with --apply to make these changes.");
  }
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
