---
name: simplecadapi-assembly
description: Compose reconstructed SimpleCADAPI part notebooks into a multi-solid assembly using STEPIR v6.3 assembly data.
license: Apache-2.0
metadata:
  sdk-version: 2.2.7
  stepir-version: v6.3
  extension: assembly-only
---

# SimpleCADAPI Assembly Extension

This extension is selected only for an explicit assembly task whose inputs are
reconstructed part notebooks, their matching STEPIR v6.3 files, and an
assembly IR. It is not the single-part reverse-engineering skill.

## Routing boundary

- For a single solid, keep using the existing `simplecadapi` skill and its
  unchanged workflow, system prompt, and trajectory contract.
- For a multi-solid source, first use the existing single-part workflow to
  reconstruct each unique part. Load this extension only in the later assembly
  conversation, after those child notebooks and the assembly inputs have been
  selected.
- Do not edit, replace, or reinterpret the original single-part skill as an
  assembly workflow.

## Load order

1. Read this file.
2. Read `references/workflow.md` in full.
3. Read `references/assembly-ir.md` and
   `references/notebook-composition.md` before using their data or composing
   child notebooks.
4. Before the first call to a SimpleCADAPI operation, read its exact API page
   from the installed SimpleCADAPI 2.2.7 documentation.

## Required behavior

- Use SimpleCADAPI 2.2.7 for all CAD construction and assembly operations.
- Treat STEPIR v6.3 as the only compatible part IR for this extension. Each
  part face ID is scoped to that part's exact IR hash; never transfer face IDs
  between parts or to rebuilt geometry.
- Preserve each selected child notebook's modeling history and geometry. Make
  assembly-specific identity edits only in a copied child source tree, never
  in the selected original file.
- Preserve every source occurrence, including repeated instances of one unique
  part definition. A reused part definition does not reduce occurrence count.
- Distinguish measured geometry and source placement from inferred mechanical
  intent. Do not claim to have recovered the original assembly history.
- Use documented connectors and constraints only when the provided geometry
  supports them. A coaxial or touching relation alone does not prove that a
  joint is revolute, fixed, or sliding.
- If a component is floating, disconnected, or has ambiguous mating evidence,
  keep its source placement as the default static placement. Report it as a
  `source_placement` fallback, not as a solved mate.
- Do not invent supports, remove clearances, fuse separate parts, or move a
  component merely to make the assembly look connected.
- Deliver an assembly notebook, its complete relative child-source tree, a
  SimpleCADAPI package and STEP when requested, plus a report of component
  coverage, constraints, residuals, fallback placements, and assumptions.
- Report only evaluation results actually produced by the supplied evaluator.

## Workflow ownership

The references in this extension own assembly composition and validation.
The existing `simplecadapi` skill remains the owner of single-part modeling,
STEPIR inspection, and child-part repair. Return to that workflow when a child
part is invalid; do not repair it by silently changing the assembly copy.
