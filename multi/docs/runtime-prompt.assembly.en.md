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

Keep the trajectory short and purposeful. Read the assembly extension's `SKILL.md`, its three required references, and the context index together in one tool call. Read extra part evidence only for a candidate you actually review. This task follows the assembly extension; do not load the generic assembly-from-scratch workflow when reusing the controller scaffold. Read exact SDK API pages only when you author or change those API calls.

For an unchanged static scaffold, skip planning narration and todo updates. Use this standard command to build once, inspect real constraint residuals, export the package and STEP, and write a factual `out/assembly-report.json`:

```sh
"$CAD_CODE_PYTHON" "{{SKILL_DIR}}/../../tools/assembly_delivery.py" --notebook out/product.py --index input/assembly-context-index.json --out out
```

Run the command with `yield_time_ms: 10000`; poll only if it is still running. A successful helper result already contains the measured constraints, residuals and artifact paths: use it for the final reply without rereading the report or listing files.

Do not write a build/delivery helper or inspect the SDK implementation. Preserve the controller's complete source tree and do not repeat successful checks; repair and rerun only after an observed failure. The helper reports build observations, not independent acceptance or inferred engineering intent. Add any reviewed candidate hypothesis to the report if needed. The controller performs independent acceptance after your turn; do not duplicate or invent its result. Finish with a brief result and unresolved assumptions.
