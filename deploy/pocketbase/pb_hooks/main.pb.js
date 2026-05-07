/// <reference path="../pb_data/types.d.ts" />

// SiteShrimp PocketBase Hooks
// Runs server-side inside PocketBase (JavaScript ES5)
//
// Features:
//   - Auto-generate defect IDs (DEF-0001, DEF-0002, ...)
//   - AI photo analysis (Gemini, Ollama, OpenAI) on upload
//   - Local path storage (copy photos to user-specified folder)
//   - Auto-set timestamps

// ====== RATE LIMITER ======
// Simple in-memory rate limiter (per IP, resets on restart)
var _rateLimits = {};
function rateLimit(key, maxPerMinute) {
  var now = Date.now();
  if (!_rateLimits[key]) _rateLimits[key] = [];
  // Remove entries older than 60s
  _rateLimits[key] = _rateLimits[key].filter(function(t) { return now - t < 60000; });
  if (_rateLimits[key].length >= maxPerMinute) return false;
  _rateLimits[key].push(now);
  return true;
}

// ====== PER-COMPANY STORAGE CAP ======
// Hard cap on per-company file storage. Rejects uploads that would exceed.
// Bounds the worst-case per-company storage cost on the shared instance and
// prevents siteshrimp.org from accidentally becoming any team's permanent home.
// Tune COMPANY_STORAGE_CAP_BYTES per the operator's hosting budget.
var COMPANY_STORAGE_CAP_BYTES = 1024 * 1024 * 1024; // 1 GB

function getCompanyStorageBytes(companyId) {
  var sql = "SELECT COALESCE(SUM(json_extract(value, '$.size')), 0) AS total " +
            "FROM defects, json_each(json_array(photo, photoOriginal, costDoc)) " +
            "WHERE companyId = {:cid}";
  try {
    var row = $app.db().newQuery(sql).bind({"cid": companyId}).one();
    return row && row.total ? parseInt(row.total) : 0;
  } catch (e) {
    return 0;
  }
}

onRecordCreateRequest((e) => {
  if (e.collection.name !== "defects") return e.next();

  // Compute cap decision defensively — any JS/SQL error here must NOT
  // propagate, or PocketBase returns a generic 400 and blocks legitimate
  // uploads. Only a confirmed over-cap result should reject the request.
  var overCap = false;
  try {
    var companyId = e.record.get("companyId");
    if (companyId) {
      var incomingBytes = 0;
      ["photo", "photoOriginal", "costDoc"].forEach(function (field) {
        try {
          var files = e.record.get(field);
          if (!files) return;
          if (!Array.isArray(files)) files = [files];
          for (var i = 0; i < files.length; i++) {
            var f = files[i];
            if (f && typeof f.size === "number") incomingBytes += f.size;
          }
        } catch (_) { /* unknown field shape — skip */ }
      });

      var currentBytes = getCompanyStorageBytes(companyId);
      if (currentBytes + incomingBytes > COMPANY_STORAGE_CAP_BYTES) {
        overCap = true;
      }
    }
  } catch (err) {
    console.log("Storage cap hook error (allowing request):", err);
  }

  if (overCap) {
    throw new BadRequestError(
      "Storage cap reached (1 GB). Please migrate to your own server " +
      "(Settings -> Storage & Hosting -> Path 2 or Path 3) or delete old defects."
    );
  }
  return e.next();
}, "defects");

// ====== AUTO DEFECT ID ======

onRecordCreate((e) => {
  const record = e.record;

  // Generate next defect ID atomically
  if (!record.get("defect_id")) {
    let counter = 0;
    try {
      const counterRecord = $app.findFirstRecordByFilter("counters", "key = 'defect_counter'");
      counter = counterRecord.getInt("value") + 1;
      counterRecord.set("value", counter);
      $app.save(counterRecord);
    } catch {
      // Counter doesn't exist yet — create it
      counter = 1;
      const collection = $app.findCollectionByNameOrId("counters");
      const newCounter = new Record(collection);
      newCounter.set("key", "defect_counter");
      newCounter.set("value", 1);
      $app.save(newCounter);
    }
    const id = "DEF-" + String(counter).padStart(4, "0");
    record.set("defect_id", id);
  }

  // Auto-set timestamp if not provided
  if (!record.get("timestamp_utc")) {
    record.set("timestamp_utc", new Date().toISOString());
  }

  // Default status
  if (!record.get("status")) {
    record.set("status", "Open");
  }

  // Default input source
  if (!record.get("input_source")) {
    record.set("input_source", "pwa");
  }

  // Autofill companyId from the requesting user's membership when missing.
  // The Telegram bridge sets only projectId; without this, bridge-created
  // defects are tenant-orphaned and become invisible once RBAC tightens
  // tenant-isolation rules. Also defends any future direct-REST writers.
  if (!record.get("companyId")) {
    try {
      var authUser = e.auth;
      if (authUser) {
        var mem = $app.findFirstRecordByFilter("members", 'userId="' + authUser.id + '"');
        if (mem) record.set("companyId", mem.getString("companyId"));
      }
    } catch (err) {
      console.log("companyId autofill skipped:", err);
    }
  }

  return e.next();
}, "defects");

// ====== AUDIT LOG PHASE 2: server-side onRecordUpdate auto-emit ======
// Catches direct REST writes to defects (Telegram bridge, future public
// API, anything that bypasses js/app.js) and emits kind:"event" rows
// into the same `comments` JSON array the Defect Detail timeline reads.
// Mirrors the client-side diffDefectEvents() in js/app.js so the audit
// surface is uniform regardless of writer.
//
// Dedup: if the client already appended events (newComments.length grew
// during this update), we assume the client emitted and skip. The PWA
// patches comments + fields together; bridge/REST writers don't touch
// comments at all, so the length-grew check is a reliable origin signal.

var TRACKED_EVENT_FIELDS_HOOK = [
  "status", "severity", "assignee", "dueDate", "duration",
  "component", "issue", "trade", "entryType", "workCategory",
  "location", "locationLevel", "locationZone", "locationSubzone", "locationGrid",
  "costImpact", "costResponsible", "costAmount"
];

onRecordUpdate((e) => {
  if (e.collection.name !== "defects") return e.next();

  try {
    var record = e.record;
    var original = record.original();
    if (!original) return e.next();

    // If the client already appended events (e.g. PWA emitted via
    // diffDefectEvents), let it own the audit row to avoid duplicates.
    var origComments = original.get("comments") || [];
    var newComments = record.get("comments") || [];
    if (!Array.isArray(origComments)) origComments = [];
    if (!Array.isArray(newComments)) newComments = [];
    if (newComments.length > origComments.length) return e.next();

    // Resolve actor from auth context, fall back to email.
    var by = "";
    var role = "";
    var authUser = e.auth;
    if (authUser) {
      try {
        var mem = $app.findFirstRecordByFilter("members", 'userId="' + authUser.id + '"');
        if (mem) {
          by = mem.getString("name") || authUser.getString("email") || "";
          role = mem.getString("role") || "";
        } else {
          by = authUser.getString("email") || "";
        }
      } catch (_) {
        by = authUser.getString("email") || "";
      }
    }

    // Diff tracked fields and append events.
    var newEvents = [];
    var at = Date.now();
    for (var i = 0; i < TRACKED_EVENT_FIELDS_HOOK.length; i++) {
      var f = TRACKED_EVENT_FIELDS_HOOK[i];
      var a = (original.get(f) == null ? "" : String(original.get(f))).trim();
      var b = (record.get(f) == null ? "" : String(record.get(f))).trim();
      if (a === b) continue;
      newEvents.push({
        kind: "event", type: f, from: a, to: b,
        by: by, role: role, at: at, _src: "server"
      });
    }

    if (newEvents.length > 0) {
      record.set("comments", newComments.concat(newEvents));
    }
  } catch (err) {
    console.log("audit emit skipped:", err);
  }

  return e.next();
}, "defects");

// ====== LOCAL PATH STORAGE (copy photos to user-specified folder) ======

onRecordAfterCreateSuccess((e) => {
  const record = e.record;
  const storageMode = record.get("storageMode");
  const storagePath = record.get("storagePath");
  const photo = record.get("photo");

  if (storageMode !== "local" || !storagePath || !photo) return;

  try {
    // Ensure target directory exists
    $os.mkdirAll(storagePath, 0o755);

    // Read photo from PocketBase storage and copy to local path
    const fsys = $app.newFilesystem();
    const photos = Array.isArray(photo) ? photo : [photo];

    for (var i = 0; i < photos.length; i++) {
      var fileName = photos[i];
      var fileKey = record.baseFilesPath() + "/" + fileName;
      try {
        var reader = fsys.getFile(fileKey);
        var photoBytes = reader.readAll();
        reader.close();

        // Build destination: storagePath/defectId/filename
        var destDir = storagePath + "/" + record.getId();
        $os.mkdirAll(destDir, 0o755);
        $os.writeFile(destDir + "/" + fileName, photoBytes, 0o644);
      } catch (copyErr) {
        console.log("Local storage copy failed for " + fileName + ":", copyErr);
      }
    }
    fsys.close();
  } catch (err) {
    console.log("Local path storage failed:", err);
  }
}, "defects");

