#!/usr/bin/env node
// Smoke test for RBAC rules — authenticates as a tester app user (NOT a
// superuser) and attempts list + create on every collection in the chosen
// phase. Run BEFORE applying RBAC to a new phase, and AFTER each apply, to
// confirm the rules don't accidentally lock out legitimate writers.
//
// Pass criteria per collection:
//   list:   HTTP 200 (any items count is fine — empty is fine)
//   create: HTTP 2xx (success), OR HTTP 400 with field-level errors
//           (means the rule passed, validation rejected — that's OK)
//   FAIL:   HTTP 401 (auth lost) or 403 (rule rejected) on either op
//
// Usage:
//   $env:PB_URL='https://api.siteshrimp.org'
//   $env:PB_USER_EMAIL='<tester app email>'
//   $env:PB_USER_PASSWORD='<tester password>'
//   $env:PHASE='3'           # or 1, 2a, 2b, 4
//   node tools/smoke-rbac.js
//
// The tester user must have a `members` row matching their `userId` with a
// `role` of Admin or Manager so create attempts pass the role guard. For
// reads, any role works.

const PB_URL = process.env.PB_URL;
const EMAIL = process.env.PB_USER_EMAIL;
const PASSWORD = process.env.PB_USER_PASSWORD;
const PHASE = process.env.PHASE;

if (!PB_URL || !EMAIL || !PASSWORD || !PHASE) {
  console.error("Requires PB_URL, PB_USER_EMAIL, PB_USER_PASSWORD, PHASE env vars.");
  process.exit(1);
}

// Mirror of PHASE_COLLECTIONS in tools/migrate-rbac.js. Keep in sync.
const PHASE_COLLECTIONS = {
  "1": ["ontology_components", "ontology_defect_types", "ontology_checkpoints", "ontology_trades", "counters", "location_presets", "component_presets", "map_markups"],
  "2a": ["companies", "members"],
  "2b": ["invites"],
  "3": ["projects", "drawings"],
  "4": ["defects", "activity", "conquas_observations", "pins", "map_pins", "settings"],
};

// Per-collection minimal create body. These hit the create rule and either
// succeed (2xx) or fail with field-level validation (400 with `data.<field>`)
// — both prove the rule passed. Anything else (401/403) means the rule blocks.
// Cleanup: every successful create record id is collected and deleted at end.
const CREATE_BODY = {
  projects: () => ({ name: "smoke-test-" + Date.now() }),
  drawings: () => ({ name: "smoke-" + Date.now() }),
  defects: () => ({ title: "smoke-" + Date.now(), severity: "Minor", status: "Open" }),
  activity: () => ({ kind: "smoke" }),
  conquas_observations: () => ({}),
  pins: () => ({}),
  map_pins: () => ({}),
  map_markups: () => ({}),
  settings: () => ({}),
  location_presets: () => ({ label: "smoke-" + Date.now() }),
  component_presets: () => ({ label: "smoke-" + Date.now() }),
  counters: () => ({ key: "smoke-" + Date.now() }),
  ontology_components: () => ({}),
  ontology_defect_types: () => ({}),
  ontology_checkpoints: () => ({}),
  ontology_trades: () => ({}),
  companies: () => ({ name: "smoke-" + Date.now() }),
  members: () => ({}),
  invites: () => ({}),
};

async function api(p, opts = {}) {
  const res = await fetch(PB_URL.replace(/\/$/, "") + p, {
    ...opts,
    headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
  });
  const text = await res.text();
  let body;
  try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: res.status, body };
}

(async () => {
  console.log("=== SiteShrimp RBAC smoke test ===");
  console.log("Target:", PB_URL);
  console.log("User:", EMAIL);
  console.log("Phase:", PHASE);
  console.log("");

  const targets = PHASE_COLLECTIONS[PHASE];
  if (!targets) {
    console.error(`Unknown PHASE: ${PHASE}. Valid: 1, 2a, 2b, 3, 4`);
    process.exit(1);
  }

  // Auth as the tester user (NOT superuser).
  const auth = await api("/api/collections/users/auth-with-password", {
    method: "POST",
    body: JSON.stringify({ identity: EMAIL, password: PASSWORD }),
  });
  if (auth.status !== 200) {
    console.error("Auth failed:", auth.status, auth.body);
    process.exit(1);
  }
  const token = auth.body.token;
  const userId = auth.body.record?.id;
  const headers = { Authorization: "Bearer " + token };
  console.log("Authenticated as:", userId);
  console.log("");

  const created = []; // { name, id } for cleanup
  let pass = 0, fail = 0;

  for (const name of targets) {
    process.stdout.write(`--- ${name}\n`);

    // LIST
    const list = await api(`/api/collections/${name}/records?perPage=1`, { headers });
    const listOk = list.status === 200;
    process.stdout.write(`  list:   ${list.status} ${listOk ? "PASS" : "FAIL"}\n`);
    if (!listOk) {
      process.stdout.write(`    -> ${JSON.stringify(list.body).slice(0, 200)}\n`);
      fail++;
      continue;
    }

    // CREATE — body builder returns minimal payload; rule pass = 2xx OR 400-with-fields.
    const builder = CREATE_BODY[name] || (() => ({}));
    const create = await api(`/api/collections/${name}/records`, {
      method: "POST",
      headers,
      body: JSON.stringify(builder()),
    });
    const createOk =
      (create.status >= 200 && create.status < 300) ||
      (create.status === 400 && create.body && typeof create.body.data === "object" && Object.keys(create.body.data).length > 0);
    process.stdout.write(`  create: ${create.status} ${createOk ? "PASS" : "FAIL"}\n`);
    if (!createOk) {
      process.stdout.write(`    -> ${JSON.stringify(create.body).slice(0, 200)}\n`);
      fail++;
    } else {
      pass++;
      if (create.status >= 200 && create.status < 300 && create.body?.id) {
        created.push({ name, id: create.body.id });
      }
    }
  }

  // Cleanup any records we created (best-effort).
  if (created.length > 0) {
    console.log("\nCleanup: deleting", created.length, "smoke-created records...");
    for (const c of created) {
      try {
        await api(`/api/collections/${c.name}/records/${c.id}`, { method: "DELETE", headers });
      } catch {}
    }
  }

  console.log("");
  console.log("=== Summary ===");
  console.log(`Pass: ${pass}`);
  console.log(`Fail: ${fail}`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error("FAIL:", e.message); process.exit(1); });
