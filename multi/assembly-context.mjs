import fs from 'node:fs';
import path from 'node:path';

const PART_PAGE_SIZE = 48;
const OCCURRENCE_PAGE_SIZE = 96;
const MAX_CANDIDATES = 64;

function readJSONLHeader(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(64 * 1024);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    const newline = buffer.subarray(0, bytes).indexOf(0x0a);
    const line = buffer.subarray(0, newline < 0 ? bytes : newline).toString('utf8').trim();
    if (!line) throw Error('AssemblyContextError: empty STEPIR header');
    const header = JSON.parse(line);
    if (header.solids !== 1) throw Error('AssemblyContextError: STEPIR header must describe one solid');
    return header;
  } finally { fs.closeSync(fd); }
}

function pages(rows, size, prefix, role) {
  const result = [];
  for (let offset = 0, page = 0; offset < rows.length; offset += size, page++) {
    const name = `${prefix}-${String(page).padStart(4, '0')}.json`;
    result.push({target: `assembly-index/${name}`, role, content: JSON.stringify({
      schema_version: 'cad-code-assembly-index-page-v1', page, offset, total: rows.length,
      items: rows.slice(offset, offset + size),
    }, null, 2) + '\n'});
  }
  return result;
}

function compactCandidate(relation, source, index) {
  const evidence = typeof relation.evidence === 'string' ? relation.evidence.slice(0, 240)
    : Array.isArray(relation.evidence) ? relation.evidence.slice(0, 8).map(item => String(item).slice(0, 120)) : undefined;
  return {
    candidate_id: String(relation.candidate_id || relation.id || `${source}-${index}`).slice(0, 120),
    kind: String(relation.kind || 'unknown').slice(0, 80),
    instances: Array.isArray(relation.instances) ? relation.instances.slice(0, 4).map(value => String(value).slice(0, 128)) : [],
    parts: Array.isArray(relation.parts) ? relation.parts.slice(0, 4).map(value => String(value).slice(0, 128)) : undefined,
    distance_lower_bound_mm: Number.isFinite(relation.distance_lower_bound_mm) ? relation.distance_lower_bound_mm : undefined,
    axis_gaps_mm: Array.isArray(relation.axis_gaps_mm) ? relation.axis_gaps_mm.slice(0, 3) : undefined,
    evidence,
    source,
  };
}