// ====== STORAGE TEST ENDPOINT ======
// Lets users test if a local path is writable

routerAdd("POST", "/api/storage/test", (e) => {
  var ip = e.request.remoteAddr || "unknown";
  if (!rateLimit("storage_test_" + ip, 10)) {
    return e.json(429, { error: "Too many requests. Try again in a minute." });
  }
  var body = e.request.body;
  var path = "";
  try {
    var data = JSON.parse($toString(body));
    path = data.path || "";
  } catch {}

  if (!path) {
    return e.json(400, { error: "No path provided" });
  }

  try {
    $os.mkdirAll(path, 0o755);
    // Write a test file and clean up
    var testFile = path + "/.siteshrimp_test";
    $os.writeFile(testFile, "test", 0o644);
    $os.remove(testFile);
    return e.json(200, { ok: true, path: path });
  } catch (err) {
    return e.json(400, { error: "Path not writable: " + err });
  }
});

// ====== AI ANALYSIS (multi-provider: Gemini, Ollama, OpenAI) ======

// SiteShrimp uses BCA CONQUAS Internal Finishes (IF) vocabulary for residential
// and interior building defects. The 7 IF elements (Floor, Wall, Ceiling, Door,
// Window, Component, M&E Fittings) are derived client-side via conquasElementOf()
// from the chosen `category`, so the AI does not need to emit element/checkpoint
// fields directly — picking the right category from the list below makes the
// CONQUAS grouping (REVIEW > Group by CONQUAS) and ZIP export route the entry
// to the correct IF folder automatically.
//
// Severity vocabulary mirrors js/constants.js SEVERITY ("Critical","Major",
// "Minor","Observation"). Do NOT introduce "High/Medium/Low" — those values
// don't map to any color, status chip, or filter on the client.
// Bumped on every meaningful prompt change so consumers can correlate
// AI output drift with prompt edits via the ai_prompt_version column.
// Semver: minor for additive fields (1.0.0 -> 1.1.0); major for breaking
// vocabulary changes. Stamped onto every AI-prefilled defect record.
var AI_PROMPT_VERSION = "1.1.0";

var AI_SERVER_PROMPT = [
  "You are a CONQUAS-aware defect inspector for construction sites, residential building defects (HDB / private), and facilities management. Analyze this photo.",
  "Return ONLY a JSON object with these eleven fields: category, defect_type, severity, trade, location, description, conquas_tier, checkpoint_match, title, assessment_zone, confidence. The first four are mandatory; the rest may be null when not applicable.",
  "Categories: Column, Beam, Slab, Door, Window, Wall, Floor, Ceiling, Roof,",
  "Plumbing, Electrical, Aircon, Painting, Tiling, Waterproofing, Cabinet, General.",
  "Pick the category that maps to a BCA CONQUAS Internal-Finishes element when the photo shows interior finishing work:",
  "Floor / Wall / Ceiling / Door / Window for surfaces; Cabinet for joinery and component (sanitary ware, vanity, wardrobe);",
  "Plumbing / Electrical / Aircon for M&E fittings. Use Column / Beam / Slab / Roof for structural or external work.",
  "For defect_type, use BCA Good Industry Practice terminology where applicable (e.g. hollowness / lippage / delamination for tiling; peeling / bubbling / brush marks for painting; bulging / cracking / dampness for waterproofing; misalignment / chipping for joinery).",
  "Severity: Critical, Major, Minor, Observation. Map CONQUAS tiers — 3X (functional, high impact) -> Critical or Major; 2X (functional) -> Major or Minor; 1X (finishings) -> Minor or Observation.",
  "Optionally include conquas_tier (\"1X\", \"2X\" or \"3X\") and checkpoint_match (verbatim CONQUAS checkpoint label closest to the defect, e.g. \"Hollowness (for tiled wall as long as it is hollow)\") when the photo shows residential interior finishing work covered by the BCA CONQUAS Private Residential 2025 manual. Use null for both when not applicable (structural, external, or non-residential work).",
  "title: short 4-8 word label summarising the defect, written for a defect-list row (e.g. \"Hollow tile, kitchen wall\"). Distinct from description, which is the longer narrative. Use null only when the photo is unanalysable.",
  "assessment_zone: which CONQUAS-21 stream applies — \"Architectural\" for finishes / fittings / joinery / non-structural; \"Structural\" for column / beam / slab / wall (load-bearing); \"M&E\" for plumbing / electrical / aircon / fire / lift. Use null only for safety / site-condition photos with no CONQUAS scoring stream.",
  "confidence: your overall confidence in this row's category + defect_type + severity classification, as a number between 0.0 and 1.0. Use 0.9+ when photo is clear and defect type is unambiguous; 0.5-0.7 when defect type is plausible but photo angle / lighting limits certainty; below 0.4 when guessing. Downstream pipelines threshold on this for auto-accept vs human-review queues.",
].join(" ");

// Engine-agnostic JSON schema bound to AI providers via responseSchema (Gemini)
// or response_format json_schema (OpenAI / Groq / Mistral / OpenRouter).
//
// All properties listed in `required` because OpenAI strict mode
// (response_format json_schema with strict: true) refuses any object schema
// where a property is not required. Optional fields use type: ["string","null"]
// (or ["number","null"]) so the model can emit explicit null when it has no value.
var AI_OUTPUT_SCHEMA = {
  type: "object",
  required: [
    "category", "defect_type", "severity", "trade",
    "location", "description", "conquas_tier", "checkpoint_match",
    "title", "assessment_zone", "confidence"
  ],
  properties: {
    category:    { type: "string", enum: [
      "Column","Beam","Slab","Door","Window","Wall","Floor","Ceiling",
      "Roof","Plumbing","Electrical","Aircon","Painting","Tiling",
      "Waterproofing","Cabinet","General"
    ]},
    defect_type: { type: "string" },
    severity:    { type: "string", enum: ["Critical","Major","Minor","Observation"] },
    trade:       { type: "string" },
    location:    { type: ["string","null"] },
    description: { type: ["string","null"] },
    conquas_tier:     { type: ["string","null"], enum: ["1X","2X","3X",null] },
    checkpoint_match: { type: ["string","null"] },
    title:            { type: ["string","null"] },
    assessment_zone:  { type: ["string","null"], enum: ["Architectural","Structural","M&E",null] },
    confidence:       { type: ["number","null"], minimum: 0, maximum: 1 }
  },
  additionalProperties: false
};

