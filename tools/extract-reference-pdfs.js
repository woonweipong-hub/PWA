// Extract bundled reference PDFs to reference-texts/*.txt + manifest.json.
// Source PDFs live outside the shipped repo (.claude/skills/construction-defects
// and contracts/PSSCOC — the skills folder is gitignored). Output .txt +
// manifest are committed so the static deploy serves them.
//
// Why pre-extract: shipping 25 PDFs would add 20–40 MB to the PWA; pre-extracted
// .txt is orders of magnitude smaller, loads instantly, and skips PDF.js at
// runtime for bundled references. User-uploaded PDFs still use PDF.js client-side.
//
// Requires: pdftotext on PATH (Xpdf / poppler-utils). On Windows mingw64 it's
// at /mingw64/bin/pdftotext. Install poppler if missing.
//
// Run: node tools/extract-reference-pdfs.js
//      npm run extract:refs

const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

const ROOT = path.resolve(__dirname, "..");
const SKILLS_DIR = path.join(ROOT, ".claude", "skills", "construction-defects");
const CONTRACTS_DIR = path.join(ROOT, "contracts");
const OUT_DIR = path.join(ROOT, "reference-texts");

// Per-document character cap. Keeps token budget manageable when several docs
// are selected at once. 20k chars ≈ 5k tokens per doc. Documents longer than
// this are truncated; the truncation point is logged in the manifest so the
// advisor prompt can warn the AI.
const MAX_CHARS_PER_DOC = 20000;

