# Assembly IR Contract

The assembly IR is a deterministic description of source occurrences,
deduplicated part inputs, source poses, and measured relation evidence. It is
not a modeling history and does not decide engineering intent by itself.

## Version and coordinate rules

- Accept only `schema_version: "step-assembly-ir-v1"` and
  `units: "mm"` for this extension version.
- Each unique part binds a STEP file and a STEPIR v6.3 file by path and hash.
  Verify those hashes before use.
- `coordinate_convention` defines how each representative part maps into the
  source world. Follow it exactly; do not add an unrecorded transform.
- A placement has `origin`, `x_axis`, and `y_axis`. Its axes define a
  right-handed frame; `z_axis` is their cross product. Reject non-finite,
  non-orthogonal, or left-handed frames instead of guessing a correction.
- Values are in millimetres. Do not apply unit conversion twice.

## Entity and reference rules

- `unique_parts[]` is the set of notebook definitions to reconstruct or reuse.
  `instances[]` is the set of physical source occurrences to place. These
  counts are intentionally different when parts repeat.
- Every instance must reference an existing `part_id`; every instance ID must
  be unique. Preserve all entries, including coincident duplicate instances.
- Deduplication metadata describes why source geometry was grouped. It does
  not remove occurrence rows or prove that instances should be physically
  fused.
- A STEPIR face ID is valid only with its owning `part_id` and exact IR hash.
  It is not an identifier for a reconstructed face.
- `relations[]` are measured geometric facts. `suggested_mates[]` are
  hypotheses and require independent engineering justification. `unresolved[]`
  names uncertainty and its declared fallback.

## Interpretation

Use source placement as the default pose for every occurrence. Build an
explicit constraint only when evidence supports the relation and the expected
motion. Source proximity, overlap, coaxiality, or contact can inform a
hypothesis but does not, alone, identify a fixed, revolute, or prismatic
joint.

When a relation is ambiguous or the constraint solver cannot preserve the
required pose, keep the source placement and report the relation as unresolved
or degraded. Never rewrite the measured IR to make an inferred mate appear as
source truth.
