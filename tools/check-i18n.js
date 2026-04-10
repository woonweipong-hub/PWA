#!/usr/bin/env node
// Translation drift guard
//
// Validates that every lang/*.json file has the same shape as lang/en.json
// (the source of truth). Exits non-zero and prints a report if any locale
// is missing keys, has extra keys, or has a nested object where en.json has
// a string (or vice versa).
//
// Run manually:   node tools/check-i18n.js
// As npm script:  npm run check:i18n

const fs = require("fs");
const path = require("path");

const langDir = path.resolve(__dirname, "..", "lang");
const SOURCE = "en.json";

function loadJson(file) {
  try {
    return JSON.parse(fs.readFileSync(path.join(langDir, file), "utf8"));
  } catch (e) {
    console.error(`FATAL: cannot parse ${file}: ${e.message}`);
    process.exit(2);
  }
}

// Walk an object and yield dotted key paths + the type at that path
function flatten(obj, prefix = "") {
  const out = new Map();
  if (obj == null || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    const keyPath = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      for (const [p, t] of flatten(v, keyPath)) out.set(p, t);
    } else {
      out.set(keyPath, Array.isArray(v) ? "array" : typeof v);
    }
  }
  return out;
}

function diff(sourceMap, targetMap) {
  const missing = [];
  const extra = [];
  const typeMismatch = [];
  for (const [key, type] of sourceMap) {
    if (!targetMap.has(key)) {
      missing.push(key);
    } else if (targetMap.get(key) !== type) {
      typeMismatch.push(`${key} (expected ${type}, got ${targetMap.get(key)})`);
    }
  }
  for (const key of targetMap.keys()) {
    if (!sourceMap.has(key)) extra.push(key);
  }
  return { missing, extra, typeMismatch };
}

function main() {
  if (!fs.existsSync(langDir)) {
    console.error(`FATAL: ${langDir} not found`);
    process.exit(2);
  }
  const files = fs
    .readdirSync(langDir)
    .filter((f) => f.endsWith(".json") && f !== SOURCE)
    .sort();

  const source = loadJson(SOURCE);
  const sourceMap = flatten(source);
  console.log(
    `Checking ${files.length} locales against ${SOURCE} (${sourceMap.size} keys)...\n`
  );

  let failed = 0;
  const report = [];
  for (const file of files) {
    const target = loadJson(file);
    const targetMap = flatten(target);
    const { missing, extra, typeMismatch } = diff(sourceMap, targetMap);
    if (missing.length || extra.length || typeMismatch.length) {
      failed++;
      report.push({ file, missing, extra, typeMismatch });
    } else {
      console.log(`  \u2713 ${file.padEnd(14)} ${targetMap.size} keys`);
    }
  }

  if (report.length) {
    console.log("\nFAILURES:\n");
    for (const { file, missing, extra, typeMismatch } of report) {
      console.log(`  \u2717 ${file}`);
      if (missing.length) {
        console.log(`      missing (${missing.length}):`);
        for (const k of missing.slice(0, 20)) console.log(`        - ${k}`);
        if (missing.length > 20)
          console.log(`        ... and ${missing.length - 20} more`);
      }
      if (extra.length) {
        console.log(`      extra (${extra.length}):`);
        for (const k of extra.slice(0, 20)) console.log(`        + ${k}`);
        if (extra.length > 20)
          console.log(`        ... and ${extra.length - 20} more`);
      }
      if (typeMismatch.length) {
        console.log(`      type mismatch (${typeMismatch.length}):`);
        for (const k of typeMismatch.slice(0, 20))
          console.log(`        ~ ${k}`);
      }
      console.log("");
    }
    console.log(`\n${failed}/${files.length} locale(s) out of sync with ${SOURCE}.`);
    process.exit(1);
  }

  console.log(`\nAll ${files.length} locales in sync with ${SOURCE}.`);
}

main();
