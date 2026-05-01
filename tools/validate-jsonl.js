#!/usr/bin/env node
// Validates a JSONL file against the SiteShrimp Photo Entry schema
// (base + optional variant via allOf). Hand-rolled validator covering
// the JSON Schema keywords we actually use — no ajv dep needed.
//
// Usage:
//   node tools/validate-jsonl.js                           # synthetic sample
//   node tools/validate-jsonl.js --jsonl=<path>            # validate a real export
//   node tools/validate-jsonl.js --variant=<path>          # add a variant schema
//   node tools/validate-jsonl.js --jsonl=a.jsonl --variant=schema/entries/conquas/v1.json
//
// Exit code 0 on all-OK, 1 on any line failure. Designed to be wired
// into CI or run after a CONQUAS export to confirm AI output governance.

const fs = require("fs");
const path = require("path");

function loadJson(p) { return JSON.parse(fs.readFileSync(p, "utf8")); }

function resolveRef(schema, refMap) {
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref && refMap[schema.$ref]) return resolveRef(refMap[schema.$ref], refMap);
  return schema;
}

function checkType(v, type) {
  if (Array.isArray(type)) return type.some(t => checkType(v, t));
  switch (type) {
    case "null":    return v === null;
    case "string":  return typeof v === "string";
    case "number":  return typeof v === "number" && !isNaN(v);
    case "integer": return Number.isInteger(v);
    case "boolean": return typeof v === "boolean";
    case "object":  return v !== null && typeof v === "object" && !Array.isArray(v);
    case "array":   return Array.isArray(v);
    default:        return true;
  }
}

function validateAgainst(schema, obj, refMap, errors, prefix = "$") {
  schema = resolveRef(schema, refMap);
  if (!schema || typeof schema !== "object") return;

  // allOf — every subschema must pass
  if (Array.isArray(schema.allOf)) {
    for (const sub of schema.allOf) validateAgainst(sub, obj, refMap, errors, prefix);
  }

  // required keys present and non-empty
  if (Array.isArray(schema.required)) {
    for (const r of schema.required) {
      if (!(r in obj) || obj[r] == null || obj[r] === "") {
        errors.push(`${prefix}.${r}: required field missing or empty`);
      }
    }
  }

  // per-property checks
  if (schema.properties && obj && typeof obj === "object" && !Array.isArray(obj)) {
    for (const [k, raw] of Object.entries(schema.properties)) {
      if (!(k in obj)) continue;
      const v = obj[k];
      const sub = resolveRef(raw, refMap);
      if (sub.type !== undefined && !checkType(v, sub.type)) {
        errors.push(`${prefix}.${k}: type mismatch (expected ${JSON.stringify(sub.type)}, got ${v === null ? "null" : Array.isArray(v) ? "array" : typeof v})`);
      }
      if (Array.isArray(sub.enum) && !sub.enum.includes(v)) {
        errors.push(`${prefix}.${k}: enum violation (got ${JSON.stringify(v)}, allowed ${JSON.stringify(sub.enum)})`);
      }
      if (typeof sub.minimum === "number" && typeof v === "number" && v < sub.minimum) {
        errors.push(`${prefix}.${k}: ${v} < minimum ${sub.minimum}`);
      }
      if (typeof sub.maximum === "number" && typeof v === "number" && v > sub.maximum) {
        errors.push(`${prefix}.${k}: ${v} > maximum ${sub.maximum}`);
      }
    }
  }
}

function validateLine(line, schema, refMap, errors) {
  let obj;
  try { obj = JSON.parse(line); }
  catch (e) { errors.push(`parse error: ${e.message}`); return; }
  validateAgainst(schema, obj, refMap, errors);
}

function main() {
  const args = process.argv.slice(2);
  const opts = {};
  for (const a of args) {
    const m = a.match(/^--([^=]+)=(.*)$/);
    if (m) opts[m[1]] = m[2];
  }

  const repoRoot = path.resolve(__dirname, "..");
  const schemaPath = opts.schema
    ? path.resolve(opts.schema)
    : path.join(repoRoot, "schema", "entries", "v1.json");
  const variantPath = opts.variant ? path.resolve(opts.variant) : null;
  const jsonlPath = opts.jsonl ? path.resolve(opts.jsonl) : null;

  // Build $ref map so a variant's $ref to the base URI resolves locally
  const refMap = {};
  const baseSchema = loadJson(schemaPath);
  if (baseSchema.$id) refMap[baseSchema.$id] = baseSchema;

  let target = baseSchema;
  let label = path.relative(repoRoot, schemaPath);
  if (variantPath) {
    const variantSchema = loadJson(variantPath);
    if (variantSchema.$id) refMap[variantSchema.$id] = variantSchema;
    target = variantSchema;
    label += " + " + path.relative(repoRoot, variantPath);
  }

  let lines;
  if (jsonlPath) {
    lines = fs.readFileSync(jsonlPath, "utf8").split(/\r?\n/).filter(s => s.trim());
  } else {
    // Synthetic CONQUAS-conformant sample — proves the pipeline can
    // produce a row that validates against base + variant together.
    const sample = {
      filename: "Floor/PROJ-ORIG-MMP-FLOOR-001.jpg",
      iso_19650_filename: "PROJ-ORIG-MMP-FLOOR-001.jpg",
      conquas_element: "Floor",
      folder: "Floor",
      entry_id: "DEF-0001",
      entry_type: "Defect",
      title: "Hollow tile, kitchen wall",
      description: "Audible hollowness on multiple wall tiles in kitchen splashback.",
      severity: "Major",
      status: "Open",
      component: "Tiling",
      issue: "Hollowness",
      location: "Kitchen / wall",
      assignee: "Site Manager",
      trade: "Tiler",
      logged_by: "inspector@example.com",
      role: "Inspector",
      date: "2026-05-01",
      due_date: "2026-05-15",
      source_filename: "IMG_4521.jpg",
      gps_lat: 1.3521,
      gps_lng: 103.8198,
      drawing_id: "DWG-A-201",
      drawing_page: 2,
      pin_x: 0.32,
      pin_y: 0.54,
      media_hash: "abcdef1234567890",
      created_at: "2026-05-01T09:23:11+08:00",
      ai_confidence: 0.87,
      ai_model: "gemini",
      ai_prompt_version: "1.1.0",
      human_reviewed: false,
      field_provenance: { severity: "ai", title: "ai", description: "ai" },
      assessment_zone: "Architectural",
      inspection_lot: "LOT-IF-A1",
    };
    lines = [JSON.stringify(sample)];
    console.log("(no --jsonl flag — validating one synthetic sample row)");
  }

  let failed = 0;
  lines.forEach((line, i) => {
    const errors = [];
    validateLine(line, target, refMap, errors);
    if (errors.length) {
      failed++;
      console.error(`line ${i + 1}: FAIL`);
      for (const e of errors) console.error(`  - ${e}`);
    }
  });

  if (failed === 0) {
    console.log(`validate-jsonl: OK (${lines.length} line${lines.length === 1 ? "" : "s"} validated against ${label})`);
    process.exit(0);
  } else {
    console.error(`validate-jsonl: ${failed}/${lines.length} lines failed`);
    process.exit(1);
  }
}

main();
