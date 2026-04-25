#!/usr/bin/env node
// Auto cache-bumping for index.html
//
// Rewrites every ?v=... on js/lang.js, js/app.compiled.js, js/constants.js,
// and js/db.js in index.html to a short git commit SHA so bundle loads are
// cache-busted on every deploy. constants.js is included because new
// constants added there are referenced by the compiled app.js — without
// cache-busting, browsers/SW can serve stale constants.js alongside fresh
// app.compiled.js and trip ReferenceError on the new symbol (see 2026-04-23
// LOG-can't-render incident). db.js is included because the GDrive folder-
// mirroring + offline-queue modules evolve and stale copies would mis-route
// uploads or silently drop entries.
// Falls back to an epoch timestamp if git is unavailable (e.g. CI without git).

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const indexPath = path.join(repoRoot, "index.html");

function getVersionTag() {
  try {
    const sha = execSync("git rev-parse --short HEAD", {
      cwd: repoRoot,
      stdio: ["ignore", "pipe", "ignore"],
    })
      .toString()
      .trim();
    if (sha) return sha;
  } catch {
    // fall through to timestamp
  }
  return Math.floor(Date.now() / 1000).toString(36);
}

function main() {
  if (!fs.existsSync(indexPath)) {
    console.error(`bump-cache: ${indexPath} not found`);
    process.exit(1);
  }
  const version = getVersionTag();
  const original = fs.readFileSync(indexPath, "utf8");
  const targets = ["js/lang.js", "js/app.compiled.js", "js/constants.js", "js/db.js"];
  let updated = original;
  let totalMatches = 0;
  for (const target of targets) {
    const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const re = new RegExp(`(${escaped})\\?v=[^"'\\s]+`, "g");
    const matches = updated.match(re) || [];
    totalMatches += matches.length;
    updated = updated.replace(re, `$1?v=${version}`);
  }
  if (!totalMatches) {
    console.warn(
      "bump-cache: no ?v= query strings found — nothing to update. Check index.html."
    );
    process.exit(0);
  }
  if (updated !== original) {
    fs.writeFileSync(indexPath, updated);
    console.log(`bump-cache: set cache version to v=${version} (${totalMatches} refs)`);
  } else {
    console.log(`bump-cache: already at v=${version} (${totalMatches} refs)`);
  }
}

main();
