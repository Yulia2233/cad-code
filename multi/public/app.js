(() => {
  const apiBase = '/api/projects';
  const busyStates = new Set(['queued', 'running', 'exporting', 'evaluating', 'parts_queued', 'parts_running', 'assembly_running']);

  function projectItems(payload) {
    if (Array.isArray(payload)) return payload;
    return Array.isArray(payload?.projects) ? payload.projects : [];
  }

  function uniqueParts(project) {
    return Array.isArray(project?.unique_parts) ? project.unique_parts : [];
  }

  function attemptsFor(part) {
    return Array.isArray(part?.attempts) ? part.attempts : [];
  }

  function hasDeliverable(attempt, name) {
    const value = attempt?.deliverables?.[name];
    return typeof value === 'string' ? value.trim().length > 0 : Boolean(value);
  }

  function isAssemblyAttempt(attempt) {
    return attempt?.status === 'completed'
      && hasDeliverable(attempt, 'model_py')
      && hasDeliverable(attempt, 'model_step');
  }

  function selectedAttempt(part) {
    return attemptsFor(part).find(attempt => attempt.id === part?.selected_attempt_id && isAssemblyAttempt(attempt));
  }

  function canStartAssembly(project) {
    const parts = uniqueParts(project);
    return parts.length > 0 && parts.every(part => Boolean(selectedAttempt(part)));
  }

  function assemblySelection(project) {
    if (!canStartAssembly(project)) return null;
    return uniqueParts(project).map(part => ({part_id: part.id, attempt_id: selectedAttempt(part).id}));
  }

  function formatVerdict(verdict) {
    if (verdict === null || verdict === undefined || verdict === '') return '无 verdict';
    if (typeof verdict === 'string') return verdict;
    try { return JSON.stringify(verdict, null, 2); } catch { return String(verdict); }
  }

  function assemblyAttempts(project) {
    if (!Array.isArray(project?.assembly_attempts)) return [];
    return project.assembly_attempts.map((attempt, index) => ({attempt, index}))
      .filter(row => typeof row.attempt?.id === 'string')
      .sort((a, b) => (Date.parse(b.attempt.started_at) || 0) - (Date.parse(a.attempt.started_at) || 0) || b.index - a.index)
      .map(row => row.attempt);
  }

  function assemblyRoute(projectID, attemptID) {
    return `${apiBase}/${encodeURIComponent(projectID)}/assembly/${encodeURIComponent(attemptID)}`;
  }

  function conversationBusy(detail) {
    const type = detail?.session_status?.type;
    return ['busy', 'retry'].includes(type) || detail?.status === 'starting'
      || (!type && detail?.status === 'running');
  }

  function messageParts(message) {
    if (Array.isArray(message?.parts)) return message.parts;
    if (typeof message?.content === 'string') return [{type: 'text', text: message.content}];
    return [];
  }

  function readable(value) {
    if (value === undefined || value === null) return '';
    if (typeof value === 'string') return value;
    return JSON.stringify(value, null, 2);
  }

  function artifactLinks(projectID, attempt) {
    const files = [
      ['product_py', 'out/product.py'], ['product_step', 'out/product.step'],
      ['product_scadpkg', 'out/product.scadpkg'], ['assembly_report', 'out/assembly-report.json']
    ];
    return files.filter(([key]) => typeof attempt?.deliverables?.[key] === 'string' && attempt.deliverables[key].trim())
      .map(([, file]) => ({name: file.slice(4), href: `${assemblyRoute(projectID, attempt.id)}/file?path=${encodeURIComponent(file)}`}));
  }

  const helpers = {projectItems, uniqueParts, attemptsFor, hasDeliverable, isAssemblyAttempt, canStartAssembly, assemblySelection, formatVerdict, assemblyAttempts, assemblyRoute, conversationBusy, messageParts, artifactLinks};
  if (typeof window !== 'undefined') window.AssemblyWorkbench = helpers;
  if (typeof document === 'undefined') return;

  const $ = id => document.getElementById(id);
  const state = {projects: [], project: null, loading: false, action: false, interval: null, selections: loadSelections(), projectRequest: 0, assemblyRequest: 0, assemblyChoices: {}, assemblyKey: '', assemblyDetail: null, assemblyFingerprint: '', assemblySending: false, assemblyPending: false, drafts: {}};

  function loadSelections() {
    try {
      const value = JSON.parse(localStorage.getItem('cad-code-multi-selections') || '{}');
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    } catch { return {}; }
  }

  function saveSelections() {
    try { localStorage.setItem('cad-code-multi-selections', JSON.stringify(state.selections)); } catch {}
  }

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function request(path, options = {}) {
    const response = await fetch(path, options);
    const raw = await response.text();
    let value;
    try { value = raw ? JSON.parse(raw) : {}; } catch { value = raw; }
    if (!response.ok) {
      const detail = typeof value === 'object' ? value?.error || value?.message : value;
      throw new Error(detail ? String(detail) : `HTTP ${response.status}`);
    }
    return value;
  }

  function online(value) {
    const node = $('connectionState');
    node.classList.toggle('online', value);
    node.classList.toggle('offline', !value);
    node.querySelector('span').textContent = value ? '已连接' : '连接失败';
  }

  function showError(message) {
    $('errorText').textContent = message;
    $('errorBanner').hidden = false;
  }

  function clearError() {
    $('errorBanner').hidden = true;
    $('errorText').textContent = '';
  }

  function statusClass(status) {
    return String(status || '').toLowerCase().replace(/[^a-z0-9_-]/g, '_');
  }

  function dateText(value) {
    if (!value) return '时间未知';
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? String(value) : date.toLocaleString();
  }

  function projectId(project) { return project?.id || project?.project_id || ''; }
  function projectName(project) { return project?.name || project?.source_name || project?.source?.name || project?.source?.filename || projectId(project) || '未命名项目'; }
  function projectStatus(project) { return project?.status || project?.state || 'unknown'; }

  function renderProjectList() {
    const list = $('projectList');
    list.replaceChildren();
    $('projectCount').textContent = String(state.projects.length);
    for (const project of state.projects) {
      const id = projectId(project);
      if (!id) continue;
      const button = el('button', 'project-item');
      button.type = 'button';
      button.setAttribute('aria-current', String(projectId(state.project) === id));
      button.append(el('strong', null, projectName(project)));
      const meta = el('small');
      meta.append(el('span', null, `${project.solid_count ?? '?'} solids`));
      meta.append(el('span', null, projectStatus(project)));
      button.append(meta);
      button.addEventListener('click', () => loadProject(id));
      list.append(button);
    }
    if (!list.childElementCount) list.append(el('p', 'muted', '暂无项目'));
  }

  function renderDedup(project) {
    const parts = uniqueParts(project);
    const container = $('dedupEvidence');
    const records = parts.map(part => ({part, evidence: part.dedup_evidence ?? part.dedup_method ?? part.dedup ?? part.evidence}));
    const known = records.filter(row => row.evidence !== undefined && row.evidence !== null && row.evidence !== '');
    $('dedupSummary').textContent = `${known.length}/${parts.length} 个唯一零件有记录`;
    container.replaceChildren();
    if (!known.length) {
      container.append(el('p', 'muted', '暂无去重记录'));
      return;
    }
    const list = el('div', 'dedup-list');
    for (const {part, evidence} of known) {
      const item = el('div', 'dedup-item');
      item.append(el('strong', null, part.id || '未命名零件'));
      const method = typeof evidence === 'string' ? evidence : (evidence.method || evidence.kind || JSON.stringify(evidence));
      item.append(el('code', null, method));
      const instances = part.instance_ids || part.instances || [];
      if (Array.isArray(instances)) item.append(el('span', null, `实例：${instances.length ? instances.join(', ') : '—'}`));
      list.append(item);
    }
    container.append(list);
  }

  function renderVerdict(attempt) {
    const node = el('pre', 'attempt-verdict', formatVerdict(attempt.verdict));
    return node;
  }

  function renderAttemptHistory(part) {
    const attempts = attemptsFor(part);
    const details = el('details', 'attempt-history');
    details.append(el('summary', null, `全部 attempt (${attempts.length})`));
    const list = el('div', 'attempt-list');
    for (const attempt of attempts) {
      const entry = el('div', 'attempt-entry');
      const head = el('div', 'attempt-head');
      head.append(el('span', null, attempt.id || '未知 ID'));
      head.append(el('span', null, attempt.status || 'unknown'));
      entry.append(head);
      const deliverables = el('div', 'attempt-deliverables');
      deliverables.append(el('span', null, `model.py ${hasDeliverable(attempt, 'model_py') ? '有' : '无'}`));
      deliverables.append(el('span', null, `model.step ${hasDeliverable(attempt, 'model_step') ? '有' : '无'}`));
      entry.append(deliverables, renderVerdict(attempt));
      if (attempt.error) entry.append(el('p', 'attempt-error', String(attempt.error)));
      list.append(entry);
    }
    if (!attempts.length) list.append(el('span', 'muted', '暂无 attempt'));
    details.append(list);
    return details;
  }

  function renderPart(part) {
    const row = el('article', 'part-row');
    const identity = el('div', 'part-identity');
    identity.append(el('strong', null, part.id || '未命名零件'));
    identity.append(el('small', null, `${(part.instance_ids || part.instances || []).length || 0} 个源实例`));
    row.append(identity);

    const evidence = el('div', 'part-evidence');
    const method = part.dedup_method || part.dedup_evidence?.method || part.dedup?.method || '未提供';
    evidence.append(el('span', null, '去重方式：'));
    evidence.append(el('strong', null, String(method)));
    row.append(evidence);

    const attempts = el('div', 'attempts');
    const label = el('label', 'attempt-select-label', '装配使用的 attempt');
    const select = el('select', 'attempt-select');
    select.setAttribute('aria-label', `${part.id || '零件'} 的装配 attempt`);
    const placeholder = el('option', null, '选择已完成且交付齐全的 attempt');
    placeholder.value = '';
    select.append(placeholder);
    for (const attempt of attemptsFor(part)) {
      const option = el('option', null, `${attempt.id || 'unknown'} · ${attempt.status || 'unknown'}`);
      option.value = attempt.id || '';
      option.disabled = !isAssemblyAttempt(attempt);
      option.selected = option.value === part.selected_attempt_id && !option.disabled;
      select.append(option);
    }
    select.value = selectedAttempt(part)?.id || '';
    label.append(select);
    select.addEventListener('change', () => {
      part.selected_attempt_id = select.value || null;
      const id = projectId(state.project);
      if (id) {
        state.selections[id] ||= {};
        if (part.selected_attempt_id) state.selections[id][part.id] = part.selected_attempt_id;
        else delete state.selections[id][part.id];
        saveSelections();
      }
      renderAssemblyControls();
    });
    attempts.append(label, renderAttemptHistory(part));
    row.append(attempts);
    return row;
  }

  function isProjectBusy(project) {
    if (!project) return false;
    if (busyStates.has(projectStatus(project))) return true;
    return uniqueParts(project).some(part => attemptsFor(part).some(attempt => busyStates.has(attempt.status)));
  }

  function renderAssemblyControls() {
    const ready = canStartAssembly(state.project);
    $('startAssembly').disabled = !ready || state.action || isProjectBusy(state.project);
    $('assemblyHint').textContent = ready
      ? '已为每个唯一零件选择可运行结果。'
      : '为每个唯一零件选择一个有 model.py 和 model.step 的已完成 attempt。';
  }

  function renderProject(project) {
    const saved = state.selections[projectId(project)] || {};
    for (const part of uniqueParts(project)) {
      const savedID = saved[part.id];
      const savedAttempt = attemptsFor(part).find(attempt => attempt.id === savedID && isAssemblyAttempt(attempt));
      if (savedAttempt) part.selected_attempt_id = savedAttempt.id;
      else if (!selectedAttempt(part)) part.selected_attempt_id = null;
    }
    state.project = project;
    $('emptyState').hidden = Boolean(project);
    $('projectView').hidden = !project;
    if (!project) {
      $('selectedModel').textContent = '未报告';
      $('projectTitle').textContent = '—';
      return;
    }

    $('projectTitle').textContent = projectName(project);
    $('projectId').textContent = projectId(project) || '—';
    $('projectStatus').textContent = projectStatus(project);
    $('projectStatus').className = `status-pill ${statusClass(projectStatus(project))}`;
    $('solidCount').textContent = project.solid_count ?? project.counts?.instances ?? project.source?.solid_count ?? project.source?.solid_occurrences ?? '—';
    const parts = uniqueParts(project);
    $('uniqueCount').textContent = String(parts.length);
    $('completedCount').textContent = String(parts.filter(part => attemptsFor(part).some(attempt => attempt.status === 'completed')).length);
    $('evaluationState').textContent = ({passed:'通过',failed:'未通过',available:'就绪',not_evaluated:'尚未评测'})[project.assembly_evaluation_status] || '尚未评测';
    $('selectedModel').textContent = project.selected_model || '未报告';
    $('lastUpdated').textContent = project.updated_at ? `更新 ${dateText(project.updated_at)}` : '';
    $('stopProject').hidden = !isProjectBusy(project);
    $('stopProject').disabled = state.action;
    renderDedup(project);

    const list = $('partsList');
    list.replaceChildren(...parts.map(renderPart));
    $('partsEmpty').hidden = parts.length > 0;
    const complete = parts.filter(part => attemptsFor(part).some(attempt => attempt.status === 'completed')).length;
    $('partsProgress').textContent = `${complete}/${parts.length} 个零件至少有一个已完成 attempt`;
    $('runParts').disabled = state.action || isProjectBusy(project) || parts.length === 0;
    renderAssemblyControls();
    renderAssemblyAttemptPicker();
    renderProjectList();
  }

  function activeAssemblyAttempt() {
    return assemblyAttempts(state.project).find(attempt => attempt.id === state.assemblyChoices[projectId(state.project)]);
  }

  function renderAssemblyAttemptPicker() {
    const id = projectId(state.project), attempts = assemblyAttempts(state.project);
    if (!attempts.some(attempt => attempt.id === state.assemblyChoices[id])) state.assemblyChoices[id] = attempts[0]?.id || '';
    const select = $('assemblyAttemptSelect');
    select.replaceChildren();
    for (const attempt of attempts) {
      const option = el('option', null, `${attempt.id} · ${attempt.status || 'unknown'}`);
      option.value = attempt.id;
      select.append(option);
    }
    if (!attempts.length) select.append(el('option', null, '暂无装配 attempt'));
    select.value = state.assemblyChoices[id];
    select.disabled = !attempts.length;
    const key = attempts.length ? `${id}/${select.value}` : '';
    if (key !== state.assemblyKey) {
      if (state.assemblyKey) state.drafts[state.assemblyKey] = $('assemblyFollowup').value;
      state.assemblyKey = key;
      state.assemblyRequest++;
      state.assemblyDetail = null;
      state.assemblyFingerprint = '';
      state.assemblyPending = false;
      $('assemblyFollowup').value = state.drafts[key] || '';
      $('assemblyConversationError').hidden = true;
      $('assemblyMessages').replaceChildren(el('p', 'empty-inline', key ? '正在读取装配对话…' : '开始装配后，对话和工具结果会出现在这里。'));
    }
    renderConversationControls();
    renderArtifacts();
  }

  function renderArtifacts() {
    const node = $('assemblyArtifactLinks');
    const links = artifactLinks(projectId(state.project), activeAssemblyAttempt());
    node.replaceChildren();
    for (const file of links) {
      const link = el('a', 'artifact-link', file.name);
      link.href = file.href;
      link.download = file.name;
      node.append(link);
    }
    if (!links.length) node.append(el('span', 'muted', '暂无已报告产物'));
  }

  function renderConversationControls() {
    const detail = state.assemblyDetail, attempt = activeAssemblyAttempt();
    const busy = conversationBusy(detail || attempt) || state.assemblyPending > Date.now();
    const ready = Boolean(detail?.session_id) && !state.assemblySending && !state.action;
    $('assemblySessionStatus').textContent = detail?.session_status?.type || detail?.status || attempt?.status || '暂无会话';
    $('assemblySessionMeta').textContent = detail?.session_id ? `Session ${detail.session_id}` : '';
    $('assemblyFollowup').disabled = !ready || busy;
    $('sendAssembly').disabled = !ready || busy || !$('assemblyFollowup').value.trim();
    $('refreshAssembly').disabled = !attempt;
    $('stopAssembly').hidden = !busy && !isProjectBusy(state.project);
    $('stopAssembly').disabled = state.action;
  }

  function renderConversation(messages) {
    const fingerprint = JSON.stringify(messages);
    if (fingerprint === state.assemblyFingerprint) return;
    state.assemblyFingerprint = fingerprint;
    const container = $('assemblyMessages'), nearBottom = container.scrollHeight - container.scrollTop - container.clientHeight < 60;
    const oldTop = container.scrollTop;
    const opened = new Set([...container.querySelectorAll('details[open]')].map(node => node.dataset.key));
    container.replaceChildren();
    for (const [index, message] of messages.entries()) {
      const info = message.info || message, role = info.role || 'unknown';
      const article = el('article', `assembly-message ${role === 'user' ? 'user-message' : ''}`);
      const heading = el('div', 'assembly-message-head');
      heading.append(el('strong', null, role === 'user' ? '你' : role === 'assistant' ? '装配 Agent' : role));
      if (info.time?.created) heading.append(el('time', null, dateText(info.time.created)));
      article.append(heading);
      for (const [partIndex, part] of messageParts(message).entries()) {
        if (part.type === 'text') article.append(el('div', 'assembly-message-text', part.text || ''));
        else if (part.type === 'tool' || part.type === 'reasoning') {
          const fold = el('details', `assembly-message-fold ${part.type}`);
          fold.dataset.key = String(part.id || `${info.id || index}-${partIndex}`);
          fold.open = opened.has(fold.dataset.key);
          if (part.type === 'reasoning') {
            fold.append(el('summary', null, part.text ? '思考 · 接口返回原文' : '思考 · 接口未返回文本'));
            if (part.text) fold.append(el('pre', null, part.text));
          } else {
            const toolState = part.state || {};
            fold.append(el('summary', null, `${part.tool || 'tool'} · ${toolState.status || 'unknown'}`));
            if (toolState.input !== undefined) fold.append(el('h3', null, '调用参数'), el('pre', null, readable(toolState.input)));
            if (toolState.output !== undefined) fold.append(el('h3', null, '工具结果'), el('pre', null, readable(toolState.output)));
            if (toolState.error) fold.append(el('pre', 'conversation-error', readable(toolState.error)));
          }
          article.append(fold);
        } else if (part.type === 'file') article.append(el('span', 'assembly-attachment', part.filename || part.mime || '附件'));
      }
      if (info.error) article.append(el('pre', 'conversation-error', readable(info.error?.data?.message || info.error?.message || info.error)));
      container.append(article);
    }
    if (!messages.length) container.append(el('p', 'empty-inline', '暂时没有消息。'));
    container.scrollTop = nearBottom ? container.scrollHeight : oldTop;
  }

  async function loadAssemblyConversation() {
    const attempt = activeAssemblyAttempt(), id = projectId(state.project), key = state.assemblyKey;
    if (!attempt) return;
    const requestID = ++state.assemblyRequest;
    try {
      const detail = await request(assemblyRoute(id, attempt.id));
      if (requestID !== state.assemblyRequest || key !== state.assemblyKey || id !== projectId(state.project)) return;
      state.assemblyDetail = detail;
      if (conversationBusy(detail)) state.assemblyPending = false;
      $('assemblyConversationError').hidden = true;
      renderConversation(Array.isArray(detail.messages) ? detail.messages : []);
      renderConversationControls();
    } catch (error) {
      if (requestID !== state.assemblyRequest || key !== state.assemblyKey) return;
      state.assemblyDetail = null;
      $('assemblyConversationError').textContent = error.message;
      $('assemblyConversationError').hidden = false;
      renderConversationControls();
    }
  }

  async function sendAssemblyMessage(event) {
    event.preventDefault();
    const attempt = activeAssemblyAttempt(), id = projectId(state.project), key = state.assemblyKey, text = $('assemblyFollowup').value;
    if (!attempt || !state.assemblyDetail?.session_id || state.assemblySending || state.action || state.assemblyPending > Date.now() || conversationBusy(state.assemblyDetail) || !text.trim()) return;
    state.assemblySending = true;
    renderConversationControls();
    try {
      await request(`${assemblyRoute(id, attempt.id)}/send`, {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({text})});
      state.drafts[key] = '';
      if (key === state.assemblyKey) {
        $('assemblyFollowup').value = '';
        state.assemblyPending = Date.now() + 8000;
        await loadAssemblyConversation();
      }
    } catch (error) {
      if (key === state.assemblyKey) {
        $('assemblyConversationError').textContent = error.message;
        $('assemblyConversationError').hidden = false;
      }
    } finally {
      state.assemblySending = false;
      renderConversationControls();
    }
  }

  async function loadProjects() {
    const payload = await request(apiBase);
    state.projects = projectItems(payload);
    renderProjectList();
    if (!state.project && state.projects.length) {
      const wanted = decodeURIComponent(location.hash.slice(1));
      await loadProject(state.projects.some(project=>projectId(project)===wanted) ? wanted : projectId(state.projects[0]));
    }
    else if (state.project) {
      const id = projectId(state.project);
      const summary = state.projects.find(project => projectId(project) === id);
      if (summary) await loadProject(id);
    }
  }

  async function loadProject(id) {
    if (!id) return;
    const requestID = ++state.projectRequest;
    try {
      const project = await request(`${apiBase}/${encodeURIComponent(id)}`);
      if (requestID !== state.projectRequest) return;
      if (!project.id && !project.project_id) project.id = id;
      renderProject(project);
      online(true);
      await loadAssemblyConversation();
    } catch (error) {
      if (requestID !== state.projectRequest) return;
      online(false);
      showError(error.message);
    }
  }

  async function createProject(event) {
    event.preventDefault();
    const file = $('stepFile').files?.[0];
    if (!file) return showError('请选择一个 STEP 文件。');
    if (!/\.st(?:ep|p)$/i.test(file.name)) return showError('文件扩展名必须是 .step 或 .stp。');
    const button = $('createProject');
    button.disabled = true;
    clearError();
    try {
      const form = new FormData();
      form.append('step', file, file.name);
      const project = await request(apiBase, {method: 'POST', body: form});
      $('stepFile').value = '';
      if (project.kind === 'single' && project.session_url) { location.assign(project.session_url); return; }
      await loadProjects();
      const id = projectId(project);
      if (id) await loadProject(id);
    } catch (error) {
      showError(error.message);
    } finally {
      button.disabled = false;
    }
  }

  async function runParts() {
    if (!state.project || state.action) return;
    const parallel = Number($('parallelCount').value);
    if (!Number.isInteger(parallel) || parallel < 1 || parallel > 40) return showError('并发数必须是 1 到 40 的整数。');
    state.action = true;
    $('runParts').disabled = true;
    clearError();
    try {
      await request(`${apiBase}/${encodeURIComponent(projectId(state.project))}/run-parts`, {
        method: 'POST', headers: {'content-type': 'application/json'},
        body: JSON.stringify({parallel, prompt: ''})
      });
      await loadProject(projectId(state.project));
    } catch (error) {
      showError(error.message);
    } finally {
      state.action = false;
      renderProject(state.project);
    }
  }

  async function assemble() {
    if (!state.project || state.action) return;
    const parts = assemblySelection(state.project);
    if (!parts) return;
    state.action = true;
    $('startAssembly').disabled = true;
    clearError();
    try {
      const id = projectId(state.project);
      const result = await request(`${apiBase}/${encodeURIComponent(id)}/assemble`, {
        method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({parts})
      });
      if (result.attempt_id) state.assemblyChoices[id] = result.attempt_id;
      if (id === projectId(state.project)) await loadProject(id);
    } catch (error) {
      showError(error.message);
    } finally {
      state.action = false;
      renderProject(state.project);
    }
  }

  async function stopProject() {
    if (!state.project || state.action) return;
    state.action = true;
    $('stopProject').disabled = true;
    clearError();
    try {
      await request(`${apiBase}/${encodeURIComponent(projectId(state.project))}/stop`, {method: 'POST'});
      state.assemblyPending = false;
      await loadProject(projectId(state.project));
    } catch (error) {
      showError(error.message);
    } finally {
      state.action = false;
      renderProject(state.project);
    }
  }

  $('uploadForm').addEventListener('submit', createProject);
  $('runParts').addEventListener('click', runParts);
  $('startAssembly').addEventListener('click', assemble);
  $('stopProject').addEventListener('click', stopProject);
  $('dismissError').addEventListener('click', clearError);
  $('assemblyAttemptSelect').addEventListener('change', () => {
    state.assemblyChoices[projectId(state.project)] = $('assemblyAttemptSelect').value;
    renderAssemblyAttemptPicker();
    loadAssemblyConversation();
  });
  $('refreshAssembly').addEventListener('click', loadAssemblyConversation);
  $('assemblyComposer').addEventListener('submit', sendAssemblyMessage);
  $('assemblyFollowup').addEventListener('input', () => {
    state.drafts[state.assemblyKey] = $('assemblyFollowup').value;
    renderConversationControls();
  });
  $('stopAssembly').addEventListener('click', stopProject);

  async function refresh() {
    if (state.loading) return;
    state.loading = true;
    try {
      const config=await request('/api/config');
      if(!state.project?.selected_model)$('selectedModel').textContent=config.model||'未报告';
      await loadProjects(); online(true);
    }
    catch (error) { online(false); if (!state.project) showError(error.message); }
    finally { state.loading = false; }
  }

  refresh();
  state.interval = setInterval(refresh, 4000);
})();
