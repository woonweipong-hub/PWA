#!/usr/bin/env node
// Goja-safe smoke test for the rolled-back hooks (companyId autofill +
// onRecordUpdate audit emit). Drives a LOCAL PocketBase instance with
// representative POSTs and confirms:
//
//   1. PB starts cleanly with the patched main.pb.js (no parse errors).
//   2. PWA-style create with companyId set → defect_id assigned, no audit
//      row appended on subsequent client-emitted update.
//   3. Bridge-style create WITHOUT companyId → autofilled from the
//      authenticated user's members row.
//   4. Bridge-style update without comments → server appends a kind:"event"
//      row to comments JSON for any tracked field that changed.
//   5. Client-style update WITH comments grown → server skips (no double-emit).
//
// Pre-requisites:
//   - Local PB binary running with the proposed main.pb.js applied
//   - One companies row, one users row authed, one members row linking them
//   - Set env vars below
//
// Usage:
//   $env:PB_URL='http://127.0.0.1:8090'
//   $env:PB_USER_EMAIL='tester@local'
//   $env:PB_USER_PASSWORD='<tester password>'
//   $env:PB_COMPANY_ID='<companies.id the tester belongs to>'
//   $env:PB_PROJECT_ID='<an existing projects.id under that company>'
//   node tools/test-hooks-local.js
//
// Pass criteria: every TC reports OK. Any FAIL = do not deploy hooks to VM.

const PB_URL = process.env.PB_URL || "http://127.0.0.1:8090";
const EMAIL = process.env.PB_USER_EMAIL;
const PASSWORD = process.env.PB_USER_PASSWORD;
const COMPANY_ID = process.env.PB_COMPANY_ID;
const PROJECT_ID = process.env.PB_PROJECT_ID;

if (!EMAIL || !PASSWORD || !COMPANY_ID || !PROJECT_ID) {
  console.error("Requires PB_USER_EMAIL, PB_USER_PASSWORD, PB_COMPANY_ID, PB_PROJECT_ID env vars.");
  process.exit(1);
}