// Variant routing — mirrors schema/entries/manifest.json's ai_prompt_hint
// and extra_columns. Kept inline here so the hook is self-contained
// (no path-resolution dance to load the manifest at runtime). When you
// add a variant to manifest.json, mirror it here. The schema-check tool
// validates the schema-side; this side is honor-system for now.
var AI_VARIANT_TABLE = {
  "CONQUAS": {
    addendum: "CONQUAS-aware mode: emit assessment_zone (\"Architectural\" / \"Structural\" / \"M&E\") for every photo. Use BCA Good Industry Practice defect-type vocabulary verbatim.",
    fields: [
      { property: "inspection_lot",  type: "string" }
    ]
  },
  "Building Defects (Landed)": {
    addendum: "Landed-house mode: when storey count is visible from the photo, emit storey_count (\"1-storey\" / \"2-storey\" / \"3-storey\" / \"4-storey or more\"). When the photo shows a wall that may be a party wall (terrace / cluster / semi-detached), note party_wall_side (\"None\" / \"Left\" / \"Right\" / \"Both\"). When roof typology is visible, emit roof_type (\"Pitched\" / \"Flat\" / \"Mixed\").",
    fields: [
      { property: "storey_count",    type: "string", enum: ["1-storey","2-storey","3-storey","4-storey or more"] },
      { property: "party_wall_side", type: "string", enum: ["None","Left","Right","Both"] },
      { property: "roof_type",       type: "string", enum: ["Pitched","Flat","Mixed"] }
    ]
  },
  "Building Defects (Highrise)": {
    addendum: "Highrise mode: when a block / tower sign or unit number is visible, emit block_or_tower / unit_no. Identify vertical_zone (Lobby / Lift Core / Corridor / Unit Interior / Common Area / Carpark / Refuse / Plant Room / Roof) from visible context.",
    fields: [
      { property: "block_or_tower",  type: "string" },
      { property: "unit_no",         type: "string" },
      { property: "vertical_zone",   type: "string", enum: ["Lobby","Lift Core","Corridor","Unit Interior","Common Area","Carpark","Refuse","Plant Room","Roof"] }
    ]
  },
  "Construction Site": {
    addendum: "Construction Site / WSH mode: this is workplace-safety analysis, NOT contractual-defect grading. Re-interpret severity as injury risk: Critical = fatal / serious-injury risk, Major = lost-time injury, Minor = first-aid, Observation = near-miss. Always emit hazard_category from {Working at Heights / Scaffolding / Electrical / Confined Space / Hot Work / Chemicals / Falling Objects / Mobile Plant / Manual Handling / Site Condition / Other}. Emit ppe_compliance only if workers are visible. Emit stop_work_recommended=true only when severity is Critical AND active work is visible. Emit workers_exposed as a count when applicable.",
    fields: [
      { property: "hazard_category", type: "string", enum: ["Working at Heights","Scaffolding","Electrical","Confined Space","Hot Work","Chemicals","Falling Objects","Mobile Plant","Manual Handling","Site Condition","Other"] },
      { property: "ppe_compliance",  type: "string", enum: ["Compliant","Partial","Non-Compliant","N/A"] },
      { property: "stop_work_recommended", type: "boolean" },
      { property: "workers_exposed", type: "integer" }
    ]
  },
  "Interior Works": {
    addendum: "Interior Works mode: emit trade_subscope from {Carpentry / Painting / Tiling / M&E – Electrical / M&E – Plumbing / M&E – ACMV / Wallpaper / Glass / Mirror / Stone / Wood Flooring / Other} based on the affected trade. Permit numbers are user-supplied — leave permit_no null unless visible in the photo.",
    fields: [
      { property: "trade_subscope",  type: "string", enum: ["Carpentry","Painting","Tiling","M&E – Electrical","M&E – Plumbing","M&E – ACMV","Wallpaper","Glass / Mirror","Stone","Wood Flooring","Other"] },
      { property: "permit_no",       type: "string" }
    ]
  },
  "Facilities Management": {
    addendum: "Facilities Management mode: this is in-operation maintenance, NOT defect-liability inspection. Always emit service_category from {HVAC / Plumbing / Electrical / Fire Safety / Lift / Cleaning / Pest Control / Landscape / Security / General}. Emit maintenance_type from {Preventive / Reactive / Corrective / Breakdown / Inspection} based on the work nature. Asset IDs are owner-private — leave asset_id null unless an asset tag is visible.",
    fields: [
      { property: "service_category",  type: "string", enum: ["HVAC","Plumbing","Electrical","Fire Safety","Lift","Cleaning","Pest Control","Landscape","Security","General"] },
      { property: "maintenance_type",  type: "string", enum: ["Preventive","Reactive","Corrective","Breakdown","Inspection"] },
      { property: "asset_id",          type: "string" }
    ]
  },
  "Infrastructure Works": {
    addendum: "Infrastructure Works mode: this is civil / linear-asset inspection, NOT building defect. Always emit asset_class from {Road / Drainage / Linkway / External Works / Bridge / Tunnel / Culvert / Manhole / Other}. Emit chainage_km only for linear assets when a km marker is visible. Emit structure_id only when a structure-ID plate is visible. Severity remains Critical / Major / Minor / Observation interpreted as structural / serviceability impact.",
    fields: [
      { property: "asset_class",     type: "string", enum: ["Road","Drainage","Linkway","External Works","Bridge","Tunnel","Culvert","Manhole","Other"] },
      { property: "chainage_km",     type: "number" },
      { property: "structure_id",    type: "string" }
    ]
  },
  // BCA Temporary Occupation Permit readiness — verbatim NC categories +
  // Approved Document / COA / TRSS clause references for QP traceability.
  // Sources: BCA BPTOP industry sharing 2026 items 1-5 (Audit & Inspection
  // Group), CSCTOP Form Companion v1.0 29 Apr 2026, Approved Document
  // Ver 7.08 effective 1 Oct 2025. Variant schema lives at
  // /schema/entries/top/v1.json. Severity is reinterpreted as TOP impact:
  // Critical = blocks TOP, Major = NC requiring rectification, Minor =
  // advisory, Observation = informational.
  "TOP Inspection": {
    addendum: "TOP Inspection mode: BCA Temporary Occupation Permit readiness check, NOT contractual-defect grading. Reinterpret severity as TOP impact — Critical = blocks TOP (rectify before BCA inspection), Major = NC requiring rectification, Minor = advisory, Observation = informational. Always emit top_nc_category VERBATIM from the listed enum. Emit top_clause_ref using verbatim BCA clause notation: AD §C cl. C.3.2.1 (headroom >=2.0 m); AD §E cl. E.3.4.4 + COA 4.11.2 (staircase uniform within 5 mm, non-slip nosing 50-65 mm permanent contrasting, tape NOT acceptable); AD §H cl. H.3.2.1 / H.3.4A.1 (barrier >=1 m, >=850 mm from last toehold); AD §H cl. H.3.4.1, H.3.4.3a (gap >=75 mm at lowest part, opening must not pass 100 mm sphere non-industrial); AD §L cl. 3.1 (LPS per SS 555); COA cl. 2.1.1, 4.2.1, 4.5.2, 5.2.1 (accessibility); TRSS 2.12.1(e), 2.12.2 (storey shelter — no openings except 2 vent sleeves + MV; fire door opens away from staircase at fire discharge level); ES Code 4th ed. NRB02-2 (self-closing doors / vestibules / ANSI-AMCA 220 air-curtain >=2.0 m/s); NRB06-1 (chiller >=1.5 m), NRB06-4 (AHU >35 kW floor mount per SS 553); BC (FI) Regs 2025 (sheltered passage 1.0 x 2.0 m, lift refuge spaces). Emit top_threshold_breached when a measurement is visible (e.g. 'headroom 1850 mm < 2000 mm', 'barrier gap 95 mm > 75 mm'). Set top_readiness_gate=true when the NC is a TOP blocker; false for advisory NCs.",
    fields: [
      { property: "top_nc_category",       type: "string", enum: ["Lightning Protection System","Headroom & Ceiling Height","Safety from Falling — barriers","Safety from Falling — gaps","Staircase","Accessible Washrooms / Doorways / Ramps","Accessible Route Provision","Accessible Route Width","Mode of Ventilation","Env. Sustainability — NRB02 (door / vestibule)","Env. Sustainability — NRB06 (chiller / pump / cooling tower / AHU)","Storey Shelter (S/C SS)","Fixed Installations (Lifts / Escalators / MCPS)","Glass safety barrier","Site Readiness","Other"] },
      { property: "top_clause_ref",        type: "string" },
      { property: "top_threshold_breached", type: "string" },
      { property: "top_readiness_gate",    type: "boolean" },
      { property: "top_phase",             type: "string", enum: ["TOP","CSC","Pre-TOP self-audit","Phased TOP","Re-inspection"] }
    ]
  },
  // BCA Buildable Design Score (B-Score) per COP 2022. Picking this work
  // category puts the AI in design / system-observation mode, NOT defect
  // grading. Source: BCA Code of Practice on Buildability, 1 May 2022 ed.
  // Variant schema: /schema/entries/buildability/v1.json. The B-Score
  // calculator (Manpower Allocation × Point Allocation per Block × Min
  // B-Score per project category) lives at the project level — not here.
  // This variant captures site-observation evidence the calculator needs.
  "Buildability Assessment": {
    addendum: "Buildability Assessment mode: BCA Buildable Design Score (B-Score) per COP 2022 — design / system-observation, NOT contractual-defect grading. Reinterpret severity as buildability impact — Critical = below MIN B-SCORE gate for the project category (project cannot be approved without redesign), Major = significant labour penalty / wet-trade where prefab specified, Minor = inefficient detail or coordination clash, Observation = informational. Identify project_category from {Residential (Landed), Private Residential (Non-Landed), Public Residential (Non-Landed), Industrial, Commercial, Institutional, School & Others, MRT Station} — verbatim COP 2022 Manpower Allocation table names; this drives which weightage column applies (e.g. PPVC = 35 pts for Private Residential vs 45 pts for Public Residential). From the photo, identify structural_system from {PPVC, MET / Hybrid MET, Structural Steel / Hybrid, APCS - Advanced Precast Concrete System, Prefab Slab+Column+Wall, Prefab Column/Wall+Beam, Prefab Column/Wall only, Prefab Slab only, Flat Plate / Flat Slab, Beam-Slab} — verbatim COP 2022 Point Allocation Section A names. Identify wall_system from {PPVC, Prefabricated and prefinished wall with MEP services, Prefabricated Bathroom Unit (PBU), Prefabricated and prefinished wall, Precast wall off-form, Drywall partition, Curtain wall / Full height glass partition, Precast wall, Lightweight concrete panel, Cast in-situ wall, Precision blockwall, Brickwall / blockwall} — verbatim COP 2022 Section B names. Identify mep_system from {PPVC, Prefabricated MEP modules integrated with structural, Prefabricated MEP vertical modules, Prefabricated MEP horizontal modules, Prefabricated MEP plant module, Flexible sprinkler dropper, Flexible water pipes, Common M&E bracket, Pre-insulated mechanical piping, Cast in-situ MEP services} — verbatim COP 2022 Section C MEP System names. Set prefab_evidence=true when off-site / modular construction is visible (lifting hooks, shear keys, joint grouting, factory-finished surfaces). Identify dfma_indicator from {Volumetric module, Panellised, Hybrid, Mostly cast-in-situ, Unclear}. Emit buildability_concern as free text when a wet-trade is being used where prefab/DfMA was specified or could substitute. Severity / title / description still emitted as base.",
    fields: [
      { property: "project_category",   type: "string", enum: ["Residential (Landed)","Private Residential (Non-Landed)","Public Residential (Non-Landed)","Industrial","Commercial","Institutional, School & Others","MRT Station"] },
      { property: "structural_system",  type: "string", enum: ["PPVC","MET / Hybrid MET","Structural Steel / Hybrid","APCS - Advanced Precast Concrete System","Prefab Slab+Column+Wall","Prefab Column/Wall+Beam","Prefab Column/Wall only","Prefab Slab only","Flat Plate / Flat Slab","Beam-Slab"] },
      { property: "wall_system",        type: "string", enum: ["PPVC","Prefabricated and prefinished wall with MEP services","Prefabricated Bathroom Unit (PBU)","Prefabricated and prefinished wall","Precast wall off-form","Drywall partition","Curtain wall / Full height glass partition","Precast wall","Lightweight concrete panel","Cast in-situ wall","Precision blockwall","Brickwall / blockwall"] },
      { property: "mep_system",         type: "string", enum: ["PPVC","Prefabricated MEP modules integrated with structural","Prefabricated MEP vertical modules","Prefabricated MEP horizontal modules","Prefabricated MEP plant module","Flexible sprinkler dropper","Flexible water pipes","Common M&E bracket","Pre-insulated mechanical piping","Cast in-situ MEP services"] },
      { property: "prefab_evidence",    type: "boolean" },
      { property: "dfma_indicator",     type: "string", enum: ["Volumetric module","Panellised","Hybrid","Mostly cast-in-situ","Unclear"] },
      { property: "buildability_concern", type: "string" }
    ]
  },
  // BCA Quality Mark for Good Workmanship per Guide on QM Scheme (Rev
  // 22 May 2025). Internal-finish quality of private residential. AI
  // tags every photo with the verbatim QM Architectural Item + Defect
  // Category so REPORT exports mirror the QM scoresheet rows. Major
  // defects are flagged separately because they are the ones that
  // would not be acceptable to homeowners (per the QM Guide). The QM
  // score calculator + tiered-rating gate (Star / Excellent / Merit)
  // are project-level features — out of scope for this AI variant.
  "Quality Mark Assessment": {
    addendum: "Quality Mark Assessment mode: BCA Quality Mark for Good Workmanship per Guide on QM Scheme (Rev 22 May 2025) — internal-finish quality assessment of private residential, NOT defect-liability grading. Reinterpret severity as QM impact — Critical = major defect (per QM Guide §2.9: missing/broken accessories, cracked/chipped/broken glass items, visibly cracked tiles/timber/ceiling/painted walls, functionally deficient doors / windows / wardrobes / cabinets / taps / WC / switches, fan-coil leaking, water seepage, misaligned door frame >3mm verticality), Major = scoring defect, Minor = scoring defect of lesser weightage, Observation = passes assessment. Always emit qm_arch_item VERBATIM from {Floor, Internal Wall, Ceiling, Door, Window, Component, M&E Fittings} — the seven QM Architectural Items. Always emit qm_defect_category VERBATIM from {Finishing, Alignment & Evenness, Crack & Damages, Hollowness, Jointing, Roughness, Joints & Gap, Material & Damages, Functionality, Accessories Defects} — note Hollowness applies only to Floor / Internal Wall, Roughness only to Ceiling, Jointing only to Floor / Internal Wall / Ceiling, and Joints & Gap / Material & Damages / Functionality / Accessories Defects only to Door / Window / Component / M&E Fittings. Set qm_major_defect=true when the issue matches any of the QM Guide §2.9 examples. Emit qm_inspection_type from {Internal Finish, Waterponding - Bathroom, Waterponding - Roof / Planter / Space-above-bedroom, Window Watertightness, In-Process - Waterproofing, In-Process - Stone Tiling, In-Process - Timber Flooring, In-Process - Window Installation} based on context. Emit qm_conquas_edition from {CONQUAS 9th Edition, CONQUAS 2019, CONQUAS 2022} — the QM weightage table differs by edition (CONQUAS 2022 applies to construction tenders called from 1 June 2022). Emit qm_dwelling_unit_no as a free-text identifier (block + unit, e.g. 'Blk 12 #08-103' or '#08-103') when visible in the photo or specified by the assessor — the QM threshold (85 / 80) and Tiered Rating average are computed per dwelling unit, so unit-level tagging is required for any aggregation. Set qm_household_shelter=true ONLY for photos taken inside a household shelter (HS) — the QM Internal Finish Assessment explicitly excludes household shelters per QM Guide §2.4(1), so flagged photos must be excluded from scoring. Title and description still emitted verbatim from base.",
    fields: [
      { property: "qm_arch_item",        type: "string", enum: ["Floor","Internal Wall","Ceiling","Door","Window","Component","M&E Fittings"] },
      { property: "qm_defect_category",  type: "string", enum: ["Finishing","Alignment & Evenness","Crack & Damages","Hollowness","Jointing","Roughness","Joints & Gap","Material & Damages","Functionality","Accessories Defects"] },
      { property: "qm_major_defect",     type: "boolean" },
      { property: "qm_inspection_type",  type: "string", enum: ["Internal Finish","Waterponding - Bathroom","Waterponding - Roof / Planter / Space-above-bedroom","Window Watertightness","In-Process - Waterproofing","In-Process - Stone Tiling","In-Process - Timber Flooring","In-Process - Window Installation"] },
      { property: "qm_conquas_edition",  type: "string", enum: ["CONQUAS 9th Edition","CONQUAS 2019","CONQUAS 2022"] },
      { property: "qm_dwelling_unit_no", type: "string" },
      { property: "qm_household_shelter", type: "boolean" }
    ]
  }
};

