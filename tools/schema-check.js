#!/usr/bin/env node
// Drift guard for the photo-entry export schema.
//
// Asserts:
//   1. Every header in ENTRY_BASE_HEADERS (js/constants.js) has a
//      matching 'x-csv-header' property in schema/entries/v1.json.
//   2. Every variant in schema/entries/manifest.json has its schema
//      file present and its extra_columns headers covered by that
//      variant's schema (allOf-collected).
//   3. Each variant's workCategory exists in WORK_CATEGORIES.
//
// Exits non-zero on drift so `npm run build` fails loudly. Adding a
// new column or variant should be a single, deliberate change in
// matching pairs (constants + base schema, or manifest + variant
// schema). Silent drift is the failure mode this tool prevents.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const constantsPath = path.join(repoRoot, "js", "constants.js");
const baseSchemaPath = path.join(repoRoot, "schema", "entries", "v1.json");
const manifestPath = path.join(repoRoot, "schema", "entries", "manifest.json");

function loadConstants() {
  const src = fs.readFileSync(constantsPath, "utf8");
  // constants.js is browser-style (bare consts, no module.exports).
  // Wrap in a Function so we can pluck the symbols we need.
  const fn = new Function(src + "; return { ENTRY_BASE_HEADERS, WORK_CATEGORIES };");
  return fn();
}

function loadJson(p) {
  return JSON.parse(fs.readFileSync(p, "utf8"));
}

function headersFromSchema(schema) {
  const out = new Set();
  function walk(node) {
    if (!node || typeof node !== "object") return;
    if (node.properties && typeof node.properties === "object") {
      for (const v of Object.values(node.properties)) {
        if (v && typeof v === "object" && typeof v["x-csv-header"] === "string") {
          out.add(v["x-csv-header"]);
        }
      }
    }
    if (Array.isArray(node.allOf)) node.allOf.forEach(walk);
    if (Array.isArray(node.oneOf)) node.oneOf.forEach(walk);
    if (Array.isArray(node.anyOf)) node.anyOf.forEach(walk);
  }
  walk(schema);
  return out;
}

function main() {
  const errors = [];
  let baseHeaderCount = 0;
  let variantCount = 0;

  let consts;
  try {
    consts = loadConstants();
  } catch (e) {
    console.error("schema-check: failed to load js/constants.js — " + e.message);
    process.exit(1);
  }
  const { ENTRY_BASE_HEADERS, WORK_CATEGORIES } = consts;
  if (!Array.isArray(ENTRY_BASE_HEADERS)) {
    errors.push("ENTRY_BASE_HEADERS is missing from js/constants.js or not an array.");
  } else {
    baseHeaderCount = ENTRY_BASE_HEADERS.length;
  }

  // 1. Base headers <= base schema x-csv-headers
  let baseHeaders;
  try {
    const baseSchema = loadJson(baseSchemaPath);
    baseHeaders = headersFromSchema(baseSchema);
  } catch (e) {
    errors.push(`Failed to load ${path.relative(repoRoot, baseSchemaPath)}: ${e.message}`);
  }
  if (baseHeaders && Array.isArray(ENTRY_BASE_HEADERS)) {
    for (const h of ENTRY_BASE_HEADERS) {
      if (!baseHeaders.has(h)) {
        errors.push(`Base header "${h}" has no matching x-csv-header property in schema/entries/v1.json`);
      }
    }
  }

  // 2 + 3. Manifest variant integrity
  let manifest;
  try {
    manifest = loadJson(manifestPath);
  } catch (e) {
    errors.push(`Failed to load ${path.relative(repoRoot, manifestPath)}: ${e.message}`);
  }
  if (manifest && Array.isArray(manifest.variants)) {
    variantCount = manifest.variants.length;
    for (const variant of manifest.variants) {
      if (!variant || !variant.id) {
        errors.push("Manifest variant missing 'id'.");
        continue;
      }
      const variantPath = path.join(repoRoot, "schema", "entries", variant.id, "v1.json");
      if (!fs.existsSync(variantPath)) {
        errors.push(`Variant "${variant.id}" registered in manifest but file missing: schema/entries/${variant.id}/v1.json`);
        continue;
      }
      let variantHeaders;
      try {
        const variantSchema = loadJson(variantPath);
        variantHeaders = headersFromSchema(variantSchema);
      } catch (e) {
        errors.push(`Variant "${variant.id}": failed to parse schema — ${e.message}`);
        continue;
      }
      for (const col of variant.extra_columns || []) {
        if (!col || !col.header) {
          errors.push(`Variant "${variant.id}": extra_column entry missing 'header'.`);
          continue;
        }
        if (!variantHeaders.has(col.header)) {
          errors.push(`Variant "${variant.id}": manifest extra_column header "${col.header}" not declared in schema/entries/${variant.id}/v1.json (must appear as an x-csv-header on a property, including allOf).`);
        }
      }
      if (variant.workCategory && WORK_CATEGORIES && !WORK_CATEGORIES[variant.workCategory]) {
        errors.push(`Variant "${variant.id}": workCategory "${variant.workCategory}" not in WORK_CATEGORIES. Add it to js/constants.js or fix the manifest entry.`);
      }
    }
  }

  if (errors.length) {
    console.error("schema-check: drift detected\n");
    for (const e of errors) console.error("  - " + e);
    console.error("\nFix: align ENTRY_BASE_HEADERS in js/constants.js with x-csv-header values in schema/entries/v1.json (and variants in schema/entries/<id>/v1.json + manifest.json).");
    process.exit(1);
  }
  console.log(`schema-check: OK (${baseHeaderCount} base headers, ${variantCount} variant${variantCount === 1 ? "" : "s"})`);
}

main();
