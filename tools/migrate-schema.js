#!/usr/bin/env node
// One-shot migration to repair two production PB schema bugs discovered 2026-05-04:
//   1. map_pins.Ing  → rename to lng (column-name typo, all longitude writes silently dropped)
//   2. defects       → add 38 missing fields the app writes (workCategory, lat, lng, AI provenance,
//                      variant fields). Without these, AI/variant features write to /dev/null.
//
// Run from repo root.
//
// Dry run (default — prints plan, makes no changes):
//   $env:PB_URL='https://api.siteshrimp.org'; $env:PB_EMAIL='...'; $env:PB_PASSWORD='...'; node tools/migrate-schema.js
//
// Execute:
//   node tools/migrate-schema.js --apply
//
// Idempotent: re-running after success is a no-op.
// Rollback: restore from PB admin → Settings → Backups (the a-z0-1-.zip taken earlier).

const PB_URL = process.env.PB_URL;
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;
const APPLY = process.argv.includes("--apply");
const HAS_CREDS = !!(PB_URL && PB_EMAIL && PB_PASSWORD);

if (APPLY && !HAS_CREDS) {
  console.error("--apply requires PB_URL, PB_EMAIL, PB_PASSWORD env vars.");
  process.exit(1);
}

// Field types derived from how js/app.js uses them.
// Anything ambiguous defaulted to text — safer than wrong-typing a column.
const DEFECTS_MISSING_FIELDS = [
  // GPS coords (lat/lng/mapZoom on the defect itself, separate from map_pins)
  { name: "lat", type: "number" },
  { name: "lng", type: "number" },
  { name: "mapZoom", type: "number" },
  // Work category — drives variant AI schema selection
  { name: "workCategory", type: "text" },
  // AI provenance
  { name: "ai_confidence", type: "number" },
  { name: "ai_model", type: "text" },
  { name: "ai_prompt_version", type: "text" },
  { name: "human_reviewed", type: "bool" },
  { name: "fieldProvenance", type: "json" },
  { name: "media_hash", type: "text" },
  { name: "source_type", type: "text" },
  // ISO 19650 / inspection metadata
  { name: "iso_filename", type: "text" },
  { name: "assessment_zone", type: "text" },
  { name: "inspection_lot", type: "text" },
  { name: "work_stage", type: "text" },
  { name: "timezone", type: "text" },
  // CONQUAS batch
  { name: "observation_batch_id", type: "text" },
  { name: "batch_total_checks", type: "number" },
  { name: "batch_weighted_applicable", type: "number" },
  { name: "conquas_tier", type: "text" },
  { name: "checkpoint_match", type: "text" },
  // Variant — highrise / landed residential
  { name: "storey_count", type: "number" },
  { name: "party_wall_side", type: "text" },
  { name: "roof_type", type: "text" },
  { name: "block_or_tower", type: "text" },
  { name: "unit_no", type: "text" },
  { name: "vertical_zone", type: "text" },
  // Variant — construction site (WSH)
  { name: "hazard_category", type: "text" },
  { name: "ppe_compliance", type: "text" },
  { name: "stop_work_recommended", type: "bool" },
  { name: "workers_exposed", type: "number" },
  { name: "trade_subscope", type: "text" },
  { name: "permit_no", type: "text" },
  // Variant — facilities management
  { name: "service_category", type: "text" },
  { name: "maintenance_type", type: "text" },
  { name: "asset_id", type: "text" },
  { name: "asset_class", type: "text" },
  // Variant — infrastructure
  { name: "chainage_km", type: "number" },
];