// Build a per-call prompt + JSON-output-schema based on the project's
// workCategory. Variant fields are added to required + properties as
// nullable types so the AI is allowed to emit explicit null when the
// field doesn't apply. The base 11-field shape is preserved for every
// call; variant fields ride additively. Returns { prompt, schema }.
function buildAiInputs(workCategory, description) {
  var prompt = AI_SERVER_PROMPT;
  // shallow clone schema so we never mutate the global
  var schema = {
    type: "object",
    required: AI_OUTPUT_SCHEMA.required.slice(),
    properties: {},
    additionalProperties: false
  };
  for (var k in AI_OUTPUT_SCHEMA.properties) schema.properties[k] = AI_OUTPUT_SCHEMA.properties[k];
  var variant = AI_VARIANT_TABLE[workCategory || ""];
  if (variant) {
    if (variant.addendum) prompt = prompt + " " + variant.addendum;
    for (var i = 0; i < variant.fields.length; i++) {
      var f = variant.fields[i];
      schema.required.push(f.property);
      var def = {};
      if (f.type === "number")       def.type = ["number","null"];
      else if (f.type === "boolean") def.type = ["boolean","null"];
      else if (f.type === "integer") def.type = ["integer","null"];
      else                            def.type = ["string","null"];
      if (Array.isArray(f.enum))      def.enum = f.enum.concat([null]);
      schema.properties[f.property] = def;
    }
  }
  prompt = prompt + " User context: " + (description || "") + " Project work category: " + (workCategory || "(unspecified)");
  return { prompt: prompt, schema: schema };
}

function analyzeWithGeminiServer(b64Photo, geminiKey, prompt, outputSchema) {
  var url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" + geminiKey;
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      contents: [{ parts: [
        { text: prompt },
        { inline_data: { mime_type: "image/jpeg", data: b64Photo } }
      ]}],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: outputSchema
      }
    }),
    timeout: 60,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return data.candidates[0].content.parts[0].text.trim();
  }
  return null;
}

function analyzeWithOllamaServer(b64Photo, ollamaUrl, ollamaModel, prompt) {
  var url = ollamaUrl.replace(/\/+$/, "") + "/api/generate";
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ollamaModel || "llava",
      prompt: prompt,
      images: [b64Photo],
      stream: false,
    }),
    timeout: 120,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return data.response || null;
  }
  return null;
}

function analyzeWithOpenAIServer(b64Photo, oaiUrl, oaiKey, oaiModel, prompt, outputSchema) {
  var url = oaiUrl.replace(/\/+$/, "") + "/v1/chat/completions";
  var res = $http.send({
    method: "POST",
    url: url,
    headers: { "Content-Type": "application/json", "Authorization": "Bearer " + oaiKey },
    body: JSON.stringify({
      model: oaiModel || "gpt-4o-mini",
      max_tokens: 500,
      response_format: {
        type: "json_schema",
        json_schema: { name: "defect_analysis", strict: true, schema: outputSchema }
      },
      messages: [{ role: "user", content: [
        { type: "image_url", image_url: { url: "data:image/jpeg;base64," + b64Photo, detail: "low" } },
        { type: "text", text: prompt }
      ]}],
    }),
    timeout: 60,
  });
  if (res.statusCode === 200) {
    var data = JSON.parse(res.raw);
    return (data.choices && data.choices[0] && data.choices[0].message) ? data.choices[0].message.content : null;
  }
  return null;
}

