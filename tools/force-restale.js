#!/usr/bin/env node
// One-off helper: when an English string in lang/en.json has been edited
// but its 22 translated counterparts still hold the OLD translation,
// translate.js will not pick them up (it only re-translates values that
// are missing or identical to English). This script overwrites the named
// keys in every non-English lang file with the current English source so
// the next `npm run translate` re-translates them.
//
// Usage:  node tools/force-restale.js empty_state.log empty_state.report review.triage_desc

const fs = require("fs");
const path = require("path");

const LANG_DIR = path.join(__dirname, "..", "lang");
const EN_FILE = path.join(LANG_DIR, "en.json");

function getByPath(obj, dotKey) {
  return dotKey.split(".").reduce((o, k) => (o == null ? o : o[k]), obj);
}
function setByPath(obj, dotKey, val) {
  const parts = dotKey.split(".");
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
    cur = cur[parts[i]];
  }
  cur[parts[parts.length - 1]] = val;
}

const keys = process.argv.slice(2);
if (keys.length === 0) {
  console.error("Usage: node tools/force-restale.js <dot.key.path> [more keys...]");
  process.exit(1);
}

const en = JSON.parse(fs.readFileSync(EN_FILE, "utf8"));
const enValues = {};
for (const k of keys) {
  const v = getByPath(en, k);
  if (typeof v !== "string") {
    console.error(`Skip: en.json has no string at "${k}"`);
    continue;
  }
  enValues[k] = v;
}

const files = fs
  .readdirSync(LANG_DIR)
  .filter((f) => f.endsWith(".json") && f !== "en.json");

let touched = 0;
for (const f of files) {
  const p = path.join(LANG_DIR, f);
  let data;
  try {
    data = JSON.parse(fs.readFileSync(p, "utf8"));
  } catch (e) {
    console.error(`Skip ${f}: parse error — ${e.message}`);
    continue;
  }
  let changed = false;
  for (const [k, v] of Object.entries(enValues)) {
    const cur = getByPath(data, k);
    if (cur !== v) {
      setByPath(data, k, v);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + "\n", "utf8");
    touched++;
    console.log(`  ${f}: stamped ${Object.keys(enValues).length} key(s) with English`);
  }
}
console.log(`Done: ${touched}/${files.length} files updated. Now run \`npm run translate\`.`);
