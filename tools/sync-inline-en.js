#!/usr/bin/env node
// Sync the inlined English pack in js/lang.js from lang/en.json.
//
// The English pack is inlined into lang.js so the very first render has
// every UI string available without waiting on a fetch. When en.json
// gains new keys, the inlined copy goes stale and raw key names leak
// into the UI until lang.js is edited by hand. This script keeps them
// in sync as part of `npm run build`.

const fs = require("fs");
const path = require("path");

const repoRoot = path.resolve(__dirname, "..");
const enPath = path.join(repoRoot, "lang", "en.json");
const langJsPath = path.join(repoRoot, "js", "lang.js");

const en = JSON.parse(fs.readFileSync(enPath, "utf8"));
const inline = "var _enInline = " + JSON.stringify(en) + ";";

const src = fs.readFileSync(langJsPath, "utf8");
const re = /var _enInline = \{[\s\S]*?\};/;
if (!re.test(src)) {
  console.error("sync-inline-en: could not locate _enInline declaration in js/lang.js");
  process.exit(1);
}
const next = src.replace(re, inline);

if (next === src) {
  console.log("sync-inline-en: already in sync.");
} else {
  fs.writeFileSync(langJsPath, next);
  console.log("sync-inline-en: updated _enInline in js/lang.js from lang/en.json");
}
