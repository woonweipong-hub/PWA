#!/usr/bin/env node
// Gap #1 (assign-to-trade workflow) v1 — adds two fields to defects:
//   - assignee_org          subcontractor / vendor company name (text)
//   - assignee_org_contact  point-of-contact for that org      (text)
//
// Sits beside the existing `assignee` (in-company person) + `trade`
// (category, e.g. Plumbing) so the "send to plumber sub" workflow has a
// home. Both optional. Idempotent — re-running is a no-op.
//
// Dry run (default — reads local pb_schema.json):
//   node tools/migrate-assignee-org.js
//
// Live dry run (fetches from PB):
//   $env:PB_URL='...'; $env:PB_EMAIL='...'; $env:PB_PASSWORD='...'; node tools/migrate-assignee-org.js
//
// Apply:
//   node tools/migrate-assignee-org.js --apply

const PB_URL = process.env.PB_URL;
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;
const APPLY = process.argv.includes("--apply");
const HAS_CREDS = !!(PB_URL && PB_EMAIL && PB_PASSWORD);

if (APPLY && !HAS_CREDS) {
  console.error("--apply requires PB_URL, PB_EMAIL, PB_PASSWORD env vars.");
  process.exit(1);
}

const NEW_FIELDS = [
  { name: "assignee_org", type: "text" },
  { name: "assignee_org_contact", type: "text" },
];

function fieldDef(spec) {
  return {
    name: spec.name,
    type: "text",
    required: false,
    system: false,
    hidden: false,
    presentable: false,
    max: 0,
    min: 0,
    pattern: "",
    primaryKey: false,
    autogeneratePattern: "",
  };
}

async function api(path, opts = {}) {
  const url = PB_URL.replace(/\/$/, "") + path;
  const res = await fetch(url, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${opts.method || "GET"} ${path} → ${res.status} ${body}`);
  }
  return res.json();
}

async function loadDefects(headers) {
  if (HAS_CREDS) return api("/api/collections/defects", { headers });
  const fs = require("fs");
  const path = require("path");
  const all = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deploy", "pocketbase", "pb_schema.json"), "utf8"));
  return all.find((c) => c.name === "defects");
}

async function main() {
  console.log("=== Gap #1 assignee_org migration ===");
  console.log(
    APPLY
      ? "APPLY MODE — will mutate live PB"
      : HAS_CREDS
      ? "DRY RUN (live)"
      : "DRY RUN (local pb_schema.json)"
  );
  console.log("");

  let headers;
  if (HAS_CREDS) {
    const auth = await api("/api/collections/_superusers/auth-with-password", {
      method: "POST",
      body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
    });
    headers = { Authorization: "Bearer " + auth.token };
    console.log("Authenticated as " + auth.record.email);
    console.log("");
  }

  const defects = await loadDefects(headers);
  const liveNames = new Set(defects.fields.map((f) => f.name));
  const toAdd = NEW_FIELDS.filter((f) => !liveNames.has(f.name));

  console.log(`defects: ${defects.fields.length} fields current, ${toAdd.length} to add`);
  toAdd.forEach((f) => console.log(`  + ${f.name} (${f.type})`));
  if (toAdd.length === 0) console.log("  (already migrated — no-op)");

  if (APPLY && toAdd.length > 0) {
    const newFields = [...defects.fields, ...toAdd.map(fieldDef)];
    await api("/api/collections/" + defects.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: newFields }),
    });
    console.log("  done");
  }

  console.log("");
  console.log("=== Done ===");
  if (!APPLY) console.log("Re-run with --apply to execute.");
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
