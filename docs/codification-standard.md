# SiteShrimp — Codification Standard for ISO 19650 Filenames

**Status:** Normative for SiteShrimp evidence-photo filenames.
**Version:** 1.0 (2026-04-24).
**Authority:** This document satisfies **ISO 19650-2:2018 §5.1.7(b)** — *"each field to be assigned a value from an agreed and documented codification standard."* It is the documented codification the ISO text requires.
**Scope:** Vocabulary and patterns for every field used inside the filename convention defined in [iso19650-photo-meta-spec.md §3](iso19650-photo-meta-spec.md). This document does not define the data model — that belongs to the photo-meta spec; this document defines only the values.
**Adoption:** Per project, via the project information standard (ISO 19650-2 §5.1.4). A project's BEP normatively references this document; overrides happen in the BEP, not here.

---

## 1. Purpose & scope

A SiteShrimp filename has three logical layers:

```text
Container ID            : {Project}-{Originator}-{Volume}-{Level}-{Type}-{Role}-{Number}
Export-metadata segment : -{Suitability}-{Date}[-R{NN}]
Photo-evidence tail     : _{Seq}[_{Element}][_{Checkpoint}]_{Hash8}.{ext}
```

This document specifies for **every field**:

- Allowed characters / length.
- Value vocabulary (for enumerated fields).
- Fallback / sentinel rule when no source value exists.
- Worked examples.

The data model that persists and emits these values (the `photo_meta` collection, backfill, hooks) is defined in the photo-meta spec. When this codification changes, the builder function `isoNameForDefect` in [js/app.js](../js/app.js) and its mirror tables **must** be updated to match. See §13 for the change-control procedure.

---

## 2. Universal rules

These rules apply to every field.

| Rule | Value |
|---|---|
| Character set | ASCII `A-Z`, `a-z`, `0-9`, `-`, `_` only — no other punctuation, no whitespace, no Unicode. |
| Case normalisation | All emitted field values are uppercased at build time. Input values may be mixed case; the builder uppercases. |
| Field separator (within prefix) | Hyphen `-`. |
| Layer separator (prefix → tail) | First underscore `_` in the filename. Everything after that is the photo evidence tail. |
| Segment separator (within tail) | Underscore `_`. |
| Agreed exception | The **Checkpoint** segment may contain internal hyphens (e.g. `1X-WL-02`). The parser treats tail-segment-underscore as the split and does not split checkpoint on its internal hyphens. |
| Extension | Single lowercase extension appended after the final hash8 segment, e.g. `.jpg`. |
| Max filename length | 200 bytes (safely below NTFS 255 and S3 1024 limits, leaves margin for suffixes added by storage adapters). |
| Empty field sentinel | Literal `ZZ` per ISO 19650 convention ("whole project / not applicable"). |