export function buildAssemblyContextAssets({projectRoot, projectID, assemblyIRPath, assemblyIRHash, selectedParts}) {
  const irPath = path.resolve(projectRoot, assemblyIRPath);
  const assembly = JSON.parse(fs.readFileSync(irPath, 'utf8'));
  if (assembly.schema_version !== 'step-assembly-ir-v1') throw Error('AssemblyContextError: unsupported assembly IR');
  const staticPlan = createStaticConnectorPlan(assembly);
  const irParts = new Map((assembly.unique_parts || []).map(part => [part.id, part]));
  const inputParts = new Map(selectedParts.map(part => [part.part_id, part]));
  if (irParts.size !== inputParts.size || [...irParts.keys()].some(id => !inputParts.has(id))) {
    throw Error('AssemblyContextError: selected notebook inventory does not exactly match unique parts');
  }
  const counts = new Map();
  for (const instance of assembly.instances || []) counts.set(instance.part_id, (counts.get(instance.part_id) || 0) + 1);

  const partRows = [...irParts.values()].map(source => {
    const input = inputParts.get(source.id);
    const header = readJSONLHeader(path.resolve(projectRoot, input.stepir));
    const metrics = source.metrics || {};
    return {
      part_id: source.id,
      instance_count: counts.get(source.id) || 0,
      source_occurrence: source.representative_instance || null,
      dedup_method: source.dedup_method || 'unique',
      stepir_version: input.stepir_version,
      stepir_sha256: input.stepir_sha256,
      notebook_sha256: input.notebook_sha256,
      stepir_header: {bbox: header.bbox, volume_mm3: header.vol, area_mm2: header.area,
        solids: header.solids, counts: header.counts, types: header.types, relief: header.relief || null},
      bounds_mm: metrics.bbox_mm || null,
      bounds_size_mm: metrics.bbox_size_mm || null,
      face_count: metrics.face_count ?? header.counts?.face ?? null,
      verdict: input.stepeval_verdict ? {ok: input.stepeval_verdict.ok, riou: input.stepeval_verdict.riou} : null,
    };
  });
  const instanceRows = (assembly.instances || []).map(instance => {
    const occurrence = instance.source_occurrence || {};
    return {instance_id: instance.id, part_id: instance.part_id, placement: instance.placement,
      path: occurrence.path || null, name: occurrence.name || null, parent_path: occurrence.parent_path || null,
      alignment_mode: instance.alignment_mode || null};
  });
  const candidates = [];
  let candidateCount = 0;
  for (const [index, relation] of (assembly.suggested_mates || []).entries()) {
    candidateCount++;
    if (candidates.length < MAX_CANDIDATES) candidates.push(compactCandidate(relation, 'preprocessor_suggestion', index));
  }
  for (const [index, relation] of (assembly.relations || []).entries()) {
    if (relation.kind !== 'bbox_distance_lower_bound') {
      candidateCount++;
      if (candidates.length < MAX_CANDIDATES) candidates.push(compactCandidate(relation, 'assembly_relation', index));
    }
  }
  const exposedCandidates = candidates;
  const generatedPages = [
    ...pages(partRows, PART_PAGE_SIZE, 'parts', 'assembly_part_index_page'),
    ...pages(instanceRows, OCCURRENCE_PAGE_SIZE, 'occurrences', 'assembly_occurrence_index_page'),
    ...pages(exposedCandidates, MAX_CANDIDATES, 'candidates', 'assembly_candidate_index_page'),
  ];
  const summary = {
    schema_version: 'cad-code-assembly-context-index-v1',
    project_id: projectID,
    assembly_ir_sha256: assemblyIRHash,
    units: assembly.units || 'mm',
    coordinate_convention: assembly.coordinate_convention || null,
    source: {solid_occurrences: assembly.source?.solid_occurrences ?? instanceRows.length,
      unique_parts: partRows.length, hierarchy_status: assembly.hierarchy?.status || 'unknown'},
    counts: {occurrences: instanceRows.length, unique_parts: partRows.length,
      repeated_occurrences: instanceRows.length - partRows.length,
      candidate_relations_total: candidateCount,
      candidate_relations_exposed: exposedCandidates.length,
      candidate_relations_omitted: Math.max(0, candidateCount - exposedCandidates.length),
      bbox_relation_pairs_possible: assembly.relations_summary?.possible_pair_count ?? null,
      bbox_relation_pairs_retained: assembly.relations_summary?.retained_pair_count ?? null,
      bbox_relation_pairs_omitted: assembly.relations_summary?.omitted_pair_count ?? null},
    static_default: {strategy: staticPlan.strategy, ground_instance: staticPlan.ground_instance,
      fixed_edge_count: staticPlan.fixed_edges.length},
    pages: {parts: generatedPages.filter(row => row.role === 'assembly_part_index_page').map(row => row.target),
      occurrences: generatedPages.filter(row => row.role === 'assembly_occurrence_index_page').map(row => row.target),
      candidates: generatedPages.filter(row => row.role === 'assembly_candidate_index_page').map(row => row.target)},
    candidate_preview: exposedCandidates,
  };
  return {index: summary, pageFiles: generatedPages};
}

function placementFrame(placement) {
  const x = placement?.x_axis, y = placement?.y_axis, origin = placement?.origin;
  if (![x, y, origin].every(vector => Array.isArray(vector) && vector.length === 3 && vector.every(Number.isFinite))) {
    throw Error('AssemblyScaffoldError: placement vectors must be finite triples');
  }
  const dot = (a, b) => a.reduce((sum, value, index) => sum + value * b[index], 0);
  const norm = a => Math.sqrt(dot(a, a));
  const cross = (a, b) => [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]];
  if (Math.abs(norm(x)-1) > 1e-6 || Math.abs(norm(y)-1) > 1e-6 || Math.abs(dot(x,y)) > 1e-6) {
    throw Error('AssemblyScaffoldError: placement axes must be orthonormal');
  }
  return {origin, x, y, z: cross(x,y)};
}

function localFrameInParent(parent, world) {
  const basis = [parent.x, parent.y, parent.z];
  const transposeMultiply = vector => basis.map(axis => axis.reduce((sum, value, row) => sum + value * vector[row], 0));
  const delta = world.origin.map((value, index) => value - parent.origin[index]);
  return {origin: transposeMultiply(delta), x_axis: transposeMultiply(world.x), y_axis: transposeMultiply(world.y)};
}

