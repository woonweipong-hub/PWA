// Extract structured CONQUAS-aligned checkpoints from bundled BCA GIP texts.
//
// Reads reference-texts/gip-*.txt (already extracted at build time from the
// bundled BCA Good Industry Practice PDFs) and uses the configured AI provider
// to generate structured ontology seeds per trade:
//
//   deploy/pocketbase/pb_hooks/ontology/gip-{trade}-components.json
//   deploy/pocketbase/pb_hooks/ontology/gip-{trade}-defect-types.json
//   deploy/pocketbase/pb_hooks/ontology/gip-{trade}-checkpoints.json
//
// Seeds are written with `needs_review: true` on every row so the data does
// not enter production inspection flows until a user has validated each
// checkpoint against the authoritative GIP PDF. Traceability: each row
// carries `verbatim_source` pointing at the GIP filename + section.
//
// Run: node tools/seed-gip-checkpoints.js              (all 13 usable GIPs)
//      node tools/seed-gip-checkpoints.js painting     (one specific trade)
//      node tools/seed-gip-checkpoints.js --dry-run    (print, don't write)
//
// Requires: AI_PROVIDER + API key env vars (same as app's AI config).
//   AI_PROVIDER=gemini   AI_API_KEY=...    AI_MODEL=gemini-2.0-flash
//   AI_PROVIDER=openai   AI_API_KEY=...    AI_MODEL=gpt-4o-mini
//   AI_PROVIDER=anthropic AI_API_KEY=...   AI_MODEL=claude-haiku-4-5
//
// Budget: 13 GIPs × ~20k chars each ≈ 260k tokens input. At Gemini Flash's
// pricing that's under US$0.50 total. At Claude Haiku 4.5 under US$1.

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = path.resolve(__dirname, "..");
const REF_DIR = path.join(ROOT, "reference-texts");
const OUT_DIR = path.join(ROOT, "deploy", "pocketbase", "pb_hooks", "ontology");

// Which bundled GIPs to process. Excludes the 4 scanned-image PDFs with no
// text layer — they'd produce empty prompts. Trade-name matches the GIP
// filename stem; becomes the seed-file prefix.
const GIP_MANIFEST = [
  { id: "painting",                  file: "gip-painting.txt",                  title: "Painting" },
  { id: "ceramic-tiling",            file: "gip-ceramic-tiling.txt",            title: "Ceramic Tiling" },
  { id: "natural-stone-finishes",    file: "gip-natural-stone-finishes.txt",    title: "Natural Stone Finishes" },
  { id: "waterproofing-external",    file: "gip-waterproofing-external.txt",    title: "Waterproofing — External Wall" },
  { id: "aluminium-window",          file: "gip-aluminium-window.txt",          title: "Aluminium Window" },
  { id: "timber-flooring",           file: "gip-timber-flooring.txt",           title: "Timber Flooring" },
  { id: "engineered-wood",           file: "gip-engineered-wood.txt",           title: "Engineered Wood Flooring" },
  { id: "vinyl-flooring",            file: "gip-vinyl-flooring.txt",            title: "Vinyl Flooring" },
  { id: "wardrobes-cabinets",        file: "gip-wardrobes-cabinets.txt",        title: "Wardrobes & Kitchen Cabinets" },
  { id: "drywall-partition",         file: "gip-drywall-partition.txt",         title: "Drywall Internal Partition" },
  { id: "pbu",                       file: "gip-pbu.txt",                       title: "Prefabricated Bathroom Unit (PBU)" },
  { id: "design-materials-vol1",     file: "gip-design-materials-vol1.txt",     title: "Design & Materials Selection — Vol 1" },
  { id: "design-materials-vol2",     file: "gip-design-materials-vol2.txt",     title: "Design & Materials Selection — Vol 2" },
];

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const singleTrade = args.find(a => !a.startsWith("--"));

function provider() {
  const p = (process.env.AI_PROVIDER || "").toLowerCase();
  const k = process.env.AI_API_KEY;
  const m = process.env.AI_MODEL;
  if (!p || !k) {
    console.error("Missing AI_PROVIDER or AI_API_KEY env var.");
    console.error("Example: AI_PROVIDER=gemini AI_API_KEY=... AI_MODEL=gemini-2.0-flash node tools/seed-gip-checkpoints.js");
    process.exit(1);
  }
  return { provider: p, key: k, model: m };
}

function fetchJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      host: u.host, path: u.pathname + u.search, method: "POST",
      headers: { "content-type": "application/json", ...(headers || {}) }
    }, (res) => {
      let data = "";
      res.on("data", (c) => data += c);
      res.on("end", () => {
        if (res.statusCode >= 400) return reject(new Error(`HTTP ${res.statusCode}: ${data.slice(0, 500)}`));
        try { resolve(JSON.parse(data)); } catch (e) { reject(new Error("Bad JSON: " + data.slice(0, 200))); }
      });
    });
    req.on("error", reject);
    req.write(typeof body === "string" ? body : JSON.stringify(body));
    req.end();
  });
}

async function askAI(prompt) {
  const { provider: p, key, model } = provider();
  if (p === "gemini") {
    const m = model || "gemini-2.0-flash";
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${key}`;
    const r = await fetchJson(url, { contents: [{ parts: [{ text: prompt }] }] });
    return r.candidates?.[0]?.content?.parts?.[0]?.text || "";
  }
  if (p === "openai") {
    const m = model || "gpt-4o-mini";
    const url = "https://api.openai.com/v1/chat/completions";
    const r = await fetchJson(url,
      { model: m, messages: [{ role: "user", content: prompt }] },
      { authorization: `Bearer ${key}` });
    return r.choices?.[0]?.message?.content || "";
  }
  if (p === "anthropic") {
    const m = model || "claude-haiku-4-5";
    const url = "https://api.anthropic.com/v1/messages";
    const r = await fetchJson(url,
      { model: m, max_tokens: 8000, messages: [{ role: "user", content: prompt }] },
      { "x-api-key": key, "anthropic-version": "2023-06-01" });
    return r.content?.[0]?.text || "";
  }
  throw new Error(`Unknown AI_PROVIDER: ${p}`);
}

function buildPrompt(gip, text) {
  return `You are reading a BCA Good Industry Practice (GIP) guide for the trade "${gip.title}".
Your job: extract STRUCTURED inspection ontology aligned with the BCA CONQUAS severity tier convention (1X Finishings / 2X Functionality / 3X Liveability).

Output STRICT JSON matching this exact schema (no prose, no markdown fences):

{
  "components": [
    {
      "id": "cp_<trade-id>_<short_snake_case>",
      "name": "Element name, verbatim from GIP where possible",
      "category": "Trade — ${gip.title}",
      "verbatim_source": "${gip.file} — section reference",
      "typical_location": "where on site this element occurs (e.g. 'internal painted walls', 'external waterproofing membrane')"
    }
  ],
  "defect_types": [
    {
      "id": "dt_<trade-id>_<tier>_<short_snake_case>",
      "element": "matches a components[].name",
      "typical_component_ids": ["<component-id>"],
      "tier": "1X" | "2X" | "3X",
      "name": "Defect name, verbatim from GIP 'Common Issues' where possible",
      "measurement_threshold": "Any measurable tolerance verbatim from GIP (e.g. '>3mm/m', '≥1 spot'), otherwise empty string",
      "verbatim_source_row": "${gip.file} — page/section reference"
    }
  ],
  "checkpoints": [
    {
      "id": "chk_<trade-id>_<short>",
      "component_id": "matches a components[].id",
      "tier": "1X" | "2X" | "3X",
      "description": "What to verify on site, inspector-facing",
      "pass_criteria": "Precise pass test: visual / measurement / functional / tap-test / etc.",
      "related_defect_type_ids": ["<defect-type-id>"]
    }
  ]
}

Guidelines:
- Use 1X for cosmetic/finishings defects (stains, scratches, minor alignment).
- Use 2X for functionality defects (movement, loose, difficulty operating, unevenness beyond tolerance).
- Use 3X for liveability/structural defects (cracks, leakage, broken glass, delamination, structural damage).
- Keep defect names VERBATIM from the GIP when quoted. Do not paraphrase contractually-loaded wording.
- Preserve any measurement tolerances verbatim in measurement_threshold.
- One checkpoint per inspectable condition. A single defect_type may spawn one or more checkpoints (pass-framed).
- Aim for 10–40 items per trade. Prefer higher recall on 2X/3X items.

GIP TEXT (extracted from ${gip.file}):
"""
${text.slice(0, 18000)}
"""

Return ONLY the JSON object. No markdown fences.`;
}

function wrapDataset(gip, kind, items) {
  return {
    $schema: "https://siteshrimp.org/schemas/ontology-v1.json",
    dataset: {
      edition: `bca-gip-${gip.id}`,
      edition_title: `BCA Good Industry Practice — ${gip.title}`,
      version: "0.1.0-draft",
      generated_at: new Date().toISOString(),
      generated_by: "tools/seed-gip-checkpoints.js (AI-extracted)",
      lifecycle: { status: "draft", effective_from: null, effective_to: null, supersedes: null, superseded_by: null },
      provenance: {
        authority: "BCA",
        document_url: "https://www1.bca.gov.sg/resources/guidebooks-and-publications/",
        document_source_pdf: gip.file.replace(/\.txt$/, ".pdf"),
        section_ref: `Derived from full GIP text via AI extraction`,
        derivation_note: "AI-extracted from bundled GIP text. Every row flagged needs_review=true. Human validation required against the authoritative GIP PDF before use in live inspection flows."
      },
      review: {
        review_status: "needs_customer_validation",
        created_at: new Date().toISOString().slice(0, 10),
        last_verified_at: null,
        next_review_due: null,
        review_notes: "AI-extracted. Validate each row against the source GIP PDF before use."
      }
    },
    intent: `Guided LOG flow for trade-specific inspection under ${gip.title}. Inspector picks element → walks checkpoints → pass/fail + photo-on-fail.`,
    items: items.map(x => ({ ...x, needs_review: true }))
  };
}

async function processOne(gip) {
  const textPath = path.join(REF_DIR, gip.file);
  if (!fs.existsSync(textPath)) {
    console.error(`  ✗ ${gip.id} — ${textPath} not found (run npm run extract:refs first)`);
    return;
  }
  const text = fs.readFileSync(textPath, "utf8");
  if (text.length < 500) {
    console.error(`  ✗ ${gip.id} — text file too short (${text.length} chars), skipping`);
    return;
  }
  console.log(`  → ${gip.id} — asking AI (text: ${Math.round(text.length / 1000)}k chars)…`);
  const raw = await askAI(buildPrompt(gip, text));
  let json = raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "");
  let parsed;
  try { parsed = JSON.parse(json); }
  catch (e) {
    console.error(`  ✗ ${gip.id} — AI returned non-JSON: ${e.message}`);
    console.error(`  AI output (first 500 chars): ${raw.slice(0, 500)}`);
    return;
  }
  const comps = wrapDataset(gip, "components", parsed.components || []);
  const dtypes = wrapDataset(gip, "defect_types", parsed.defect_types || []);
  const chkpts = wrapDataset(gip, "checkpoints", parsed.checkpoints || []);
  if (dryRun) {
    console.log(`  ✓ ${gip.id} — ${comps.items.length} components · ${dtypes.items.length} defect types · ${chkpts.items.length} checkpoints (dry-run)`);
    return;
  }
  fs.writeFileSync(path.join(OUT_DIR, `gip-${gip.id}-components.json`), JSON.stringify(comps, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, `gip-${gip.id}-defect-types.json`), JSON.stringify(dtypes, null, 2), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, `gip-${gip.id}-checkpoints.json`), JSON.stringify(chkpts, null, 2), "utf8");
  console.log(`  ✓ ${gip.id} — wrote ${comps.items.length}/${dtypes.items.length}/${chkpts.items.length} rows`);
}

async function main() {
  let targets = GIP_MANIFEST;
  if (singleTrade) {
    targets = GIP_MANIFEST.filter(g => g.id === singleTrade);
    if (!targets.length) {
      console.error(`Unknown trade "${singleTrade}". Available: ${GIP_MANIFEST.map(g => g.id).join(", ")}`);
      process.exit(1);
    }
  }
  console.log(`Extracting ${targets.length} GIP(s)${dryRun ? " (dry run)" : ""}…`);
  for (const gip of targets) {
    try { await processOne(gip); }
    catch (e) { console.error(`  ✗ ${gip.id} — ${e.message}`); }
  }
  console.log(`\nSeed files written to ${OUT_DIR}/gip-*.json`);
  console.log("Every row is flagged needs_review=true — validate against source GIP PDFs before live use.");
  console.log("To apply to a PB instance, ensure the seed migration picks up gip-* files, then redeploy.");
}

main().catch(e => { console.error(e); process.exit(1); });