async function api(p, opts = {}) {
  const url = PB_URL.replace(/\/$/, "") + p;
  const res = await fetch(url, { ...opts, headers: { "Content-Type": "application/json", ...(opts.headers || {}) } });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

const cleanup = [];
let pass = 0, fail = 0;

function tc(name, ok, detail) {
  if (ok) {
    console.log(`  OK   ${name}`);
    pass++;
  } else {
    console.log(`  FAIL ${name}`);
    if (detail !== undefined) console.log(`       -> ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 400)}`);
    fail++;
  }
}

(async () => {
  console.log("=== local hook smoke test ===");
  console.log("Target:", PB_URL);
  console.log("");

  // ── Reachability ────────────────────────────────────────────
  const health = await api("/api/health");
  if (health.status !== 200) {
    console.error("PB not reachable at", PB_URL, "— start it before running this script.");
    console.error("       This usually means hook parse failure too — check journalctl / PB stdout.");
    process.exit(1);
  }
  console.log("PB reachable.\n");

  // ── Auth ────────────────────────────────────────────────────
  const auth = await api("/api/collections/users/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
  });
  if (auth.status !== 200) {
    console.error("Auth failed:", auth.status, auth.body);
    process.exit(1);
  }
  const headers = { Authorization: "Bearer " + auth.body.token };
  console.log("Authenticated as:", auth.body.record.id, "\n");

  // ── TC1: PWA-style create with companyId → defect_id assigned ──
  console.log("[TC1] PWA-style create (companyId set)");
  {
    const r = await api("/api/collections/defects/records", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "TC1 PWA " + Date.now(),
        severity: "Minor",
        status: "Open",
        companyId: COMPANY_ID,
        projectId: PROJECT_ID,
        comments: [],
      }),
    });
    tc("create returns 200", r.status === 200, r.body);
    tc("companyId preserved", r.body.companyId === COMPANY_ID, r.body.companyId);
    tc("defect_id assigned", typeof r.body.defect_id === "string" && r.body.defect_id.startsWith("DEF-"), r.body.defect_id);
    if (r.body.id) cleanup.push(r.body.id);
  }
  console.log("");

  // ── TC2: bridge-style create WITHOUT companyId → autofill ──
  console.log("[TC2] Bridge-style create (no companyId)");
  let bridgeId = null;
  {
    const r = await api("/api/collections/defects/records", {
      method: "POST",
      headers,
      body: JSON.stringify({
        title: "TC2 bridge " + Date.now(),
        severity: "Minor",
        status: "Open",
        projectId: PROJECT_ID,
        comments: [],
        // intentionally no companyId
      }),
    });
    tc("create returns 200", r.status === 200, r.body);
    tc("companyId auto-filled to user's company", r.body.companyId === COMPANY_ID, { got: r.body.companyId, want: COMPANY_ID });
    tc("defect_id assigned", typeof r.body.defect_id === "string" && r.body.defect_id.startsWith("DEF-"), r.body.defect_id);
    if (r.body.id) { bridgeId = r.body.id; cleanup.push(r.body.id); }
  }
  console.log("");

  // ── TC3: bridge-style update (no comments grown) → server appends event ──
  console.log("[TC3] Bridge-style update (server should emit audit event)");
  if (bridgeId) {
    // Re-read original comments length.
    const before = await api(`/api/collections/defects/records/${bridgeId}`, { headers });
    const beforeComments = Array.isArray(before.body.comments) ? before.body.comments : [];
    const beforeLen = beforeComments.length;

    const r = await api(`/api/collections/defects/records/${bridgeId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ status: "In Progress" }),
    });
    tc("update returns 200", r.status === 200, r.body);

    const after = Array.isArray(r.body.comments) ? r.body.comments : [];
    tc("comments grew by 1", after.length === beforeLen + 1, { before: beforeLen, after: after.length });
    const last = after[after.length - 1] || {};
    tc("appended row is kind:event", last.kind === "event", last);
    tc("event type=status, from=Open, to=In Progress", last.type === "status" && last.from === "Open" && last.to === "In Progress", last);
    tc("event _src=server (origin tag)", last._src === "server", last);
  } else {
    tc("bridgeId available for update", false, "TC2 didn't yield an id");
  }
  console.log("");

  // ── TC4: client-style update (comments already grown) → server skips ──
  console.log("[TC4] Client-style update (comments already grown — server should skip)");
  if (bridgeId) {
    const before = await api(`/api/collections/defects/records/${bridgeId}`, { headers });
    const beforeComments = Array.isArray(before.body.comments) ? before.body.comments : [];
    const beforeLen = beforeComments.length;

    // Client emits its own kind:"event" row in the same patch.
    const clientEvent = {
      kind: "event", type: "severity", from: "Minor", to: "Major",
      by: "client-tester", role: "Inspector", at: Date.now(), _src: "client"
    };
    const r = await api(`/api/collections/defects/records/${bridgeId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        severity: "Major",
        comments: beforeComments.concat([clientEvent]),
      }),
    });
    tc("update returns 200", r.status === 200, r.body);

    const after = Array.isArray(r.body.comments) ? r.body.comments : [];
    tc("comments grew by exactly 1 (no double-emit)", after.length === beforeLen + 1, { before: beforeLen, after: after.length });
    const last = after[after.length - 1] || {};
    tc("last row kept _src=client (server didn't overwrite)", last._src === "client", last);
  } else {
    tc("bridgeId available for update", false, "TC2 didn't yield an id");
  }
  console.log("");

  // ── Cleanup ────────────────────────────────────────────────
  if (cleanup.length) {
    console.log(`Cleanup: deleting ${cleanup.length} test defects...`);
    for (const id of cleanup) {
      try { await api(`/api/collections/defects/records/${id}`, { method: "DELETE", headers }); } catch {}
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Pass: ${pass}`);
  console.log(`Fail: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