function parseAiResponse(text) {
  if (!text) return null;
  var json = text;
  if (json.indexOf("```") === 0) {
    json = json.split("\n").slice(1).join("\n").replace(/```\s*$/, "").trim();
  }
  json = json.replace(/```json|```/g, "").trim();
  var obj;
  try { obj = JSON.parse(json); } catch (e) { return null; }
  if (!obj || typeof obj !== "object") return null;

  // Shape validation against AI_OUTPUT_SCHEMA. Required core fields must be
  // present and non-empty strings; severity must be one of the four values.
  // Optional fields (location, description, conquas_tier, checkpoint_match)
  // are accepted as null/string.
  var SEV = ["Critical","Major","Minor","Observation"];
  var TIER = ["1X","2X","3X"];
  var CATS = AI_OUTPUT_SCHEMA.properties.category.enum;
  if (typeof obj.category !== "string" || CATS.indexOf(obj.category) < 0) return null;
  if (typeof obj.defect_type !== "string" || !obj.defect_type) return null;
  if (typeof obj.severity !== "string" || SEV.indexOf(obj.severity) < 0) return null;
  if (typeof obj.trade !== "string" || !obj.trade) return null;
  if (obj.conquas_tier != null && TIER.indexOf(obj.conquas_tier) < 0) return null;
  return obj;
}

onRecordAfterCreateSuccess((e) => {
  const record = e.record;
  const photo = record.get("photo");

  // Skip if no photo or already analyzed
  if (!photo || record.get("category")) return;
  // Skip Google Drive records (photos not on PocketBase storage)
  if (record.get("storageMode") === "gdrive") return;
  // Rate limit AI analysis: max 30 per minute globally
  if (!rateLimit("ai_analysis", 30)) return;

  // Determine which AI provider to use (env vars)
  var geminiKey = $os.getenv("GEMINI_API_KEY");
  var ollamaUrl = $os.getenv("OLLAMA_URL");
  var ollamaModel = $os.getenv("OLLAMA_MODEL") || "llava";
  var oaiKey = $os.getenv("OPENAI_API_KEY");
  var oaiUrl = $os.getenv("OPENAI_URL") || "https://api.openai.com";
  var oaiModel = $os.getenv("OPENAI_MODEL") || "gpt-4o-mini";
  var aiProvider = $os.getenv("AI_PROVIDER") || "gemini";

  // Must have at least one provider configured
  if (!geminiKey && !ollamaUrl && !oaiKey) return;

  try {
    // Read photo file from PocketBase storage
    var fsys = $app.newFilesystem();
    var photoName = Array.isArray(photo) ? photo[0] : photo;
    var fileKey = record.baseFilesPath() + "/" + photoName;
    var reader = fsys.getFile(fileKey);
    var photoBytes = reader.readAll();
    reader.close();
    fsys.close();

    var b64Photo = $security.base64Encode(photoBytes);
    var description = record.get("description") || "";
    var workCategory = record.get("workCategory") || "";
    var responseText = null;

    // Build variant-aware prompt + response schema. The base 11 fields
    // are always asked; the variant for the project's workCategory adds
    // domain-specific fields (CONQUAS / Landed / Highrise / WSH /
    // Interior / FM / Infra). Provider gets the schema as a hard
    // structured-output constraint.
    var built = buildAiInputs(workCategory, description);

    // Call the configured provider
    if (aiProvider === "ollama" && ollamaUrl) {
      responseText = analyzeWithOllamaServer(b64Photo, ollamaUrl, ollamaModel, built.prompt);
    } else if (aiProvider === "openai" && oaiKey) {
      responseText = analyzeWithOpenAIServer(b64Photo, oaiUrl, oaiKey, oaiModel, built.prompt, built.schema);
    } else if (geminiKey) {
      responseText = analyzeWithGeminiServer(b64Photo, geminiKey, built.prompt, built.schema);
    }

    if (responseText) {
      var fields = parseAiResponse(responseText);
      if (fields) {
        // Provenance tracking — record which fields the AI actually
        // wrote, so the client can flip human_reviewed=true when a user
        // edits any of them and downstream tooling can audit AI vs human
        // contributions per row.
        var existingProv = {};
        try { existingProv = JSON.parse(record.get("fieldProvenance") || "{}") || {}; } catch (_) {}
        var aiTag = { source: "ai", verified_by: null, verified_at: null };

        if (fields.category && !record.get("category"))         { record.set("category", fields.category); existingProv.category = aiTag; }
        if (fields.defect_type && !record.get("defect_type"))   { record.set("defect_type", fields.defect_type); existingProv.defect_type = aiTag; }
        if (fields.severity && !record.get("severity"))         { record.set("severity", fields.severity); existingProv.severity = aiTag; }
        if (fields.location && !record.get("location"))         { record.set("location", fields.location); existingProv.location = aiTag; }
        if (fields.description && !record.get("description"))   { record.set("description", fields.description); existingProv.description = aiTag; }
        if (fields.trade && !record.get("trade"))               { record.set("trade", fields.trade); existingProv.trade = aiTag; }
        // v1.1 additive — persist what was previously log-only or absent.
        if (fields.title && !record.get("title"))                       { record.set("title", fields.title); existingProv.title = aiTag; }
        if (fields.conquas_tier && !record.get("conquas_tier"))         { record.set("conquas_tier", fields.conquas_tier); existingProv.conquas_tier = aiTag; }
        if (fields.checkpoint_match && !record.get("checkpoint_match")) { record.set("checkpoint_match", fields.checkpoint_match); existingProv.checkpoint_match = aiTag; }
        if (fields.assessment_zone && !record.get("assessment_zone"))   { record.set("assessment_zone", fields.assessment_zone); existingProv.assessment_zone = aiTag; }
        if (fields.confidence != null)                                  { record.set("ai_confidence", fields.confidence); }

        // Variant fields — persist whichever the AI emitted, gated by
        // the variant declared for this project's workCategory. Same
        // not-already-set guard so user input always wins over AI.
        var _variantConfig = AI_VARIANT_TABLE[workCategory || ""];
        if (_variantConfig && Array.isArray(_variantConfig.fields)) {
          for (var _vi = 0; _vi < _variantConfig.fields.length; _vi++) {
            var _vf = _variantConfig.fields[_vi];
            var _vv = fields[_vf.property];
            if (_vv != null && _vv !== "" && record.get(_vf.property) == null) {
              record.set(_vf.property, _vv);
              existingProv[_vf.property] = aiTag;
            }
          }
        }

        // AI metadata stamping. Lets ACC pipelines correlate quality
        // with model/prompt-version, and lets the client know to flip
        // human_reviewed=true on edit (default false on AI write).
        record.set("ai_model", aiProvider || "");
        record.set("ai_prompt_version", AI_PROMPT_VERSION);
        if (record.get("human_reviewed") == null) record.set("human_reviewed", false);
        record.set("fieldProvenance", JSON.stringify(existingProv));

        $app.save(record);
      } else {
        console.log("AI parse failed: malformed or missing required fields");
      }
    }
  } catch (err) {
    console.log("AI analysis failed:", err);
    // Non-fatal — defect is still saved without AI analysis
  }
}, "defects");

// ====== SEND EMAIL REPORT (via PocketBase SMTP) ======
// Requires SMTP configured in PocketBase Admin → Settings → Mail settings
// Accepts: { recipients: ["a@b.com"], subject: "...", html: "..." }

routerAdd("POST", "/api/send-email", (e) => {
  // Require authenticated user
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  var ip = e.request.remoteAddr || "unknown";
  if (!rateLimit("send_email_" + ip, 5)) {
    return e.json(429, { error: "Too many email requests. Try again in a minute." });
  }

  var body = e.request.body;
  var data;
  try {
    data = JSON.parse($toString(body));
  } catch {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var recipients = data.recipients || [];
  var subject = data.subject || "";
  var html = data.html || "";

  if (!recipients.length) {
    return e.json(400, { error: "No recipients provided." });
  }
  if (!subject || !html) {
    return e.json(400, { error: "Subject and HTML content are required." });
  }

  // Basic email validation
  var emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (var i = 0; i < recipients.length; i++) {
    if (!emailRegex.test(recipients[i])) {
      return e.json(400, { error: "Invalid email: " + recipients[i] });
    }
  }

  var errors = [];
  for (var i = 0; i < recipients.length; i++) {
    try {
      var msg = new MailerMessage();
      msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
      msg.to = [{ address: recipients[i] }];
      msg.subject = subject;
      msg.html = html;
      $app.newMailClient().send(msg);
    } catch (err) {
      console.log("Email send failed for " + recipients[i] + ":", err);
      errors.push(recipients[i]);
    }
  }

  if (errors.length === recipients.length) {
    return e.json(500, { error: "Failed to send all emails. Check SMTP settings in PocketBase admin." });
  }
  if (errors.length > 0) {
    return e.json(207, { ok: true, partial: true, failed: errors });
  }
  return e.json(200, { ok: true });
});

// ====== CONFIGURE SMTP (admin-only, from in-app settings) ======
// Lets the owner set SMTP directly from SiteShrimp without opening PB admin
routerAdd("POST", "/api/configure-smtp", (e) => {
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  // Check if user is admin role in their company
  var member;
  try {
    member = $app.findFirstRecordByFilter("members", 'userId="' + auth.id + '"');
  } catch(_) {}
  if (!member || member.getString("role") !== "admin") {
    return e.json(403, { error: "Only admins can configure SMTP." });
  }

  var body;
  try {
    body = JSON.parse($toString(e.request.body));
  } catch(_) {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var host = body.host || "";
  var port = parseInt(body.port) || 587;
  var username = body.username || "";
  var password = body.password || "";
  var fromEmail = body.fromEmail || username;
  var fromName = body.fromName || "SiteShrimp";

  if (!host || !username || !password) {
    return e.json(400, { error: "Host, username, and password are required." });
  }

  try {
    var settings = $app.settings();
    settings.smtp.enabled = true;
    settings.smtp.host = host;
    settings.smtp.port = port;
    settings.smtp.tls = true;
    settings.smtp.username = username;
    settings.smtp.password = password;
    settings.meta.senderAddress = fromEmail;
    settings.meta.senderName = fromName;
    $app.save(settings);
    return e.json(200, { ok: true });
  } catch (err) {
    console.log("SMTP configure failed:", err);
    return e.json(500, { error: "Failed to save SMTP settings: " + err });
  }
});

// ====== CASCADE DELETE: pins and map_pins that point to a defect ======
// When a defect is deleted, remove its drawing pins and map pins so the
// UI doesn't render orphan markers that open a 404 entry detail.
// Defensive registration — a missing hook symbol or registration error
// MUST NOT crash this file, otherwise the storage-cap + defect_id hooks
// above also fail to load and every defect create starts returning 400.
(function registerCascadeDelete() {
  var handler = function (e) {
    try {
      var entryId = e.record.getString("id");
      if (!entryId) return e.next();
      try {
        var pins = $app.findRecordsByFilter("pins", "entryId = {:eid}", "", 1000, 0, { eid: entryId });
        pins.forEach(function (p) { try { $app.delete(p); } catch (_) {} });
      } catch (_) {}
      try {
        var mpins = $app.findRecordsByFilter("map_pins", "entryId = {:eid}", "", 1000, 0, { eid: entryId });
        mpins.forEach(function (p) { try { $app.delete(p); } catch (_) {} });
      } catch (_) {}
    } catch (err) {
      console.log("Cascade-delete hook error (ignored):", err);
    }
    return e.next();
  };
  try {
    if (typeof onRecordAfterDeleteSuccess === "function") {
      onRecordAfterDeleteSuccess(handler, "defects");
      return;
    }
    if (typeof onRecordAfterDeleteRequest === "function") {
      onRecordAfterDeleteRequest(handler, "defects");
      return;
    }
    if (typeof onRecordDeleteSuccess === "function") {
      onRecordDeleteSuccess(handler, "defects");
      return;
    }
    console.log("Cascade-delete hook not registered: no matching hook symbol in this PocketBase version");
  } catch (regErr) {
    console.log("Cascade-delete hook registration failed (ignored):", regErr);
  }
})();

// ====== TEST SMTP (send a test email to verify config) ======
routerAdd("POST", "/api/test-smtp", (e) => {
  var auth = e.auth;
  if (!auth) {
    return e.json(401, { error: "Authentication required." });
  }

  var body;
  try {
    body = JSON.parse($toString(e.request.body));
  } catch(_) {
    return e.json(400, { error: "Invalid JSON body." });
  }

  var to = body.to || auth.getString("email");
  if (!to) {
    return e.json(400, { error: "No email address to test." });
  }

  try {
    var msg = new MailerMessage();
    msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
    msg.to = [{ address: to }];
    msg.subject = "SiteShrimp — Test Email";
    msg.html = "<h2>It works!</h2><p>Your email is configured correctly. You can now send reports from SiteShrimp.</p>";
    $app.newMailClient().send(msg);
    return e.json(200, { ok: true });
  } catch (err) {
    console.log("Test email failed:", err);
    return e.json(500, { error: "Test email failed: " + err });
  }
});

// ====== WEEKLY REPORT SUBSCRIPTION (gap #3) ======
// Hourly cron scans projects for opt-in weekly summary subscriptions and
// sends an HTML digest via the same SMTP path used by /api/send-email.
// Per-project schema fields (additive, all defaulted):
//   weekly_report_enabled    bool    — opt-in toggle (default false)
//   weekly_report_recipients text    — comma- or newline-separated emails
//   weekly_report_dow        number  — JS Date.getDay() day-of-week, 0=Sun, 6=Sat
//   weekly_report_hour       number  — 24h hour-of-day in SGT (UTC+8), 0..23
//   weekly_report_last_sent  text    — ISO timestamp of the last successful send;
//                                       used to dedupe across cron restarts so a
//                                       crash-loop doesn't email a project twice.
//
// Day/hour are interpreted in **SGT (UTC+8)** because the project is run from
// Singapore and "Monday 09:00" must mean SGT regardless of where the VM is
// located. Server is in asia-southeast1-c which IS SGT, but we compute the
// offset explicitly so a future relocation doesn't silently shift everyone's
// digest schedule.
//
// HTML body is intentionally simple — open count by severity, critical
// unresolved list, recent (last 7d) status changes pulled from the comments
// array (`kind:"event"` rows added by client-side diffDefectEvents()).
// Avoids re-implementing the full client-side generateEmailHTML (which is
// React/JSX-rendered) on the server side.

// NOTE 2026-05-03: PocketBase JSVM (goja) invokes cron callbacks in a
// fresh JS runtime per fire that does NOT carry the host file's top-level
// function scope. Confirmed by `ReferenceError: _sgtParts is not defined`
// thrown from within the cron handler at minute boundaries even after a
// systemctl restart. The fix is to nest every helper INSIDE the cron
// callback so each fire re-declares them in local scope. The functions
// below are kept here as documentation / legacy callers; the cron itself
// has its own copies further down. Do NOT remove these without confirming
// nothing else in main.pb.js calls them.

function _sgtParts() {
  // SGT = UTC+8 with no DST. Compute by shifting the UTC ms.
  var nowUtcMs = Date.now();
  var sgtMs = nowUtcMs + (8 * 3600 * 1000);
  var d = new Date(sgtMs);
  return {
    dow: d.getUTCDay(),     // 0=Sun..6=Sat
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    iso: new Date(nowUtcMs).toISOString()
  };
}

function _sanitizeHtml(s) {
  if (s == null) return "";
  return String(s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

function _parseRecipients(text) {
  if (!text) return [];
  // Accept comma-, semicolon-, or newline-separated; trim; filter empties.
  var parts = String(text).split(/[,;\n\r]+/);
  var out = [];
  var seen = {};
  var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  for (var i = 0; i < parts.length; i++) {
    var v = parts[i].trim();
    if (!v || seen[v.toLowerCase()]) continue;
    if (!emailRe.test(v)) continue;
    seen[v.toLowerCase()] = true;
    out.push(v);
  }
  return out;
}

function _buildWeeklyHtml(project, defects) {
  var counts = { Open: 0, "In Progress": 0, Done: 0, Verified: 0, Closed: 0 };
  var sevCounts = { Critical: 0, Major: 0, Minor: 0, Observation: 0 };
  var critical = [];
  var sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
  var recentEvents = [];
  for (var i = 0; i < defects.length; i++) {
    var d = defects[i];
    var status = d.getString("status") || "Open";
    var sev = d.getString("severity") || "Major";
    if (counts[status] !== undefined) counts[status]++;
    if (sevCounts[sev] !== undefined) sevCounts[sev]++;
    var isOpen = status !== "Closed" && status !== "Verified";
    if (isOpen && sev === "Critical") {
      critical.push({
        id: d.getString("defect_id") || d.getString("id"),
        title: d.getString("title") || "(untitled)",
        location: d.getString("location") || "",
        assignee: d.getString("assignee") || ""
      });
    }
    // Recent events from comments array
    var comments = [];
    try { comments = JSON.parse(d.getString("comments") || "[]"); } catch (_) {}
    if (Array.isArray(comments)) {
      for (var j = 0; j < comments.length; j++) {
        var c = comments[j];
        if (!c || c.kind !== "event") continue;
        if (typeof c.at !== "number" || c.at < sevenDaysAgo) continue;
        recentEvents.push({
          defect: d.getString("defect_id") || "",
          title: d.getString("title") || "",
          type: c.type || "",
          from: c.from || "",
          to: c.to || "",
          by: c.by || "",
          at: c.at
        });
      }
    }
  }
  recentEvents.sort(function (a, b) { return b.at - a.at; });
  if (recentEvents.length > 20) recentEvents = recentEvents.slice(0, 20);

  var open = counts.Open + counts["In Progress"];
  var html = '<div style="font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; max-width: 640px; margin: 0 auto; padding: 24px;">';
  html += '<h1 style="font-size: 22px; margin: 0 0 8px; color: #ff6b00;">SiteShrimp Weekly Summary</h1>';
  html += '<div style="color: rgba(0,0,0,0.5); font-size: 14px; margin-bottom: 24px;">' + _sanitizeHtml(project.getString("name")) + ' — week ending ' + new Date().toISOString().slice(0, 10) + '</div>';

  html += '<div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">';
  html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #ff3b30;">' + open + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Open</div></div>';
  html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #5856d6;">' + sevCounts.Critical + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Critical</div></div>';
  html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #34c759;">' + (counts.Closed + counts.Verified) + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Closed</div></div>';
  html += '</div>';

  if (critical.length) {
    html += '<h2 style="font-size: 16px; margin: 24px 0 8px; color: #ff3b30;">Critical Unresolved (' + critical.length + ')</h2>';
    html += '<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px;">';
    html += '<thead><tr style="background: rgba(255,59,48,0.06);"><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">ID</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Title</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Location</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Assignee</th></tr></thead><tbody>';
    for (var k = 0; k < critical.length; k++) {
      var c = critical[k];
      html += '<tr style="border-bottom: 1px solid rgba(0,0,0,0.06);"><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + _sanitizeHtml(c.id) + '</td><td style="padding: 8px 10px; font-weight: 600;">' + _sanitizeHtml(c.title) + '</td><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + _sanitizeHtml(c.location) + '</td><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + _sanitizeHtml(c.assignee) + '</td></tr>';
    }
    html += '</tbody></table>';
  }

  if (recentEvents.length) {
    html += '<h2 style="font-size: 16px; margin: 24px 0 8px; color: #5856d6;">Recent Changes (last 7 days)</h2>';
    html += '<div style="font-size: 13px;">';
    for (var m = 0; m < recentEvents.length; m++) {
      var e = recentEvents[m];
      html += '<div style="padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06);"><span style="color: rgba(0,0,0,0.5);">' + new Date(e.at).toISOString().slice(0, 10) + '</span> &middot; <span style="font-weight: 600;">' + _sanitizeHtml(e.defect || e.title) + '</span> &middot; ' + _sanitizeHtml(e.type) + ': ' + _sanitizeHtml(e.from || "—") + ' &rarr; <b>' + _sanitizeHtml(e.to || "—") + '</b> &middot; <span style="color: rgba(0,0,0,0.5);">by ' + _sanitizeHtml(e.by) + '</span></div>';
    }
    html += '</div>';
  }

  if (!critical.length && !recentEvents.length) {
    html += '<div style="background: rgba(48,209,88,0.08); border-radius: 10px; padding: 16px; color: #1a7a35; font-size: 14px; margin: 24px 0;">No critical unresolved entries and no tracked changes in the last 7 days. All quiet.</div>';
  }

  html += '<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.06); font-size: 11px; color: rgba(0,0,0,0.4);">SiteShrimp weekly summary &middot; <a href="https://siteshrimp.org" style="color: #ff6b00; text-decoration: none;">siteshrimp.org</a> &middot; To unsubscribe, open the project in SiteShrimp &rarr; Settings &rarr; Projects.</div>';
  html += '</div>';
  return html;
}

function _sendWeeklyForProject(project) {
  var pid = project.getString("id");
  var pname = project.getString("name") || "Project";
  var recipientsRaw = project.getString("weekly_report_recipients") || "";
  var recipients = _parseRecipients(recipientsRaw);
  if (!recipients.length) {
    console.log("[weekly_report] project " + pid + " enabled but has no valid recipients — skipping");
    return;
  }
  // Dedupe across same-hour cron restarts: skip if last_sent < 12h ago.
  var lastSent = project.getString("weekly_report_last_sent") || "";
  if (lastSent) {
    try {
      var lastMs = Date.parse(lastSent);
      if (!isNaN(lastMs) && Date.now() - lastMs < 12 * 3600 * 1000) {
        console.log("[weekly_report] project " + pid + " already sent within last 12h — skipping");
        return;
      }
    } catch (_) { /* unparseable — proceed */ }
  }

  // Pull defects for this project (capped at 1000 — large projects get
  // counts only, not a 5000-row email).
  var defects = [];
  try {
    defects = $app.findRecordsByFilter(
      "defects",
      "projectId = {:pid} && (archivedAt = '' || archivedAt = null)",
      "-created", 1000, 0, { pid: pid }
    );
  } catch (err) {
    console.log("[weekly_report] failed to query defects for project " + pid + ":", err);
    return;
  }

  var html;
  try {
    html = _buildWeeklyHtml(project, defects);
  } catch (err) {
    console.log("[weekly_report] HTML build failed for project " + pid + ":", err);
    return;
  }

  var subject = "SiteShrimp — " + pname + " weekly summary";
  var sentCount = 0;
  var failedCount = 0;
  for (var i = 0; i < recipients.length; i++) {
    try {
      var msg = new MailerMessage();
      msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
      msg.to = [{ address: recipients[i] }];
      msg.subject = subject;
      msg.html = html;
      $app.newMailClient().send(msg);
      sentCount++;
    } catch (err) {
      failedCount++;
      console.log("[weekly_report] send failed for " + recipients[i] + " (project " + pid + "):", err);
    }
  }

  if (sentCount > 0) {
    try {
      project.set("weekly_report_last_sent", new Date().toISOString());
      $app.save(project);
    } catch (err) {
      console.log("[weekly_report] failed to update last_sent for project " + pid + ":", err);
    }
  }
  console.log("[weekly_report] project " + pid + " (" + pname + ") — sent " + sentCount + ", failed " + failedCount);
}

// Register the minute cron. Defensive — a missing cronAdd symbol or a
// throw during registration MUST NOT take down the rest of the hooks
// file (else every defect create would start failing because the
// storage-cap + defect_id hooks above never get reached on next reload).
//
// IMPORTANT (goja scope fix v3 2026-05-03): every helper used by the
// cron callback is declared INSIDE the callback body. PocketBase's
// JSVM invokes cron callbacks in a fresh runtime per fire that does
// NOT inherit the file's top-level lexical scope. Calling top-level
// helpers from inside throws `ReferenceError: <fn> is not defined`.
// Re-declaring helpers per fire is cheap (microseconds) and removes
// the closure dependency entirely. Function declarations are hoisted
// so the order inside the callback doesn't matter.
(function registerWeeklyReportCron() {
  try {
    if (typeof cronAdd !== "function") {
      console.log("[weekly_report] cronAdd not available on this PocketBase build — scheduled reports disabled");
      return;
    }
    cronAdd("siteshrimp_weekly_reports", "* * * * *", function () {
      // ── helpers (local to this cron fire) ──────────────────────
      function sgtParts() {
        var nowUtcMs = Date.now();
        var sgtMs = nowUtcMs + (8 * 3600 * 1000);
        var d = new Date(sgtMs);
        return {
          dow: d.getUTCDay(),
          hour: d.getUTCHours(),
          minute: d.getUTCMinutes(),
          iso: new Date(nowUtcMs).toISOString()
        };
      }
      function sanitizeHtml(s) {
        if (s == null) return "";
        return String(s)
          .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
          .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
      }
      function parseRecipients(text) {
        if (!text) return [];
        var parts = String(text).split(/[,;\n\r]+/);
        var out = [];
        var seen = {};
        var emailRe = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
        for (var i = 0; i < parts.length; i++) {
          var v = parts[i].trim();
          if (!v || seen[v.toLowerCase()]) continue;
          if (!emailRe.test(v)) continue;
          seen[v.toLowerCase()] = true;
          out.push(v);
        }
        return out;
      }
      function buildWeeklyHtml(project, defects) {
        var counts = { Open: 0, "In Progress": 0, Done: 0, Verified: 0, Closed: 0 };
        var sevCounts = { Critical: 0, Major: 0, Minor: 0, Observation: 0 };
        var critical = [];
        var sevenDaysAgo = Date.now() - 7 * 86400 * 1000;
        var recentEvents = [];
        for (var i = 0; i < defects.length; i++) {
          var d = defects[i];
          var status = d.getString("status") || "Open";
          var sev = d.getString("severity") || "Major";
          if (counts[status] !== undefined) counts[status]++;
          if (sevCounts[sev] !== undefined) sevCounts[sev]++;
          var isOpen = status !== "Closed" && status !== "Verified";
          if (isOpen && sev === "Critical") {
            critical.push({
              id: d.getString("defect_id") || d.getString("id"),
              title: d.getString("title") || "(untitled)",
              location: d.getString("location") || "",
              assignee: d.getString("assignee") || ""
            });
          }
          var comments = [];
          try { comments = JSON.parse(d.getString("comments") || "[]"); } catch (_) {}
          if (Array.isArray(comments)) {
            for (var j = 0; j < comments.length; j++) {
              var c = comments[j];
              if (!c || c.kind !== "event") continue;
              if (typeof c.at !== "number" || c.at < sevenDaysAgo) continue;
              recentEvents.push({
                defect: d.getString("defect_id") || "",
                title: d.getString("title") || "",
                type: c.type || "",
                from: c.from || "",
                to: c.to || "",
                by: c.by || "",
                at: c.at
              });
            }
          }
        }
        recentEvents.sort(function (a, b) { return b.at - a.at; });
        if (recentEvents.length > 20) recentEvents = recentEvents.slice(0, 20);

        var open = counts.Open + counts["In Progress"];
        var html = '<div style="font-family: -apple-system, system-ui, sans-serif; color: #1a1a1a; max-width: 640px; margin: 0 auto; padding: 24px;">';
        html += '<h1 style="font-size: 22px; margin: 0 0 8px; color: #ff6b00;">SiteShrimp Weekly Summary</h1>';
        html += '<div style="color: rgba(0,0,0,0.5); font-size: 14px; margin-bottom: 24px;">' + sanitizeHtml(project.getString("name")) + ' — week ending ' + new Date().toISOString().slice(0, 10) + '</div>';
        html += '<div style="display: flex; gap: 12px; margin-bottom: 24px; flex-wrap: wrap;">';
        html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #ff3b30;">' + open + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Open</div></div>';
        html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #5856d6;">' + sevCounts.Critical + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Critical</div></div>';
        html += '<div style="background: #fff; border: 1px solid rgba(0,0,0,0.08); border-radius: 10px; padding: 14px 18px; min-width: 100px;"><div style="font-size: 28px; font-weight: 800; color: #34c759;">' + (counts.Closed + counts.Verified) + '</div><div style="font-size: 11px; color: rgba(0,0,0,0.5); text-transform: uppercase; letter-spacing: 0.06em; margin-top: 4px;">Closed</div></div>';
        html += '</div>';

        if (critical.length) {
          html += '<h2 style="font-size: 16px; margin: 24px 0 8px; color: #ff3b30;">Critical Unresolved (' + critical.length + ')</h2>';
          html += '<table style="width: 100%; border-collapse: collapse; font-size: 13px; margin-bottom: 24px;">';
          html += '<thead><tr style="background: rgba(255,59,48,0.06);"><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">ID</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Title</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Location</th><th style="text-align: left; padding: 8px 10px; font-size: 11px; text-transform: uppercase; letter-spacing: 0.04em; color: rgba(0,0,0,0.5);">Assignee</th></tr></thead><tbody>';
          for (var k = 0; k < critical.length; k++) {
            var cr = critical[k];
            html += '<tr style="border-bottom: 1px solid rgba(0,0,0,0.06);"><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + sanitizeHtml(cr.id) + '</td><td style="padding: 8px 10px; font-weight: 600;">' + sanitizeHtml(cr.title) + '</td><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + sanitizeHtml(cr.location) + '</td><td style="padding: 8px 10px; color: rgba(0,0,0,0.7);">' + sanitizeHtml(cr.assignee) + '</td></tr>';
          }
          html += '</tbody></table>';
        }

        if (recentEvents.length) {
          html += '<h2 style="font-size: 16px; margin: 24px 0 8px; color: #5856d6;">Recent Changes (last 7 days)</h2>';
          html += '<div style="font-size: 13px;">';
          for (var m = 0; m < recentEvents.length; m++) {
            var ev = recentEvents[m];
            html += '<div style="padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06);"><span style="color: rgba(0,0,0,0.5);">' + new Date(ev.at).toISOString().slice(0, 10) + '</span> &middot; <span style="font-weight: 600;">' + sanitizeHtml(ev.defect || ev.title) + '</span> &middot; ' + sanitizeHtml(ev.type) + ': ' + sanitizeHtml(ev.from || "—") + ' &rarr; <b>' + sanitizeHtml(ev.to || "—") + '</b> &middot; <span style="color: rgba(0,0,0,0.5);">by ' + sanitizeHtml(ev.by) + '</span></div>';
          }
          html += '</div>';
        }

        if (!critical.length && !recentEvents.length) {
          html += '<div style="background: rgba(48,209,88,0.08); border-radius: 10px; padding: 16px; color: #1a7a35; font-size: 14px; margin: 24px 0;">No critical unresolved entries and no tracked changes in the last 7 days. All quiet.</div>';
        }

        html += '<div style="margin-top: 32px; padding-top: 16px; border-top: 1px solid rgba(0,0,0,0.06); font-size: 11px; color: rgba(0,0,0,0.4);">SiteShrimp weekly summary &middot; <a href="https://siteshrimp.org" style="color: #ff6b00; text-decoration: none;">siteshrimp.org</a> &middot; To unsubscribe, open the project in SiteShrimp &rarr; Settings &rarr; Projects.</div>';
        html += '</div>';
        return html;
      }
      function sendWeeklyForProject(project) {
        var pid = project.getString("id");
        var pname = project.getString("name") || "Project";
        var recipientsRaw = project.getString("weekly_report_recipients") || "";
        var recipients = parseRecipients(recipientsRaw);
        if (!recipients.length) {
          console.log("[weekly_report] project " + pid + " enabled but has no valid recipients — skipping");
          return;
        }
        var lastSent = project.getString("weekly_report_last_sent") || "";
        if (lastSent) {
          try {
            var lastMs = Date.parse(lastSent);
            if (!isNaN(lastMs) && Date.now() - lastMs < 12 * 3600 * 1000) {
              console.log("[weekly_report] project " + pid + " already sent within last 12h — skipping");
              return;
            }
          } catch (_) {}
        }
        var defects = [];
        try {
          defects = $app.findRecordsByFilter(
            "defects",
            "projectId = {:pid} && (archivedAt = '' || archivedAt = null)",
            "", 1000, 0, { pid: pid }
          );
        } catch (err) {
          console.log("[weekly_report] failed to query defects for project " + pid + ":", err);
          return;
        }
        var html;
        try {
          html = buildWeeklyHtml(project, defects);
        } catch (err) {
          console.log("[weekly_report] HTML build failed for project " + pid + ":", err);
          return;
        }
        var subject = "SiteShrimp — " + pname + " weekly summary";
        var sentCount = 0;
        var failedCount = 0;
        for (var i = 0; i < recipients.length; i++) {
          try {
            var msg = new MailerMessage();
            msg.from = { address: $app.settings().meta.senderAddress, name: $app.settings().meta.senderName || "SiteShrimp" };
            msg.to = [{ address: recipients[i] }];
            msg.subject = subject;
            msg.html = html;
            $app.newMailClient().send(msg);
            sentCount++;
          } catch (err) {
            failedCount++;
            console.log("[weekly_report] send failed for " + recipients[i] + " (project " + pid + "):", err);
          }
        }
        if (sentCount > 0) {
          try {
            project.set("weekly_report_last_sent", new Date().toISOString());
            $app.save(project);
          } catch (err) {
            console.log("[weekly_report] failed to update last_sent for project " + pid + ":", err);
          }
        }
        console.log("[weekly_report] project " + pid + " (" + pname + ") — sent " + sentCount + ", failed " + failedCount);
      }

      // ── handler body ──────────────────────────────────────────
      try {
        var when = sgtParts();
        // Backward-compat: rows where weekly_report_minute is null/missing
        // (created before the v2 schema field was added) are treated as
        // top-of-hour, so legacy subscriptions keep firing as before.
        var projects = $app.findRecordsByFilter(
          "projects",
          "weekly_report_enabled = true && weekly_report_dow = {:dow} && weekly_report_hour = {:hour} && (weekly_report_minute = {:minute} || (weekly_report_minute = null && {:minute} = 0) || (weekly_report_minute = 0 && {:minute} = 0)) && (archived = false || archived = null || archived = '')",
          "", 200, 0, { dow: when.dow, hour: when.hour, minute: when.minute }
        );
        if (!projects.length) return;
        console.log("[weekly_report] cron fired SGT dow=" + when.dow + " hour=" + when.hour + " minute=" + when.minute + " — " + projects.length + " project(s) due");
        for (var pi = 0; pi < projects.length; pi++) {
          sendWeeklyForProject(projects[pi]);
        }
      } catch (err) {
        console.log("[weekly_report] cron handler error (ignored):", err);
      }
    });
    console.log("[weekly_report] cron registered (siteshrimp_weekly_reports, * * * * *) — minute precision, helpers nested (v3)");
  } catch (err) {
    console.log("[weekly_report] cron registration failed (ignored):", err);
  }
})();
