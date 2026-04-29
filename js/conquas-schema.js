// Canonical CONQUAS Private Residential 2025 schema.
// Source: BCA CONQUAS (Private Residential) Manual R1 §3.2(a) Appendix 1.
// Effective from 1 April 2026. Released 13 November 2025 (BCA/CPQ/QCD/C20251113).
//
// Verbatim — every checkpoint string in this file is reproduced exactly from
// the BCA manual. Do NOT paraphrase. Different terms mean different things in
// a CONQUAS NC assessment or a DLP claim.
//
// Consumers (current and future):
//   - deploy/pocketbase/pb_hooks/main.pb.js  (mirror copy used for AI binding)
//   - js/app.js  (future: TAG > CONQUAS wizard pre-fill)
//   - js/app.js  (future: REVIEW > Coverage matrix)
//
// When BCA releases R2/R3, bump `version`, replace strings verbatim from the
// new manual, mirror the change into pb_hooks/main.pb.js, and reseed.

var CONQUAS_PR_2025 = {
  version: "BCA-CONQUAS-PR-R1",
  effective: "2026-04-01",
  weighting: { IF: 0.40, FT: 0.40, EF: 0.20 },

  // Maps in-app severity (Critical/Major/Minor/Observation) to BCA NC tier.
  // Observation is intentionally null — it is not a CONQUAS NC, only logged
  // for context.
  severityToTier: {
    "Critical":    "3X",
    "Major":       "2X",
    "Minor":       "1X",
    "Observation": null
  },

  elements: {
    FLOOR: {
      section: "IF1",
      label: "Floor",
      checkpoints: {
        "1X": [
          "Stains",
          "Alignment",
          "Jointing",
          "Damages - Scratches, dents, chips"
        ],
        "2X": [
          "Unevenness (> 6mm/1.2m)",
          "Hollowness (for tiled floor as long as it is hollow)"
        ],
        "3X": [
          "Damages - Cracks",
          "Open veins felt with hand (>0.5mm width and >100mm length)",
          "Chipped timber",
          "Delamination (≥1 spot on timber finishing)",
          "Lippage for tiled floors"
        ]
      }
    },

    WALL: {
      section: "IF2",
      label: "Wall",
      checkpoints: {
        "1X": [
          "Cracks on plastered walls",
          "Patchy/roughness",
          "Alignment",
          "Jointing",
          "Damages - Scratches, dents, chips"
        ],
        "2X": [
          "Unevenness (>6mm/1.2m)",
          "Squareness (>8mm over 300mm)",
          "Hollowness (for tiled wall as long as it is hollow)"
        ],
        "3X": [
          "Damages - Visible cracks on finished walls OR open veins felt with hand (>0.5mm width and >100mm length)",
          "Delamination (≥1 spot on timber finishing)"
        ]
      }
    },

    CEILING: {
      section: "IF3",
      label: "Ceiling",
      checkpoints: {
        "1X": [
          "Stains",
          "Patchy/roughness",
          "Jointing",
          "Damages - Hairline cracks on plastered ceiling, chips, dents, scratches"
        ],
        "2X": [],
        "3X": [
          "Damages - Cracked ceiling board (>0.5mm width and 100m length)"
        ]
      }
    },

    DOOR: {
      section: "IF4",
      label: "Door",
      checkpoints: {
        "1X": [
          "Inconsistent joints/gaps",
          "Damages - Scratches, dents, chips"
        ],
        "2X": [
          "Fitting - movement, difficulty in open/closing, loose, functionally deficient"
        ],
        "3X": [
          "Misalignment & unevenness (>3mm/m or 1.2m spirit level)",
          "Damages - Cracked timber door leaf/frame",
          "Accessories Defects - Missing/broken/improper fixing of accessories, corroded accessories etc"
        ]
      }
    },

    WINDOW: {
      section: "IF5",
      label: "Window",
      checkpoints: {
        "1X": [
          "Inconsistent joints/gaps",
          "Damages - Scratches, dents"
        ],
        "2X": [
          "Fitting - movement, difficulty in open/closing, loose, functionally deficient"
        ],
        "3X": [
          "Damages - Cracked/chipped frame, cracked/chipped/broken windowpanes",
          "Accessories Defects - Missing/broken/improper fixing of accessories, corroded accessories etc"
        ]
      }
    },

    COMPONENT: {
      section: "IF6",
      label: "Component",
      checkpoints: {
        "1X": [
          "Inconsistent joints/gaps",
          "Unevenness",
          "Tonality",
          "Misalignment",
          "Damages - Scratches, dents"
        ],
        "2X": [
          "Fitting - movement, difficulty in open/closing, loose, functionally deficient"
        ],
        "3X": [
          "Damages - Cracked sanitary ware, cracked/chipped/broken shower screen, mirror and any glass items",
          "Accessories Defects - Missing/broken/improper fixing of accessories, corroded accessories, etc"
        ]
      }
    },

    ME_FITTINGS: {
      section: "IF7",
      label: "M&E Fittings",
      checkpoints: {
        "1X": [
          "Inconsistent joints/gaps",
          "Unevenness",
          "Misalignment",
          "Damages - Scratches, dents"
        ],
        "2X": [
          "Fitting - movement, difficulty in open/closing, loose, functionally deficient"
        ],
        "3X": [
          "Damages - All types of damages e.g. crack, chip, etc, fan coil unit leaking",
          "Accessories Defects - Missing/broken/improper fixing of accessories, corroded accessories, etc"
        ]
      }
    }
  }
};

// Browser global (consumed when index.html loads this file in a future patch).
if (typeof window !== "undefined") window.CONQUAS_PR_2025 = CONQUAS_PR_2025;
// CommonJS export (for tooling / Node-side consumers).
if (typeof module !== "undefined" && module.exports) module.exports = CONQUAS_PR_2025;
