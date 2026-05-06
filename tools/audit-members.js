#!/usr/bin/env node
// Read-only audit of `members` data on a PocketBase instance. Confirms
// the data shape RBAC re-apply depends on:
//
//   1. Every active members.role is in canonical Title Case
//      ("Admin" | "Manager" | "Inspector" | "Viewer"). Any other casing
//      (lowercase, mixed) will silently fail role checks once Phase 4
//      rules tighten.
//   2. Every members.companyId is non-empty AND points to a real
//      companies row. Orphaned companyIds will 403 once same-company
//      rules apply.
//   3. Every members.userId points to a real users row. Orphaned rows
//      are dead weight but not harmful — flagged separately.
//   4. No duplicate (userId, companyId) pairs — each user should have
//      at most one membership per company.
//
// Read-only. Never writes. Never deletes. Safe to run against prod.
//
// Usage:
//   $env:PB_URL='https://api.siteshrimp.org'
//   $env:PB_EMAIL='woonwei.pong@gmail.com'        # PB superuser
//   $env:PB_PASSWORD='<superuser password>'
//   node tools/audit-members.js

const PB_URL = process.env.PB_URL;
const PB_EMAIL = process.env.PB_EMAIL;
const PB_PASSWORD = process.env.PB_PASSWORD;

if (!PB_URL || !PB_EMAIL || !PB_PASSWORD) {
  console.error("Requires PB_URL, PB_EMAIL, PB_PASSWORD env vars (PB superuser).");
  process.exit(1);
}

const CANONICAL_ROLES = ["Admin", "Manager", "Inspector", "Viewer"];

async function api(p, opts = {}) {
  const url = PB_URL.replace(/\/$/, "") + p;
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  if (!res.ok) throw new Error(`${opts.method || "GET"} ${p} → ${res.status} ${JSON.stringify(body).slice(0, 300)}`);
  return body;
}

async function fetchAll(collection, headers) {
  const out = [];
  let page = 1;
  while (true) {
    const r = await api(`/api/collections/${collection}/records?perPage=200&page=${page}`, { headers });
    out.push(...(r.items || []));
    if (page >= (r.totalPages || 1)) break;
    page++;
  }
  return out;
}

(async () => {
  console.log("=== members audit ===");
  console.log("Target:", PB_URL);
  console.log("");

  // Auth as superuser (PB v0.23+ uses _superusers collection).
  let token;
  try {
    const auth = await api("/api/collections/_superusers/auth-with-password", {
      method: "POST",
      body: JSON.stringify({ identity: PB_EMAIL, password: PB_PASSWORD }),
    });
    token = auth.token;
  } catch (err) {
    console.error("Superuser auth failed:", err.message);
    console.error("Note: PB v0.23+ uses _superusers collection. If you're on an older build, edit this script.");
    process.exit(1);
  }
  const headers = { Authorization: "Bearer " + token };
  console.log("Authenticated as superuser.\n");

  // Fetch members + companies + users.
  const [members, companies, users] = await Promise.all([
    fetchAll("members", headers),
    fetchAll("companies", headers),
    fetchAll("users", headers),
  ]);

  console.log(`Loaded: ${members.length} members, ${companies.length} companies, ${users.length} users\n`);

  const companyIdSet = new Set(companies.map((c) => c.id));
  const userIdSet = new Set(users.map((u) => u.id));

  // ── 1. Role casing ──────────────────────────────────────────
  const roleCounts = {};
  const badRole = [];
  for (const m of members) {
    const role = m.role == null ? "" : String(m.role);
    roleCounts[role] = (roleCounts[role] || 0) + 1;
    if (!CANONICAL_ROLES.includes(role)) badRole.push({ id: m.id, userId: m.userId, role });
  }
  console.log("[1] Role distribution:");
  for (const [k, v] of Object.entries(roleCounts).sort((a, b) => b[1] - a[1])) {
    const ok = CANONICAL_ROLES.includes(k);
    console.log(`    ${ok ? "OK  " : "BAD "} ${JSON.stringify(k).padEnd(15)} ${v}`);
  }
  if (badRole.length) {
    console.log(`    -> ${badRole.length} member(s) with non-canonical role:`);
    for (const m of badRole.slice(0, 10)) {
      console.log(`       member.id=${m.id}  userId=${m.userId}  role=${JSON.stringify(m.role)}`);
    }
    if (badRole.length > 10) console.log(`       ...and ${badRole.length - 10} more`);
  }
  console.log("");

  // ── 2. companyId integrity ──────────────────────────────────
  const emptyCompanyId = members.filter((m) => !m.companyId);
  const orphanCompanyId = members.filter((m) => m.companyId && !companyIdSet.has(m.companyId));
  console.log("[2] companyId integrity:");
  console.log(`    empty companyId:    ${emptyCompanyId.length}`);
  console.log(`    orphan companyId:   ${orphanCompanyId.length} (points to nonexistent companies row)`);
  for (const m of [...emptyCompanyId, ...orphanCompanyId].slice(0, 10)) {
    console.log(`       member.id=${m.id}  userId=${m.userId}  companyId=${JSON.stringify(m.companyId || "")}`);
  }
  console.log("");

  // ── 3. userId integrity ─────────────────────────────────────
  const emptyUserId = members.filter((m) => !m.userId);
  const orphanUserId = members.filter((m) => m.userId && !userIdSet.has(m.userId));
  console.log("[3] userId integrity:");
  console.log(`    empty userId:       ${emptyUserId.length}`);
  console.log(`    orphan userId:      ${orphanUserId.length} (points to nonexistent users row)`);
  for (const m of [...emptyUserId, ...orphanUserId].slice(0, 10)) {
    console.log(`       member.id=${m.id}  userId=${JSON.stringify(m.userId || "")}  companyId=${m.companyId}`);
  }
  console.log("");

  // ── 4. Duplicate (userId, companyId) ────────────────────────
  const seen = new Map();
  const dupes = [];
  for (const m of members) {
    const key = `${m.userId}::${m.companyId}`;
    if (seen.has(key)) {
      dupes.push({ a: seen.get(key), b: m, key });
    } else {
      seen.set(key, m);
    }
  }
  console.log("[4] Duplicate (userId, companyId) pairs:");
  console.log(`    duplicates:         ${dupes.length}`);
  for (const d of dupes.slice(0, 10)) {
    console.log(`       ${d.key}  members.id: ${d.a.id} & ${d.b.id}`);
  }
  console.log("");

  // ── Verdict ────────────────────────────────────────────────
  const blockers =
    badRole.length +
    emptyCompanyId.length +
    orphanCompanyId.length;
  const warnings =
    emptyUserId.length +
    orphanUserId.length +
    dupes.length;

  console.log("=== Verdict ===");
  console.log(`RBAC blockers (must fix before re-apply): ${blockers}`);
  console.log(`Warnings (should fix soon):               ${warnings}`);
  if (blockers > 0) {
    console.log("\nDo NOT re-apply RBAC until blockers are zero. Lowercase roles or empty/orphan companyIds will cause writes to 403 once same-company rules tighten.");
    process.exit(1);
  } else {
    console.log("\nMembers data is RBAC-ready. Proceed to: smoke-rbac.js (baseline) → migrate-rbac.js dry-run → --apply-rbac --phase=1.");
    process.exit(0);
  }
})().catch((e) => {
  console.error("FAIL:", e.message);
  process.exit(1);
});