function fieldDef(spec) {
  const base = { name: spec.name, required: false, system: false, hidden: false, presentable: false };
  if (spec.type === "text")
    return { ...base, type: "text", max: 0, min: 0, pattern: "", primaryKey: false, autogeneratePattern: "" };
  if (spec.type === "number")
    return { ...base, type: "number", max: null, min: null, onlyInt: false };
  if (spec.type === "bool") return { ...base, type: "bool" };
  if (spec.type === "json") return { ...base, type: "json", maxSize: 0 };
  throw new Error("unknown type: " + spec.type);
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

async function loadCollections(headers) {
  if (HAS_CREDS) {
    const mapPins = await api("/api/collections/map_pins", { headers });
    const defects = await api("/api/collections/defects", { headers });
    return { mapPins, defects, source: "live PB" };
  }
  // Fall back to the local schema snapshot (matches live as of last export).
  const fs = require("fs");
  const path = require("path");
  const schemaPath = path.join(__dirname, "..", "deploy", "pocketbase", "pb_schema.json");
  const all = JSON.parse(fs.readFileSync(schemaPath, "utf8"));
  return {
    mapPins: all.find((c) => c.name === "map_pins"),
    defects: all.find((c) => c.name === "defects"),
    source: "local pb_schema.json (no live connection)",
  };
}

async function main() {
  console.log("=== SiteShrimp PB schema migration ===");
  console.log(
    APPLY
      ? "APPLY MODE — will mutate live PB"
      : HAS_CREDS
      ? "DRY RUN (live) — fetches from PB, no mutations"
      : "DRY RUN (local) — reads deploy/pocketbase/pb_schema.json, no network"
  );
  if (HAS_CREDS) console.log("Target: " + PB_URL);
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

  const { mapPins, defects, source } = await loadCollections(headers);
  console.log("Source: " + source);
  console.log("");

  // 2. map_pins.Ing → lng
  console.log("--- map_pins.Ing → map_pins.lng ---");
  const ingField = mapPins.fields.find((f) => f.name === "Ing");
  const lngField = mapPins.fields.find((f) => f.name === "lng");
  let mapPinsChanged = false;
  if (lngField) {
    console.log("  noop: map_pins.lng already exists");
  } else if (!ingField) {
    console.log("  WARN: map_pins has neither Ing nor lng — needs manual review, skipping");
  } else {
    console.log(`  plan: rename field (id=${ingField.id}) name "Ing" → "lng"`);
    if (APPLY) {
      const newFields = mapPins.fields.map((f) => (f.name === "Ing" ? { ...f, name: "lng" } : f));
      await api("/api/collections/" + mapPins.id, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ fields: newFields }),
      });
      console.log("  done: renamed (data preserved)");
      mapPinsChanged = true;
    }
  }
  console.log("");

  // 3. defects: add missing fields
  console.log("--- defects: add missing fields ---");
  const liveNames = new Set(defects.fields.map((f) => f.name));
  const toAdd = DEFECTS_MISSING_FIELDS.filter((f) => !liveNames.has(f.name));
  const alreadyPresent = DEFECTS_MISSING_FIELDS.length - toAdd.length;
  console.log(`  current: ${defects.fields.length} fields on prod`);
  console.log(`  plan: add ${toAdd.length} fields (${alreadyPresent} already present, skipped)`);
  toAdd.forEach((f) => console.log(`    + ${f.name.padEnd(28)} (${f.type})`));
  if (APPLY && toAdd.length > 0) {
    const newFields = [...defects.fields, ...toAdd.map(fieldDef)];
    await api("/api/collections/" + defects.id, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ fields: newFields }),
    });
    console.log(`  done: added ${toAdd.length} fields`);
  }
  console.log("");

  // 4. Summary
  console.log("=== Done ===");
  if (!APPLY) {
    console.log("This was a dry run. Re-run with --apply to execute the plan above.");
  } else {
    console.log("Mutations applied. Hard-refresh siteshrimp.org and verify:");
    console.log("  - map_pins write/read uses field 'lng'");
    console.log("  - defects POST with workCategory/ai_confidence/etc. persists those values");
    console.log("If anything looks wrong, restore from the PB Admin backup.");
  }
}

main().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