export function createStaticConnectorPlan(assembly) {
  const instances = assembly?.instances || [];
  if (!instances.length) throw Error('AssemblyScaffoldError: source occurrences are required');
  const root = instances[0];
  const rootFrame = placementFrame(root.placement);
  const connectors = Object.create(null);
  const edges = [];
  connectors[root.part_id] = [{component_id: root.id, connector_id: 'static_anchor',
    placement: {origin: [0,0,0], x_axis: [1,0,0], y_axis: [0,1,0]}}];
  for (const instance of instances.slice(1)) {
    const frame = placementFrame(instance.placement);
    const connectorId = `static_fixed_${instance.id}`;
    (connectors[instance.part_id] ||= []).push({component_id: instance.id, connector_id: connectorId,
      placement: localFrameInParent(frame, rootFrame)});
    edges.push({constraint_id: `static_fixed_${instance.id}`, root_instance: root.id,
      instance_id: instance.id, root_connector: 'static_anchor', instance_connector: connectorId});
  }
  return {schema_version: 'cad-code-static-scaffold-plan-v1', strategy: 'source_pose_fixed_spanning_star',
    ground_instance: root.id, connectors, fixed_edges: edges};
}

export function createStaticAssemblyScaffold({assembly, parts, connectorPlan = createStaticConnectorPlan(assembly)}) {
  if (!Array.isArray(parts) || !parts.length || !Array.isArray(assembly?.instances) || !assembly.instances.length) {
    throw Error('AssemblyScaffoldError: parts and source occurrences are required');
  }
  const partIndex = new Map(parts.map((part, index) => [part.part_id, index]));
  const rows = assembly.instances.map(instance => {
    if (!partIndex.has(instance.part_id)) throw Error(`AssemblyScaffoldError: unknown part ${instance.part_id}`);
    const placement = instance.placement;
    if (!placement?.origin || !placement?.x_axis || !placement?.y_axis) throw Error(`AssemblyScaffoldError: invalid placement for ${instance.id}`);
    return {id: instance.id, part: partIndex.get(instance.part_id), part_id: instance.part_id,
      name: instance.source_occurrence?.name || instance.id, origin: placement.origin,
      x_axis: placement.x_axis, y_axis: placement.y_axis};
  });
  const lines = [
    '# /// script',
    '# requires-python = ">=3.10"',
    '# dependencies = ["simplecadapi==2.2.7"]',
    '#',
    '# [tool.simplecadapi]',
    '# id = "product"',
    '# revision = "1.0.0"',
    '# ///',
    'import marimo',
    '',
    'app = marimo.App()',
    '',
    'with app.setup:',
    '    import simplecadapi as scad',
    '',
    '@app.cell',
    'def _():',
  ];
  const partNames = parts.map((_, index) => `part_${String(index).padStart(4, '0')}`);
  parts.forEach((part, index) => {
    lines.push(`    ${partNames[index]} = scad.use(${JSON.stringify(`parts/${part.part_id}/model.py`)}, id=${JSON.stringify(part.part_id)})`);
  });
  const rootIndex = rows.findIndex(row => row.id === connectorPlan.ground_instance);
  if (rootIndex < 0) throw Error('AssemblyScaffoldError: grounded occurrence is missing');
  lines.push('    _parts = (' + partNames.join(', ') + (partNames.length === 1 ? ',' : '') + ')',
    '    _assembly = scad.make_assembly_rassembly(assembly_id=scad.notebook_id(), name="Static source-pose assembly")',
    '    _rows = ' + JSON.stringify(rows),
    '    for _row in _rows:',
    '        _placement = scad.make_placement_rplacement(origin=tuple(_row["origin"]), x_axis=tuple(_row["x_axis"]), y_axis=tuple(_row["y_axis"]))',
    '        _assembly = scad.add_component_rassembly(assembly=_assembly, item=_parts[_row["part"]], component_id=_row["id"], name=_row["name"], placement=_placement)',
    `    _assembly = scad.ground_component_rassembly(assembly=_assembly, component_id=${JSON.stringify(connectorPlan.ground_instance)})`,
    '    _static_edges = ' + JSON.stringify(connectorPlan.fixed_edges),
    '    for _edge in _static_edges:',
    '        _assembly = scad.add_fixed_constraint_rassembly(assembly=_assembly, constraint_id=_edge["constraint_id"],',
    '            connector_a=scad.make_connector_ref_rconnectorref(component_id=_edge["root_instance"], connector_id=_edge["root_connector"]),',
    '            connector_b=scad.make_connector_ref_rconnectorref(component_id=_edge["instance_id"], connector_id=_edge["instance_connector"]))',
    '    _assembly = scad.solve_assembly_constraints_rassembly(assembly=_assembly, strict=True)',
    '    product = _assembly',
    '    return (product,)',
    '', '', 'if __name__ == "__main__":', '    app.run()', '');
  return lines.join('\n');
}
