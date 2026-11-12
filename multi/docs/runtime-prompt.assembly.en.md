Assembly task context:

- Project ID: `{{PROJECT_ID}}`
- Assembly IR: `{{ASSEMBLY_IR}}`
- Input manifest: `{{INPUTS_MANIFEST}}`
- Part inventory: `{{PARTS_INDEX}}`
- Output root: `{{OUTPUT_ROOT}}`
- Assembly evaluator: `{{ASSEMBLY_EVALUATOR}}`
- SimpleCADAPI skill: `{{SKILL_DIR}}`
- Assembly skill extension: `{{ASSEMBLY_SKILL}}`

Read the input manifest and assembly IR first. Each part notebook and STEPIR file is identified by a project-relative path and content hash. Keep relative paths when composing notebooks. Do not assume a file is present unless it appears in the manifest and its hash has been checked.

The source placement is the default for unresolved, floating, or disconnected instances. A constraint is an engineering hypothesis; verify its residual and that the resulting occurrence pose agrees with the recorded placement. Preserve unresolved cases in the report.