Non-ASCII inputs are normalised via `slugCode()` at [js/app.js:50](../js/app.js#L50) which NFKD-normalises, strips non-ASCII, strips non-alphanumerics, and uppercases. Code-point loss is intentional — CDE filenames must be ASCII-safe.

---

## 3. Container ID fields

### 3.1 Project

| Property | Value |
|---|---|
| Source | `project.code` if set; else `slugCode(project.name, 6)`. |
| Length | 1–6 characters. |
| Pattern | `^[A-Z0-9]{1,6}$`. |
| Fallback | `XX` when project is unknown (should never happen in prod; indicates a bug). |
| Example | `PROJA`, `TNMRT`, `BOONL`. |

### 3.2 Originator

| Property | Value |
|---|---|
| Source | `company.code` if set; else `slugCode(company.name or company.companyName, 4)`. |
| Length | 1–4 characters. |
| Pattern | `^[A-Z0-9]{1,4}$`. |
| Fallback | `XX`. |
| Example | `ACME`, `II`, `OCL`. |

### 3.3 Volume

| Property | Value |
|---|---|
| Source | `defect.block`. Free-form site code: block, tower, phase, or building identifier. |
| Length | 1–8 characters (soft limit). |
| Pattern | `^[A-Z0-9]+$` after sanitisation. |
| Fallback | `ZZ` ("not applicable / whole project"). |
| Example | `B1`, `T03`, `P2A`. |

### 3.4 Level

| Property | Value |
|---|---|
| Source | `defect.locationLevel`. |
| Length | 1–6 characters. |
| Pattern | `^[A-Z0-9]+$` after sanitisation. |
| Fallback | `ZZ`. |
| Example | `L02`, `B1`, `RF`, `M2`. |

### 3.5 Type

Enumerated. See §7 for the full table.

### 3.6 Role

Enumerated. See §8.

### 3.7 Number

| Property | Value |
|---|---|
| Source | First 8 characters of `defect.id` or `defect.defect_id`. |
| Length | 1–10 characters (soft); 8 typical from `id.slice(0, 8)`. |
| Pattern | `^[A-Z0-9]{1,10}$`. |
| Fallback | `0000` if no id is available (should not happen post-save). |
| Example | `A1B2C3D4`, `F00DFACE`. |

The Number segment is the record's stable link back to the source row. It is **not** a human-assigned ticket number; SiteShrimp uses PocketBase's record ID so the link back is deterministic. Human-readable IDs like `DEF-0042` are surfaced via the separate `formatPhotoFilename` helper for Google Drive exports (see [NEXT.md "Structured photo filenames"](../NEXT.md)), not the ISO container ID.

---

## 4. Export-metadata segment

### 4.1 Suitability

Enumerated. See §9.

### 4.2 Date

| Property | Value |
|---|---|
| Source | `defect.createdAt` or `defect.timestamp_utc` as UTC. |
| Length | 8 characters. |
| Pattern | `^[0-9]{8}$` formatted `YYYYMMDD`. |
| Fallback | Today (UTC) when the record has no timestamp — extremely rare. |

Rationale for UTC: lexical sort = chronological sort; cross-region teams don't collide on mid-month boundaries. Local capture time is reconstructible from `defects.timezone` + `photo_meta.capture_offset_minutes` per the evidence-model spec.

### 4.3 Revision suffix (optional)

| Property | Value |
|---|---|
| Source | `photo_meta.revision`, only emitted when >1 or when explicitly requested. |
| Format | `-R{NN}` where NN is 2-digit zero-padded. Revisions >99 extend naturally (e.g. `R100`). |
| Pattern | `^R\d{2,}$`. |
| Fallback | Omitted entirely when revision is 1. |
| Example | `-R02`, `-R14`, `-R100`. |

The suffix attaches to the export-metadata segment using `-`, not `_`, so the photo-evidence tail's first-underscore boundary remains unambiguous.

---

## 5. Photo-evidence tail

### 5.1 Seq

| Property | Value |
|---|---|
| Source | `photo_meta.photo_index + 1`. The `+1` converts from 0-based index to 1-based sequence for human readability. |
| Length | 2 characters (supports up to 99; current PB limit is 5). |
| Pattern | `^\d{2,}$`, zero-padded. |
| Fallback | `01`. |
| Example | `01`, `03`, `05`. |

### 5.2 Element

Enumerated. See §6. Emitted only when present; absent for generic (non-CONQUAS) defects.

### 5.3 Checkpoint

| Property | Value |
|---|---|
| Source | `defect.checkpoint_id`. |
| Length | 1–24 characters. |
| Pattern | `^[A-Z0-9-]+$` — **internal hyphens permitted** as the agreed exception (rule §2). |
| Fallback | Omitted entirely when `checkpoint_id` is null. |
| Example | `1X-WL-02`, `3X-FL-01`, `2X-CE-05`. |

### 5.4 Hash8

| Property | Value |
|---|---|
| Source | First 8 hex characters of `photo_meta.derived_sha256`. |
| Length | Exactly 8 characters. |
| Pattern | `^[a-f0-9]{8}$` (lowercase, hex). |
| Fallback | Omitted if no hash is available (e.g. failed server-side hashing — should not happen post-enforcement). |
| Example | `a1b2c3d4`, `deadbeef`. |

Hash8 is a convenience anchor. The full SHA-256 lives in `photo_meta.derived_sha256` and is the evidential source of truth. **Do not treat Hash8 alone as collision-resistant**: 8 hex chars = 32 bits, birthday-collision probability reaches ~1% at ~9,000 photos. Use the full hash for dedup queries.

---

## 6. Element code lookup (CONQUAS)

Source of truth. Derived at filename build time from `defect.component_id`, `defect.checkpoint_id`, or `defect.trade` via `deriveElementCode(defect)` — not stored. Per **Decision 10.1** of the photo-meta spec, a stored `element_code` field is not introduced unless performance or historical-freeze demands arise.

### 6.1 Canonical element codes

| Code | CONQUAS Element | Typical `component_id` prefixes | Notes |
|---|---|---|---|
| `FL` | Floor (Internal) | `floor_`, `tile_floor_`, `vinyl_`, `marble_floor_`, `parquet_` | CONQUAS §3.3 Internal Finishes IF tier |
| `WL` | Wall (Internal) | `wall_`, `paint_wall_`, `tile_wall_`, `wallpaper_` | IF tier |
| `CL` | Ceiling | `ceiling_`, `plaster_ceiling_`, `acoustic_`, `gypsum_` | IF tier |
| `DR` | Door | `door_`, `door_frame_`, `ironmongery_`, `door_leaf_` | IF tier |
| `WD` | Window | `window_`, `aluminium_window_`, `glazing_`, `sill_` | IF tier |
| `CP` | Component | `vanity_`, `wardrobe_`, `kitchen_cab_`, `countertop_`, `sanitary_` | IF tier |
| `ME` | M&E Fittings | `switch_`, `socket_`, `light_`, `fan_`, `aircon_`, `tap_`, `plumbing_` | IF tier |
| `RF` | Roof | `roof_`, `gutter_`, `skylight_`, `flashing_` | External Finishes EF tier |
| `EW` | External Wall | `ext_wall_`, `cladding_`, `facade_`, `curtain_wall_` | EF tier |
| `EX` | External Works | `paving_`, `landscape_`, `drain_ext_`, `retaining_` | EF tier |

### 6.2 Derivation rules (in order)

1. If `defect.checkpoint_id` is set and has the CONQUAS pattern `^[1-3]X-([A-Z]{2})-\d+$`, extract the middle two characters. (e.g. `1X-WL-02` → `WL`.)
2. Else if `defect.component_id` matches a prefix in the table in §6.1, return that element.
3. Else if `defect.trade` is one of `Painting` / `Tiling` / `Waterproofing` / `Flooring`, return `FL` or `WL` by category. (Coarse fallback; flag `quality.warnings: ["element_derived_from_trade"]`.)
4. Else return `null` — no element segment emitted; filename is valid without it.

### 6.3 Non-CONQUAS projects

Projects with CONQUAS disabled in settings skip element derivation entirely; `element` is always null and the filename has no element segment. This is the expected default for Interior Works, FM, Infrastructure Works, Others work categories.

---

## 7. Type codes

Enumerated. The Type segment tells a CDE consumer *what kind of information container* this file carries.

### 7.1 SiteShrimp-defined type codes

| Code | Meaning | When emitted |
|---|---|---|
| `PH` | General photograph | Default for any photo that isn't specifically classified below. |
| `CQI` | CONQUAS Internal Finishes evidence | CONQUAS wizard photo, element in {FL, WL, CL, DR, WD, CP, ME}. |
| `CQE` | CONQUAS External Finishes evidence | CONQUAS wizard photo, element in {RF, EW, EX}. |
| `CQF` | CONQUAS Functional Test evidence | WTT / WPT / WFT photos logged via the FT capture flow. |
| `CQR` | CONQUAS Roof-specific | Reserved; use `CQE` with element `RF` until a project BEP requires finer granularity. |
| `DEF` | Defect / NC photo (non-CONQUAS) | Standard defect logged outside a CONQUAS wizard context. |
| `BFR` | Before rectification | Photo taken prior to fix work. Status should be `Open` or `In Progress`. |
| `AFT` | After rectification / verification | Verification photo on Close or Verify. Status should be `Verified` or `Closed`. |
| `MKP` | Marked-up photo | A photo with annotations baked in (freehand, arrows, text overlay). Distinct from raw evidence. |

### 7.2 ISO 19650 standard type codes (not used by SiteShrimp today)

ISO 19650-2 doesn't enumerate type codes; implementations pick. Common conventions in the UK National Annex include `DR` (Drawing), `M3` (3D model), `SK` (Sketch), `SP` (Specification), `SH` (Schedule), `CR` (Clash report), `PR` (Programme). SiteShrimp-defined codes above were chosen to avoid collision with these common conventions. If a project BEP mandates the UK NA codes, pre-map them in the BEP — this codification standard does not reserve them.

### 7.3 Selection rule

1. If the photo was captured in the CONQUAS wizard and element is internal → `CQI`.
2. If the photo was captured in the CONQUAS wizard and element is external → `CQE`.
3. If the photo was captured via a functional test → `CQF`.
4. If the photo is a post-fix verification → `AFT`.
5. If the photo is a pre-fix baseline → `BFR`.
6. If the photo has user markup baked in → `MKP`.
7. Else → `DEF` (defect context) or `PH` (neutral).

---

## 8. Role codes (trade → ISO role)

Derived via `roleFromTrade(defect.trade)` at [js/app.js:66](../js/app.js#L66). Mapping:

| Trade values | Role code |
|---|---|
| Architectural, Arch, Finishes, Painting, Tiling, Carpentry, Waterproofing, Interior | `A` |
| Structural, Structure, Concrete, Steel, Precast | `S` |
| Mechanical, HVAC, M&E, MEP, Plumbing | `M` |
| Electrical, Lighting, Wiring | `E` |
| Civil, Landscape, Drainage, Roads | `C` |
| QS, Cost, Quantity | `Q` |
| (anything else / unknown) | `Z` |

These codes are aligned to ISO 19650 Annex A Table A.2 conventions in the UK National Annex. They are not prescribed by base ISO 19650-2 text.

---

## 9. Suitability codes

The codes S1–S7 and A1–A7 are **UK National Annex** practice (BS EN ISO 19650-2:2018 National Annex); they are **not** in base ISO 19650 text. Per §0.2 of ISO 19650-2, national standards bodies define their own annexes; other jurisdictions may use different codes or omit them.

### 9.1 Adoption statement

SiteShrimp projects adopt the UK National Annex suitability codes **by default** and may override in the BEP. A project that has not adopted these codes should set `settings.project.iso_suitability_codes_enabled = false`; filenames then omit the suitability segment entirely.

### 9.2 Mapping from SiteShrimp status

Implemented by `suitabilityFromStatus(status)` at [js/app.js:75](../js/app.js#L75).

| SiteShrimp status | Suitability | ISO state | Meaning |
|---|---|---|---|
| Open | `S2` | Shared — issued for information | Can be used but not formally approved |
| In Progress | `S3` | Shared — issued for review and comment | Under coordination |
| InProgress (alias) | `S3` | — | — |
| Done | `S4` | Shared — issued for stage approval | Submitted for approval |
| Verified | `A1` | Published — authorised for use | Authorised for construction / asset management |
| Closed | `A2` | Published — authorised for use | Same authorisation family as A1, separate audit tier |
| (unknown) | `S2` | Shared — default | Safe fallback |

### 9.3 Out-of-scope codes

The UK NA defines additional codes (S6, S7 for archive; A3–A7 for different published tiers; `B1`/`B2`/`B3` for contract stages; CR for clash; `IA`/`IB` for initial issue). SiteShrimp does not emit these today. A project BEP that requires them extends the mapping via a project setting; this codification document does not enumerate them.

---

## 10. Grammar (ABNF-ish)

```text
filename       = container-id "-" suitability "-" date [ "-" revision ] [ tail ] "." ext
container-id   = project "-" originator "-" volume "-" level "-" type "-" role "-" number
project        = 1*6 ALPHANUM
originator     = 1*4 ALPHANUM
volume         = 1*8 ALPHANUM / "ZZ"
level          = 1*6 ALPHANUM / "ZZ"
type           = "PH" / "CQI" / "CQE" / "CQF" / "CQR" / "DEF" / "BFR" / "AFT" / "MKP"
role           = "A" / "S" / "M" / "E" / "C" / "Q" / "Z"
number         = 1*10 ALPHANUM
suitability    = "S" DIGIT / "A" DIGIT     ; UK NA only, per §9
date           = 8 DIGIT                   ; YYYYMMDD UTC
revision       = "R" 2*DIGIT
tail           = "_" seq [ "_" element ] [ "_" checkpoint ] "_" hash8
seq            = 2*DIGIT
element        = 2*3 ALPHA                 ; §6.1 values
checkpoint     = 1*24 ( ALPHANUM / "-" )   ; internal hyphens OK
hash8          = 8 HEX
ext            = "jpg" / "jpeg" / "png" / "webp"
ALPHANUM       = ALPHA / DIGIT
ALPHA          = %x41-5A
DIGIT          = %x30-39
HEX            = DIGIT / %x61-66           ; lowercase only
```

---

## 11. Worked examples

CONQUAS Internal Finishes, wall checkpoint 1X-WL-02, photo 1 of 3, status In Progress:

```text
PROJA-ACME-B1-L02-CQI-A-A1B2C3D4-S3-20260424_01_WL_1X-WL-02_a1b2c3d4.jpg
```

Generic defect photo, no CONQUAS link, status Open:

```text
PROJA-ACME-B1-L02-DEF-A-F00DFACE-S2-20260424_01_a1b2c3d4.jpg
```

After-rectification verification photo, status Verified, revision 2:

```text
PROJA-ACME-B1-L02-AFT-A-A1B2C3D4-A1-20260425-R02_01_a1b2c3d4.jpg
```

Whole-project functional test, M&E trade, status Done:

```text
PROJA-ACME-ZZ-ZZ-CQF-M-ABCDEF12-S4-20260424_01_ME_cafebabe.jpg
```

External finishes, roof component, 2 of 4 photos:

```text
PROJA-ACME-ZZ-RF-CQE-A-12345678-S2-20260424_02_RF_a1b2c3d4.jpg
```

---

## 12. Non-conformance handling

When a required source field is missing at build time:

| Field | Action |
|---|---|
| Project / Originator | Emit `XX`. This indicates a bug — log at error severity. |
| Volume / Level | Emit `ZZ`. Normal for whole-project records. |
| Type | Emit `PH`. |
| Role | Emit `Z`. |
| Number | Emit `0000`. This indicates the defect was never saved — should not happen post-save. |
| Suitability | Skip the export-metadata segment entirely if `iso_suitability_codes_enabled = false`; else emit `S2` as fallback. |
| Date | Use today (UTC). |
| Seq | Emit `01`. |
| Element | Omit segment. |
| Checkpoint | Omit segment. |
| Hash8 | Omit segment; flag in `quality.warnings`. |

---

## 13. Change control

### 13.1 What triggers a version bump

Increment this document's version when:

- A new Type code is added or retired.
- A new Element code is added or retired.
- The role-trade mapping table changes.
- The suitability adoption default changes (e.g. switching off UK NA as default).
- The grammar changes (e.g. lengthening a field's allowed length).
- The derivation rule ordering in §6.2 changes.

Cosmetic documentation fixes do not bump the version.

### 13.2 Revision-bump watched fields (referenced by photo-meta spec §10.4)

Re-analyze / re-save of a defect **bumps `photo_meta.revision`** when any of these fields differ from the previous saved value (non-no-op diff):

| Field on `defects` | Rationale |
|---|---|
| `title` | AI-derived description changed. |
| `description` | AI-derived description changed. |
| `severity` | Classification changed. |
| `trade` | Role code in filename changes. |
| `component_id` | Element code in filename changes. |
| `checkpoint_id` | Checkpoint segment in filename changes. |
| `photo[index]` bytes | New photo content. |
| `photoOriginal[index]` bytes | New uncompressed source. |

| Field on `photo_meta` | Rationale |
|---|---|
| `derived_sha256` | Derived photo bytes changed. |
| `original_sha256` | Original bytes changed. |
| `iso_filename` | Cached filename changed (should only happen via one of the above). |
| `quality` | Quality flags re-evaluated (e.g. post-backfill). |

Cosmetic fields (UI state, comments, reactions) do **not** bump revision. Bulk status changes in REVIEW **do** bump revision because Suitability flows into the filename.

### 13.3 Deprecation

When a code is deprecated, it remains in this document marked `(DEPRECATED — do not use for new photos)` for at least one version cycle. Backfill data retains old codes until a dedicated re-codification migration runs; that migration bumps `photo_meta.revision` for every affected row.

---

## 14. References

- [iso19650-photo-meta-spec.md](iso19650-photo-meta-spec.md) — the data-model spec this codification plugs into.
- [js/app.js](../js/app.js) — the builder (`isoNameForDefect`) and helper (`roleFromTrade`, `suitabilityFromStatus`, `slugCode`) implementing this codification.
- [tools/test-iso19650.js](../tools/test-iso19650.js) — test harness that validates the grammar round-trips.
- ISO 19650-1:2018 §3.3.12, §12.1 — information container + CDE metadata requirement.
- ISO 19650-2:2018 §5.1.4, §5.1.7(a)(b)(c) — project information standard; CDE unique-ID + metadata rules.
- BS EN ISO 19650-2:2018 UK National Annex — source of S1-S7 / A1-A7 suitability codes.
