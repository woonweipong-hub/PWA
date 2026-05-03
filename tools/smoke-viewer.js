// Smoke test for buildPhotoZipViewerHTML — extracts the function from
// js/app.js, runs it against a synthetic entry set, and writes the
// resulting index.html to output/test-viewer.html for manual inspection.
// Pure-function smoke: no DOM, no React, no fetch.
const fs = require("fs");
const path = require("path");

const src = fs.readFileSync(path.join(__dirname, "..", "js", "app.js"), "utf8");

// Anchor on the function declaration and the next sibling comment block.
// The viewer function is sandwiched between _ensureXLSX and the
// `// Generic photo-bundle ZIP exporter.` comment.
const startMarker = "function buildPhotoZipViewerHTML(";
const endMarker = "// Generic photo-bundle ZIP exporter.";
const start = src.indexOf(startMarker);
const end = src.indexOf(endMarker, start);
if (start < 0 || end < 0) {
  console.error("FAIL: function delimiters not found (start=" + start + ", end=" + end + ")");
  process.exit(1);
}
const fnSrc = src.slice(start, end).trim();
// Compile + bind into the current scope.
// eslint-disable-next-line no-eval
eval(fnSrc);
if (typeof buildPhotoZipViewerHTML !== "function") {
  console.error("FAIL: function did not bind after eval");
  process.exit(1);
}

const sample = [
  {
    filename: "Wall/CRA-PRJ-INSP-W-001.jpg",
    iso_19650_filename: "CRA-PRJ-INSP-W-001",
    title: "Cracked tile at corner",
    description: "Hairline diagonal crack across two tiles near the basin.\nNeeds rework before handover. Note: defensive </script> tag in description should not break the viewer.",
    severity: "Critical", status: "Open", entry_type: "Defect",
    location: "L3 > Bath A > corner", assignee: "KH", trade: "Tiling",
    logged_by: "Anton", role: "Inspector",
    date: "2026-05-01", due_date: "2026-05-10",
    created_at: "2026-05-01T09:30:00+08:00",
    conquas_element: "Wall",
    ai_model: "gemini-2.5-flash", ai_confidence: 0.85, ai_prompt_version: "v1.2.0",
    human_reviewed: false,
    field_provenance: { severity: "ai", title: "human" },
    assessment_zone: "Architectural",
  },
  {
    filename: "Floor/CRA-PRJ-INSP-F-002.jpg",
    title: "Hairline crack on screed",
    severity: "Minor", status: "Verified", entry_type: "Defect",
    location: "L2 Lobby", trade: "Concreting",
    logged_by: "Mei",
    date: "2026-05-02",
    created_at: "2026-05-02T14:20:00+08:00",
    human_reviewed: true,
    conquas_element: "Floor",
    assessment_zone: "Structural",
  },
  {
    filename: "Door/CRA-PRJ-INSP-D-003.jpg",
    title: "Door frame chipped",
    severity: "Major", status: "In Progress", entry_type: "Update",
    location: "L1 Unit 03", assignee: "Subcon-A", trade: "Carpentry",
    date: "2026-04-20", due_date: "2026-04-25",
    created_at: "2026-04-20T11:00:00+08:00",
    conquas_element: "Door",
    assessment_zone: "Architectural",
  },
];

const html = buildPhotoZipViewerHTML({
  projectName: "Smoke Test Project — Block 12",
  generatedAt: "2026-05-03T12:00:00.000Z",
  entries: sample,
  workCategory: "CONQUAS",
  variantTitle: "CONQUAS — Internal Finishes",
  schemaBaseUri: "https://siteshrimp.org/schema/entries/v1.json",
  schemaVariantUri: "https://siteshrimp.org/schema/entries/conquas/v1.json",
  scheme: "conquas",
});

const checks = [
  ["starts with DOCTYPE", html.startsWith("<!DOCTYPE html>")],
  ["closes html tag", html.trimEnd().endsWith("</html>")],
  ["embeds ENTRIES const", html.includes("const ENTRIES=")],
  ["mentions WHO/WHAT/WHEN/WHERE/HOW", ["WHO","WHAT","WHEN","WHERE","HOW"].every(k=>html.includes(k))],
  ["mentions CONQUAS variant", html.includes("CONQUAS")],
  ["mentions schema URI", html.includes("siteshrimp.org/schema/entries/v1.json")],
  ["mentions 23 LANGUAGES", html.includes("23 LANGUAGES")],
  ["counts present", /3 TOTAL/.test(html) && /1 CRITICAL/.test(html)],
  // Two opening <script> tags (inline data + viewer code) must match exactly two
  // closing </script> tags. Any extra unescaped </script in the embedded JSON
  // would push the closing-count above the opening-count and break parsing.
  ["script open/close balanced", (html.match(/<script\b/gi)||[]).length === (html.match(/<\/script>/gi)||[]).length],
  ["escaped </script form present in inline JSON", /<\\\/script/i.test(html)],
];

let allOk = true;
for (const [name, ok] of checks) {
  console.log((ok ? "PASS " : "FAIL ") + name);
  if (!ok) allOk = false;
}
console.log("HTML size: " + html.length + " bytes (" + (html.length / 1024).toFixed(1) + " KB)");

const outPath = path.join(__dirname, "..", "output", "test-viewer.html");
fs.writeFileSync(outPath, html);
console.log("Wrote " + outPath);

process.exit(allOk ? 0 : 1);
