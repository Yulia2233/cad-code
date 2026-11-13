Assembly task context:

- Project ID: `{{PROJECT_ID}}`
- Complete assembly IR (controller/evaluator reference; do not read wholesale): `{{ASSEMBLY_IR}}`
- Complete input manifest (controller hash/coverage reference; do not read wholesale): `{{INPUTS_MANIFEST}}`
- Bounded assembly index for agent reasoning: `{{CONTEXT_INDEX}}`
- Output root: `{{OUTPUT_ROOT}}`
- Assembly evaluator: `{{ASSEMBLY_EVALUATOR}}`
- SimpleCADAPI skill: `{{SKILL_DIR}}`
- Assembly skill extension: `{{ASSEMBLY_SKILL}}`

The trusted controller validates all notebook, STEPIR, and assembly-IR hashes and creates a static source-pose scaffold before this session. Start with the bounded context index. Do not read the complete manifest, complete assembly IR, every child notebook, or every STEPIR into context. The full, immutable source snapshot remains available for independent evaluation. Use the index pages and query only local evidence for selected candidate relations.

The controller-generated `out/product.py` contains every unique `scad.use()`, a grounded reference, and a fixed spanning tree covering every source occurrence at its recorded placement. Per-occurrence connector frames are generated in controller-adapted child copies and independently residual-checked. Preserve complete occurrence coverage. You may replace a scaffold fixed edge with a sparse, evidence-supported motion relation for a candidate group, but never leave an occurrence unconstrained. Candidate and page reads must stay bounded; report the ids inspected and any candidate omitted due to uncertainty.

The source placement is the default for unresolved, floating, or disconnected instances. A constraint is an engineering hypothesis; verify its residual and that the resulting occurrence pose agrees with the recorded placement. Preserve unresolved cases in the report.
