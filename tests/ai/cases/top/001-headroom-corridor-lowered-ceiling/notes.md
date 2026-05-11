# Case TOP 001 — Headroom NC, common corridor

## Photo requirements

A real photo of a common-area corridor with a visibly lowered ceiling
section (drop-ceiling / bulkhead), ideally:

- Measuring tape or laser distance meter in frame showing the clearance
  value (e.g. 1850 mm)
- M&E services visible above the drop-ceiling (ductwork, sprinkler main,
  cable tray) so the *cause* is also evidenced
- Eye-level perspective to convey scale — a person standing under the
  bulkhead helps
- Avoid wide-angle distortion; the AI under-estimates clearance on
  fish-eye shots

If no measurement is visible, the case still works but `top_threshold_breached`
will be inferred rather than read.

## Why this case

Tests TOP-specific behaviour that goes beyond CONQUAS:

1. **Severity reinterpretation** — `severity: Critical` because the NC
   blocks TOP, NOT because the defect is structurally severe. The AI's
   default severity reasoning is photo-impact; the TOP variant addendum
   must override it to "TOP blocker = Critical".
2. **Verbatim clause reference** — `top_clause_ref` must read
   `"AD §C cl. C.3.2.1 (headroom >=2.0 m)"` exactly. The §, the cl.,
   the >=, and the m unit all matter — QP reports cite this verbatim.
3. **`top_readiness_gate: true`** — must be Boolean true (not "true" or
   "Yes"), because the downstream calculator filters on this flag to
   produce the "items blocking TOP" subset.
4. **`conquas_tier: null` and `checkpoint_match: null`** — the AI must
   refuse to emit CONQUAS-specific fields on a TOP photo. Hallucinating
   `conquas_tier: "3X"` here is a common failure mode.

## What's contractually at stake

Headroom is one of the top recurring TOP NCs per the BCA Audit & Inspection
Group's 2025 industry sharing. A QP-signed report missing this NC will fail
the BCA TOP inspection and result in a written direction → rectification
cycle → re-inspection (weeks of delay + cost). Catching it pre-TOP via
self-audit is the difference between "small ceiling rework" and "delay
TOP by a month".

## Common AI mistakes to watch for

- Emits `severity: Major` (under-grading — TOP blockers are Critical)
- Emits `conquas_tier: "3X"` (hallucinating a CONQUAS verdict for a non-
  CONQUAS context)
- Emits `top_clause_ref` paraphrased: e.g. "AD Section C clause 3.2.1"
  instead of `"AD §C cl. C.3.2.1"`
- Misses the threshold value (`top_threshold_breached: null` when the
  measurement IS visible)
- Emits `top_phase: "TOP"` when the photo is clearly a pre-TOP self-audit
  (worth flagging if user context describes it as such)
- Defaults `top_readiness_gate: false` for headroom NCs (every Critical
  headroom NC is a gate per the BCA Audit & Inspection sharing)
