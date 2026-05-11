# Case 001 — Hollow tile, kitchen wall

## Photo requirements

A real photo showing a ceramic-tile section of a kitchen wall, ideally:

- Tiles in good visual condition (no cracks, lippage, or chips)
- Inspector's finger / tap-tool visible mid-tap if possible
- Adjacent tiles framed in shot so the AI can read it as a tiled-wall context, not a single floating tile
- Some indication of "kitchen": tap, splashback edge, wall cabinet corner — anything

Drop the photo as `photo.jpg` in this directory.

## Why this case

Tests three things at once:

1. **Verbatim BCA terminology** — `defect_type` must be `Hollowness` (BCA GIP
   Ceramic Tiling vocabulary), NOT `loose tile` / `de-bonded` / `void`.
2. **CONQUAS tier mapping** — `conquas_tier` 2X maps to `severity` Major
   (per `js/conquas-schema.js` and the AI prompt severity-tier rule).
3. **`checkpoint_match` verbatim** — must exactly match the string
   `"Hollowness (for tiled wall as long as it is hollow)"` from BCA
   CONQUAS Private Residential R1 §3.2(a) Appendix 1, Wall element.

## What's contractually at stake

Hollowness is a DLP claim risk — buyers commonly invoke it during the
defect-liability period because hollow tiles progress to detached tiles
under thermal cycling. Mis-grading this as 1X (Minor / Observation) instead
of 2X (Major) understates the contractual exposure on the QP-stamped report.

## Common AI mistakes to watch for

- Emits `defect_type: "Loose tile"` (wrong — that's HDB BTO checklist wording,
  not BCA GIP)
- Emits `severity: "Minor"` because tile *looks* fine in photo (the defect
  is *acoustic*, not visual — the AI sometimes misses this)
- Emits `assessment_zone: "M&E"` because of the visible plumbing chase
  (wrong — it's an Architectural finish defect, the chase is just context)
- Emits `checkpoint_match` paraphrased (must be verbatim)
- Confidence > 0.95 when the photo angle doesn't actually show tap-test
  evidence (over-confident on acoustic defect)