// Catalogue of reference documents. Each entry ships as a separate checkbox in
// the Requirements Advisor picker. Groups map to UI section headers.
// - id: short stable identifier; used as manifest key and filename (id.txt)
// - src: relative path from repo root to the source PDF
// - group: UI group ("contracts" | "conquas" | "bca_gip" | "hdb")
// - label: verbatim user-facing label (BCA/HDB/contract wording, not paraphrased)
// - description: one-line hover/subtext shown in picker
// - defaultWorkCats: array of work categories that tick this doc by default
// - defaultEditions: array of ontology_editions that tick this doc by default
const CATALOGUE = [
  // ── CONTRACTS ────────────────────────────────────────────────────
  {
    id: "psscoc-construction-2020",
    src: "contracts/PSSCOC/PSSCOC for Construction Works 2020.pdf",
    group: "contracts",
    label: "PSSCOC for Construction Works 2020",
    description: "Public Sector Standard Conditions of Contract — Construction Works (2020)",
    defaultWorkCats: ["*"],
    defaultEditions: ["*"],
  },
  {
    id: "psscoc-construction-lite-2025",
    src: "contracts/PSSCOC/PSSCOC for Construction Works Lite 2025.pdf",
    group: "contracts",
    label: "PSSCOC Construction Works Lite 2025",
    description: "Simplified PSSCOC for smaller works (2025)",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "psscoc-design-build-2020",
    src: "contracts/PSSCOC/PSSCOC for Design and Build 2020.pdf",
    group: "contracts",
    label: "PSSCOC for Design and Build 2020",
    description: "Design-and-build variant of PSSCOC (2020)",
    defaultWorkCats: [],
    defaultEditions: [],
  },

  // ── CONQUAS ──────────────────────────────────────────────────────
  {
    id: "conquas-private-residential",
    src: ".claude/skills/construction-defects/conquas-(private-residential)-manual.pdf",
    group: "conquas",
    label: "CONQUAS (Private Residential) Manual",
    description: "BCA CONQUAS manual for private residential — effective 1 Apr 2026",
    defaultWorkCats: ["Building Defects (Landed)", "Building Defects (Highrise)"],
    defaultEditions: ["private-residential-2026"],
  },
  {
    id: "conquas-2022-r2-v5",
    src: ".claude/skills/construction-defects/conquas-2022-r2-v5.pdf",
    group: "conquas",
    label: "CONQUAS 2022 R2 V5",
    description: "CONQUAS 2022 R2 v5 — non-residential (offices, retail, industrial, institutional)",
    defaultWorkCats: ["Facilities Management"],
    defaultEditions: ["2022"],
  },
  {
    id: "conquas-circular-2025",
    src: ".claude/skills/construction-defects/BCA-Circular-on-Launch-of-CONQUAS-Private-Residential.pdf",
    group: "conquas",
    label: "BCA Circular — Launch of CONQUAS (Private Residential)",
    description: "BCA/CPQ/QCD/C20251113 launch circular (13 Nov 2025)",
    defaultWorkCats: ["Building Defects (Landed)", "Building Defects (Highrise)"],
    defaultEditions: ["private-residential-2026"],
  },
  {
    id: "bca-quality-mark-scheme-2025",
    src: ".claude/skills/construction-defects/bca-quality-mark-scheme-2025.pdf",
    group: "conquas",
    label: "BCA Quality Mark Scheme",
    description: "BCA Quality Mark (QM) scheme guide — unit-by-unit assessment (22 May 2025)",
    defaultWorkCats: [],
    defaultEditions: [],
  },

  // ── BCA GOOD INDUSTRY PRACTICES (trade guides) ───────────────────
  {
    id: "gip-painting",
    src: ".claude/skills/construction-defects/bca-gip-painting.pdf",
    group: "bca_gip",
    label: "Painting",
    description: "BCA GIP — Painting",
    defaultWorkCats: ["Interior Works"],
    defaultEditions: [],
  },
  {
    id: "gip-ceramic-tiling",
    src: ".claude/skills/construction-defects/bca-gip-ceramic-tiling.pdf",
    group: "bca_gip",
    label: "Ceramic Tiling",
    description: "BCA GIP — Ceramic Tiling (3rd Ed)",
    defaultWorkCats: ["Interior Works"],
    defaultEditions: [],
  },
  {
    id: "gip-natural-stone-finishes",
    src: ".claude/skills/construction-defects/bca-gip-natural-stone-finishes.pdf",
    group: "bca_gip",
    label: "Natural Stone Finishes",
    description: "BCA GIP — Marble & Granite / Natural Stone Finishes",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-agglomerated-stone-tiling",
    src: ".claude/skills/construction-defects/bca-gip-agglomerated-stone-tiling.pdf",
    group: "bca_gip",
    label: "Agglomerated Stone Tiling",
    description: "BCA GIP — Agglomerated Stone (engineered/composite stone)",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-waterproofing-internal",
    src: ".claude/skills/construction-defects/bca-gip-waterproofing-internal.pdf",
    group: "bca_gip",
    label: "Waterproofing — Internal Wet Areas",
    description: "BCA GIP — Waterproofing for Internal Wet Areas",
    defaultWorkCats: ["Building Defects (Landed)", "Building Defects (Highrise)"],
    defaultEditions: [],
  },
  {
    id: "gip-waterproofing-external",
    src: ".claude/skills/construction-defects/bca-gip-waterproofing-external.pdf",
    group: "bca_gip",
    label: "Waterproofing — External Wall",
    description: "BCA GIP — Waterproofing for External Wall",
    defaultWorkCats: ["Building Defects (Landed)", "Building Defects (Highrise)"],
    defaultEditions: [],
  },
  {
    id: "gip-aluminium-window",
    src: ".claude/skills/construction-defects/bca-gip-aluminium-window.pdf",
    group: "bca_gip",
    label: "Aluminium Window",
    description: "BCA GIP — Aluminium Window",
    defaultWorkCats: ["Building Defects (Highrise)"],
    defaultEditions: [],
  },
  {
    id: "gip-timber-doors",
    src: ".claude/skills/construction-defects/bca-gip-timber-doors.pdf",
    group: "bca_gip",
    label: "Timber Doors",
    description: "BCA GIP — Timber Doors",
    defaultWorkCats: ["Interior Works"],
    defaultEditions: [],
  },
  {
    id: "gip-timber-flooring",
    src: ".claude/skills/construction-defects/bca-gip-timber-flooring.pdf",
    group: "bca_gip",
    label: "Timber Flooring",
    description: "BCA GIP — Timber Flooring",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-engineered-wood",
    src: ".claude/skills/construction-defects/bca-gip-engineered-wood.pdf",
    group: "bca_gip",
    label: "Engineered Wood Flooring",
    description: "BCA GIP — Engineered Wood Flooring",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-vinyl-flooring",
    src: ".claude/skills/construction-defects/bca-gip-vinyl-flooring.pdf",
    group: "bca_gip",
    label: "Vinyl Flooring",
    description: "BCA GIP — Vinyl Flooring",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-wardrobes-cabinets",
    src: ".claude/skills/construction-defects/bca-gip-wardrobes-cabinets.pdf",
    group: "bca_gip",
    label: "Wardrobes & Kitchen Cabinets",
    description: "BCA GIP — Wardrobes & Kitchen Cabinets",
    defaultWorkCats: ["Interior Works"],
    defaultEditions: [],
  },
  {
    id: "gip-precast-concrete",
    src: ".claude/skills/construction-defects/bca-gip-precast-concrete.pdf",
    group: "bca_gip",
    label: "Precast Concrete Elements",
    description: "BCA GIP — Precast Concrete Elements",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-drywall-partition",
    src: ".claude/skills/construction-defects/bca-gip-drywall-partition.pdf",
    group: "bca_gip",
    label: "Drywall Internal Partition",
    description: "BCA GIP — Drywall Internal Partition",
    defaultWorkCats: ["Interior Works"],
    defaultEditions: [],
  },
  {
    id: "gip-pbu",
    src: ".claude/skills/construction-defects/bca-gip-pbu.pdf",
    group: "bca_gip",
    label: "Prefabricated Bathroom Unit (PBU)",
    description: "BCA GIP — Prefabricated Bathroom Unit",
    defaultWorkCats: ["Building Defects (Highrise)"],
    defaultEditions: [],
  },
  {
    id: "gip-design-materials-vol1",
    src: ".claude/skills/construction-defects/bca-gip-design-materials-vol1.pdf",
    group: "bca_gip",
    label: "Design & Materials Selection — Vol 1",
    description: "BCA GIP — Design & Materials Selection for Quality (Vol 1)",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "gip-design-materials-vol2",
    src: ".claude/skills/construction-defects/bca-gip-design-materials-vol2.pdf",
    group: "bca_gip",
    label: "Design & Materials Selection — Vol 2",
    description: "BCA GIP — Design & Materials Selection for Quality (Vol 2)",
    defaultWorkCats: [],
    defaultEditions: [],
  },

  // ── Periodic Façade Inspection (PFI) ─────────────────────────────
  {
    id: "bca-pfi-competent-person",
    src: ".claude/skills/pfi/pfi-guidelines-for-competent-person.pdf",
    group: "conquas",
    label: "BCA PFI — Guidelines for Competent Person",
    description: "BCA Periodic Façade Inspection — Competent Person guidelines (v1.2, Jul 2022). Applies to buildings >20 yrs old, >13m high, excl. landed residential. 7-year inspection cycle.",
    defaultWorkCats: ["Facilities Management"],
    defaultEditions: [],
  },
  {
    id: "bca-pfi-faq",
    src: ".claude/skills/pfi/pfi-frequently-asked-questions.pdf",
    group: "conquas",
    label: "BCA PFI — Frequently Asked Questions",
    description: "BCA's PFI FAQ document covering scope, applicability, timelines, and competent-person responsibilities.",
    defaultWorkCats: ["Facilities Management"],
    defaultEditions: [],
  },
  {
    id: "sg-building-control-act",
    src: ".claude/skills/pfi/Building Control Act 1989.pdf",
    group: "contracts",
    label: "Singapore Building Control Act 1989",
    description: "Primary Act regulating building works in Singapore — basis for BCA's regulatory framework (PFI, PSI, structural / facade inspections).",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "sg-bc-periodic-inspection",
    src: ".claude/skills/pfi/Building Control (Periodic Inspection of Buildings.pdf",
    group: "contracts",
    label: "Building Control (Periodic Inspection of Buildings) Regulations",
    description: "Singapore subsidiary legislation on periodic inspection of buildings (structural + façade).",
    defaultWorkCats: ["Facilities Management"],
    defaultEditions: [],
  },
  {
    id: "sg-bc-reportable-matters",
    src: ".claude/skills/pfi/Building Control (Reportable Matters) Regulations .pdf",
    group: "contracts",
    label: "Building Control (Reportable Matters) Regulations",
    description: "Singapore regulations defining what constitutes a reportable matter under the Building Control Act — relevant to CP / QP statutory reporting duties.",
    defaultWorkCats: [],
    defaultEditions: [],
  },
  {
    id: "sg-bc-exterior-features",
    src: ".claude/skills/pfi/Building Control (Meaning of Exterior Features) Re.pdf",
    group: "contracts",
    label: "Building Control (Meaning of Exterior Features) Regulations",
    description: "Singapore regulations defining 'exterior features' — scope boundary for PFI inspection obligations.",
    defaultWorkCats: ["Facilities Management"],
    defaultEditions: [],
  },
  {
    id: "sg-bc-composition-offences",
    src: ".claude/skills/pfi/Building Control (Composition of Offences) Regulat.pdf",
    group: "contracts",
    label: "Building Control (Composition of Offences) Regulations",
    description: "Singapore regulations on composition of offences under the Building Control Act.",
    defaultWorkCats: [],
    defaultEditions: [],
  },

  // ── HDB ──────────────────────────────────────────────────────────
  {
    id: "uncledefect-hdb-bto-checklist",
    src: ".claude/skills/construction-defects/uncledefect-hdb-bto-checklist.pdf",
    group: "hdb",
    label: "HDB BTO Handover Checklist (UncleDefect)",
    description: "Room-by-room checklist for HDB BTO handover — third-party reference",
    defaultWorkCats: [],
    defaultEditions: [],
  },
];

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function extractPdfText(pdfPath) {
  // -layout preserves reading order for tables (CONQUAS Table 1/2/3 etc.).
  // Output to stdout via "-" second arg.
  const out = execFileSync("pdftotext", ["-layout", "-enc", "UTF-8", pdfPath, "-"], {
    encoding: "utf8",
    maxBuffer: 50 * 1024 * 1024,
  });
  // Normalise whitespace: collapse 3+ blank lines; strip form-feeds.
  return out.replace(/\f/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

function truncate(text, max) {
  if (text.length <= max) return { text, truncated: false };
  // Truncate on a sentence boundary if possible within 5% of cap
  const slack = Math.floor(max * 0.05);
  const window = text.slice(max - slack, max + slack);
  const period = window.lastIndexOf(". ");
  const cutAt = period > 0 ? max - slack + period + 1 : max;
  return { text: text.slice(0, cutAt).trim(), truncated: true };
}

function main() {
  ensureDir(OUT_DIR);

  const manifest = {
    generatedAt: new Date().toISOString().slice(0, 10),
    maxCharsPerDoc: MAX_CHARS_PER_DOC,
    groups: {
      contracts: { label: "Contracts", order: 1 },
      conquas: { label: "BCA CONQUAS", order: 2 },
      bca_gip: { label: "BCA Good Industry Practice", order: 3 },
      hdb: { label: "HDB", order: 4 },
    },
    documents: [],
  };

  const missing = [];
  const extracted = [];

  for (const doc of CATALOGUE) {
    const srcAbs = path.join(ROOT, doc.src);
    if (!fs.existsSync(srcAbs)) {
      missing.push(doc.id);
      continue;
    }
    try {
      const raw = extractPdfText(srcAbs);
      const { text, truncated } = truncate(raw, MAX_CHARS_PER_DOC);
      const outFile = path.join(OUT_DIR, `${doc.id}.txt`);
      fs.writeFileSync(outFile, text, "utf8");
      // Empty extraction = scanned-image PDF with no text layer. Flag it so the
      // UI can disable the checkbox with an "OCR required" hint rather than
      // silently shipping an empty checklist that contributes nothing to the
      // Advisor prompt.
      const textExtractionFailed = text.length < 500;
      manifest.documents.push({
        id: doc.id,
        group: doc.group,
        label: doc.label,
        description: doc.description,
        file: `reference-texts/${doc.id}.txt`,
        chars: text.length,
        truncated,
        textExtractionFailed,
        defaultWorkCats: doc.defaultWorkCats,
        defaultEditions: doc.defaultEditions,
      });
      extracted.push({ id: doc.id, chars: text.length, truncated, textExtractionFailed });
    } catch (e) {
      console.error(`  ✗ ${doc.id} — extraction failed: ${e.message}`);
    }
  }

  const manifestPath = path.join(OUT_DIR, "manifest.json");
  fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), "utf8");

  console.log(`Extracted ${extracted.length}/${CATALOGUE.length} reference documents`);
  const failed = [];
  for (const x of extracted) {
    const flags = [];
    if (x.truncated) flags.push("truncated");
    if (x.textExtractionFailed) { flags.push("NO TEXT LAYER"); failed.push(x.id); }
    const suffix = flags.length ? ` (${flags.join(", ")})` : "";
    console.log(`  ${x.textExtractionFailed ? "⚠" : "✓"} ${x.id} — ${Math.round(x.chars / 1000)}k chars${suffix}`);
  }
  if (failed.length) {
    console.log(`\n  ${failed.length} document(s) have no text layer (likely scanned images).`);
    console.log(`  They are flagged textExtractionFailed:true in the manifest; the UI`);
    console.log(`  disables their checkbox until OCR is added for those PDFs.`);
  }
  if (missing.length) {
    console.log(`\n  Skipped ${missing.length} (source PDF not found locally):`);
    for (const id of missing) console.log(`    - ${id}`);
    console.log(`\n  Place missing PDFs at paths listed in CATALOGUE and re-run.`);
  }
  console.log(`\nManifest written to ${manifestPath}`);
}

main();
