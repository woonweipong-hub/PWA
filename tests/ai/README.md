# AI evaluation harness

Labeled test cases + a scoring harness that runs `AI_VARIANT_TABLE` prompts from
`deploy/pocketbase/pb_hooks/main.pb.js` against real photos and reports
per-field accuracy. Use this to measure whether a prompt change helps or hurts
*before* shipping it.

## Layout

```
tests/ai/
  cases/
    conquas/<case_id>/
      expected.json   # ground truth + _meta block
      notes.md        # why this case, what the photo shows
      photo.jpg       # the actual photo (user-supplied; not in repo by default)
    top/<case_id>/
      ...
  fixtures/           # snapshots (ontology, etc.) for reproducibility
  runs/               # one JSON per eval run (gitignore this dir)
```

## `expected.json` shape

```jsonc
{
  "_meta": {
    "workCategory": "CONQUAS",   // routes the prompt to the right AI variant
    "description": "User context appended to the prompt (the `description` field on the defect)",
    "case_id": "001-hollow-tile-kitchen-wall",
    "labeler": "manual",
    "notes_file": "notes.md"
  },
  "category": "Wall",
  "defect_type": "Hollowness",
  "severity": "Major",
  // ... all fields from AI_OUTPUT_SCHEMA + variant fields
}
```

The fields outside `_meta` mirror the live `AI_OUTPUT_SCHEMA` (plus any
variant fields the workCategory adds). Use `null` when a field genuinely
doesn't apply.

## Running

```powershell
# Validate cases shape, no API calls (free, fast)
node tools/eval-ai.js --dry-run

# Real run against Gemini 2.5 Flash (free tier 1500 calls/day)
$env:GEMINI_API_KEY = "AIza..."
node tools/eval-ai.js --provider=gemini

# Run only one variant
node tools/eval-ai.js --filter=conquas

# Stop after first 5 cases
node tools/eval-ai.js --max=5
```

## Scoring

Per-field, weighted into a per-case score, rolled up per-variant and overall.

| Field type             | Scoring                                                |
|------------------------|--------------------------------------------------------|
| Enum (category, severity, conquas_tier, top_nc_category, ...) | Exact match → 1.0, else 0.0 |
| Boolean (top_readiness_gate, qm_major_defect, ...)            | Exact match → 1.0, else 0.0 |
| Number (confidence)    | Within ±0.15 → linear partial credit; further away decays |
| String (title, description, location, checkpoint_match) | Levenshtein-based similarity 0..1 |
| `null` ↔ `null`        | 1.0 (correct refusal to emit a value)                  |
| `null` ↔ non-null      | 0.0 (hallucination)                                    |

Schema validation runs in defence-in-depth on every output — schema errors are
reported separately from accuracy scores so a malformed-but-close output is
distinguishable from a well-formed-but-wrong one.

## Source-of-truth coupling

The harness never duplicates the AI prompt. It reads
`deploy/pocketbase/pb_hooks/main.pb.js` and uses Node's `vm` module to load
`AI_PROMPT_VERSION`, `AI_SERVER_PROMPT`, `AI_OUTPUT_SCHEMA`, `AI_VARIANT_TABLE`,
and `buildAiInputs()` directly. Bump `AI_PROMPT_VERSION` whenever you change
prompts and the run log stamps the version automatically so you can diff
accuracy across prompt versions.

## Adding a case

1. Pick a real photo from a site walk.
2. Decide which variant it tests (CONQUAS / TOP Inspection / Quality Mark / ...).
3. Create `tests/ai/cases/<variant>/<NNN-short-slug>/`.
4. Drop `photo.jpg` into it.
5. Write `expected.json` with the verbatim correct output for every field.
6. Write `notes.md` explaining what the photo shows and why this verdict is
   contractually correct (cite the BCA clause / GIP terminology).
7. Run `node tools/eval-ai.js --filter=<NNN-short-slug>` to verify it scores.

## Recommended starter set

| Variant   | Target | Spread |
|-----------|--------|--------|
| CONQUAS   | 50     | ~7 per element (Floor / Wall / Ceiling / Door / Window / Component / M&E Fittings) × mix of 1X / 2X / 3X, including ~5 pass cases |
| TOP       | 30     | weighted to common NCs: Headroom, Safety-from-Falling (barriers + gaps), Staircase, Accessibility |
| Quality Mark | 30  | one per QM Architectural Item × QM Defect Category combination |
| Buildability | 20  | one per project_category × structural_system combination |

50 + 30 + 30 + 20 = 130 cases gives statistically meaningful per-variant signal.
30 CONQUAS alone is enough to start.

## Privacy

`photo.jpg` files may contain site context (signage, faces, addresses). Two
options:

- **Default** — gitignore `tests/ai/cases/**/photo.jpg` so labels are in repo
  but photos stay local.
- **Strict** — keep entire `tests/ai/cases/` out of git; share photos and
  labels via a private bucket.

Pick one and add to `.gitignore` before committing case labels.
