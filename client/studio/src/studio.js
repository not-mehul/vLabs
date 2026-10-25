/** The vLabs release this Studio was built with. */
const STUDIO_VERSION = __STUDIO_VERSION__;

// --- Application State Model ---
function createBlankTemplate() {
  return {
    title: "Untitled Lab",
    description: "",
    variables: [],
    content: [
      {
        title: "Section 1 · Briefing",
        collapsed: false,
        steps: [
          {
            type: "info",
            title: "Welcome",
            body: "Welcome, {{ FIRST_NAME }} (Seat {{ SEAT_ID }})! Review these instructions before proceeding.",
            collapsed: false,
            previewOpen: false,
            hints: [],
            solution: "",
            checkpoint: null
          }
        ]
      }
    ],
    images: []
  };
}

let templateData = createBlankTemplate();
let currentView = 'builder';
let globalSearchQuery = '';
let autoSaveTimer = null;
let isSidebarCollapsed = false;
let tokenSelectCallback = null;
let activeImageInsertContext = null;
let confirmModalCallback = null;

// --- Interactive Participant Preview State ---
let previewState = {
  progressiveGate: false,
  clearedCheckpoints: {}, // key: `${sIdx}-${stIdx}` -> boolean
  openedHints: {},        // key: `${sIdx}-${stIdx}-${hIdx}` -> boolean
  revealedSolutions: {},  // key: `${sIdx}-${stIdx}` -> boolean
  captures: {},           // key: captureVarName -> canonical string
  feedback: {},           // key: `${sIdx}-${stIdx}` -> { ok: boolean, msg: string }
  inputValues: {}         // key: `${sIdx}-${stIdx}` -> string
};

// --- Undo / Redo Ring-Buffer History Stack ---
const MAX_HISTORY_STATES = 35;
let historyStack = [];
let historyIndex = -1;
let historyDebounceTimer = null;
let isRestoringHistory = false;

function cloneStateForHistory(data) {
  return JSON.stringify({
    ...(data.kind === 'exam' ? { kind: 'exam' } : {}),
    title: data.title,
    description: data.description,
    variables: data.variables,
    content: data.content,
    images: data.images
  });
}

function pushHistorySnapshot(immediate = false) {
  if (isRestoringHistory) return;
  clearTimeout(historyDebounceTimer);

  const commit = () => {
    const snap = cloneStateForHistory(templateData);
    if (historyIndex >= 0 && historyStack[historyIndex] === snap) return;
    // Truncate redo branch
    historyStack = historyStack.slice(0, historyIndex + 1);
    historyStack.push(snap);
    if (historyStack.length > MAX_HISTORY_STATES) {
      historyStack.shift();
    } else {
      historyIndex++;
    }
    updateUndoRedoButtons();
  };

  if (immediate) {
    commit();
  } else {
    historyDebounceTimer = setTimeout(commit, 450);
  }
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('undoBtn');
  const redoBtn = document.getElementById('redoBtn');
  if (undoBtn) undoBtn.disabled = historyIndex <= 0;
  if (redoBtn) redoBtn.disabled = historyIndex >= historyStack.length - 1;
}

/** Back to a history snapshot. Inside vLabs the library is the app's, not part of the undo history. */
function restoreHistorySnapshot(json) {
  const images = templateData.images;
  templateData = JSON.parse(json);
  if (studioHost.embedded) templateData.images = images;
}

function performUndo() {
  if (historyIndex <= 0) return;
  isRestoringHistory = true;
  historyIndex--;
  try {
    restoreHistorySnapshot(historyStack[historyIndex]);
    refreshAllActiveViews();
    scheduleAutoSave(true);
    showToast('Undid last change', 'info');
  } catch (_) {}
  isRestoringHistory = false;
  updateUndoRedoButtons();
}

function performRedo() {
  if (historyIndex >= historyStack.length - 1) return;
  isRestoringHistory = true;
  historyIndex++;
  try {
    restoreHistorySnapshot(historyStack[historyIndex]);
    refreshAllActiveViews();
    scheduleAutoSave(true);
    showToast('Redid change', 'info');
  } catch (_) {}
  isRestoringHistory = false;
  updateUndoRedoButtons();
}

function refreshAllActiveViews() {
  renderBuilder();
  renderVariablesList();
  renderImagesGrid();
  if (currentView === 'preview') renderParticipantPreview();
  if (currentView === 'dependencies') renderDependencyGraph();
  if (currentView === 'validate') runFullValidation(false);
}

// --- Dynamic Textarea Auto-Grow Utility ---
function autoGrowTextarea(el, minHeight = 60) {
  if (!el || el.offsetParent === null) return;
  el.style.height = 'auto';
  const newHeight = Math.max(el.scrollHeight + 2, minHeight);
  el.style.height = `${newHeight}px`;
}

function autoGrowAllTextareas(parent = document) {
  requestAnimationFrame(() => {
    const textareas = parent.querySelectorAll ? parent.querySelectorAll('textarea.autogrow-textarea') : [];
    textareas.forEach(ta => autoGrowTextarea(ta));
  });
}

// --- Custom Confirmation Modal Helper ---
function openConfirmModal({ title = 'Confirm Action', message = 'Are you sure?', confirmText = 'Confirm', onConfirm = null }) {
  document.getElementById('confirmModalTitle').innerHTML = `<i class="ph-bold ph-warning text-amber-500"></i> ${escapeHtml(title)}`;
  document.getElementById('confirmModalMessage').textContent = message;
  const btn = document.getElementById('confirmModalActionBtn');
  btn.textContent = confirmText;
  confirmModalCallback = onConfirm;
  btn.onclick = () => {
    const cb = confirmModalCallback;
    closeConfirmModal();
    if (typeof cb === 'function') cb();
  };
  document.getElementById('confirmModal')?.classList.remove('hidden');
}

function closeConfirmModal() {
  document.getElementById('confirmModal')?.classList.add('hidden');
  confirmModalCallback = null;
}

function promptNewBlankLab() {
  document.getElementById('presetMenu')?.classList.add('hidden');
  openConfirmModal({
    title: 'Start New Blank Lab?',
    message: studioHost.embedded
      ? 'This will replace the template with a fresh blank lab. You can still use Undo (Ctrl+Z) right after if needed.'
      : 'This starts a new blank lab. The one you have open stays under Documents.',
    confirmText: 'Create Blank Lab',
    onConfirm: () => {
      if (!studioHost.allowsKind('lab')) return;
      if (!studioHost.embedded) studioDocs.startNew();
      templateData = { ...createBlankTemplate(), images: studioHost.embedded ? templateData.images || [] : [] };
      resetPreviewSimulation(false);
      pushHistorySnapshot(true);
      refreshAllActiveViews();
      scheduleAutoSave();
      showToast('Started a new blank lab template', 'success');
    }
  });
}

// --- Theme ---
// Only the theme is kept between visits. Studios before 1.19.0 also kept the
// removed AI text-polishing feature's settings here, an API key among them;
// reading the settings rewrites them without those.
let appSettings = { theme: 'dark' };

function loadAppSettings() {
  try {
    const saved = JSON.parse(localStorage.getItem('vlabs_studio_settings') || 'null');
    if (!saved || typeof saved !== 'object') return;
    if (saved.theme === 'dark' || saved.theme === 'light') appSettings.theme = saved.theme;
    if (Object.keys(saved).some(k => k !== 'theme')) saveAppSettings();
  } catch (_) {}
}

function saveAppSettings() {
  try {
    localStorage.setItem('vlabs_studio_settings', JSON.stringify(appSettings));
  } catch (_) {}
}

function initTheme() {
  const isDark = appSettings.theme === 'dark';
  document.documentElement.classList.toggle('dark', isDark);
  updateThemeButton(isDark);
}

function toggleDarkMode() {
  const isDark = document.documentElement.classList.toggle('dark');
  appSettings.theme = isDark ? 'dark' : 'light';
  saveAppSettings();
  updateThemeButton(isDark);
}

function updateThemeButton(isDark) {
  const headerIcon = document.getElementById('headerThemeIcon');
  if (headerIcon) headerIcon.className = isDark ? 'ph ph-sun text-base' : 'ph ph-moon text-base';
}

function toggleSidebarCollapse() {
  const sidebar = document.getElementById('mainSidebar');
  const labels = document.querySelectorAll('.sidebar-label');
  const outlineContainer = document.getElementById('sidebarOutlineContainer');
  isSidebarCollapsed = !isSidebarCollapsed;

  if (isSidebarCollapsed) {
    sidebar.classList.remove('w-60');
    sidebar.classList.add('w-14');
    labels.forEach(l => l.classList.add('hidden'));
    outlineContainer?.classList.add('hidden');
  } else {
    sidebar.classList.remove('w-14');
    sidebar.classList.add('w-60');
    labels.forEach(l => l.classList.remove('hidden'));
    outlineContainer?.classList.remove('hidden');
  }
}

function switchView(viewName) {
  currentView = viewName;
  ['builder', 'variables', 'dependencies', 'images', 'preview', 'validate'].forEach(v => {
    const el = document.getElementById(`view-${v}`);
    const nav = document.getElementById(`nav-${v}`);
    if (v === viewName) {
      el?.classList.remove('hidden');
      nav?.classList.add('bg-slate-100', 'dark:bg-white/[0.08]', 'text-slate-900', 'dark:text-white');
      nav?.classList.remove('text-slate-500', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-white/[0.04]');
    } else {
      el?.classList.add('hidden');
      nav?.classList.remove('bg-slate-100', 'dark:bg-white/[0.08]', 'text-slate-900', 'dark:text-white');
      nav?.classList.add('text-slate-500', 'dark:text-slate-400', 'hover:bg-slate-50', 'dark:hover:bg-white/[0.04]');
    }
  });

  if (viewName === 'preview') renderParticipantPreview();
  else if (viewName === 'validate') runFullValidation(false);
  else if (viewName === 'variables') renderVariablesList();
  else if (viewName === 'dependencies') renderDependencyGraph();
  else if (viewName === 'images') renderImagesGrid();
  else if (viewName === 'builder') autoGrowAllTextareas();
}

function updateMetadataCharCounters() {
  const titleLen = (templateData.title || '').length;
  const descLen = (templateData.description || '').length;
  const tCounter = document.getElementById('titleCharCounter');
  const dCounter = document.getElementById('descCharCounter');

  if (tCounter) {
    tCounter.textContent = `${titleLen} / 200`;
    tCounter.className = titleLen > 200
      ? 'text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400'
      : titleLen > 170
        ? 'text-[10px] font-mono font-semibold text-amber-600 dark:text-amber-400'
        : 'text-[10px] font-mono text-slate-400';
  }
  if (dCounter) {
    dCounter.textContent = `${descLen} / 1000`;
    dCounter.className = descLen > 1000
      ? 'text-[10px] font-mono font-bold text-rose-600 dark:text-rose-400'
      : descLen > 850
        ? 'text-[10px] font-mono font-semibold text-amber-600 dark:text-amber-400'
        : 'text-[10px] font-mono text-slate-400';
  }
}

function renderBuilder() {
  applyKindChrome();
  if (isExamMode()) return renderExamBuilder();
  const container = document.getElementById('sectionsContainer');
  if (!container) return;
  container.innerHTML = '';

  document.getElementById('templateTitle').value = templateData.title || '';
  document.getElementById('templateDescription').value = templateData.description || '';
  updateMetadataCharCounters();

  const q = globalSearchQuery.toLowerCase().trim();
  const sampleCtx = buildEvaluatedContext(1, 'Mary-Jane', "O'Neil");

  templateData.content.forEach((section, sIdx) => {
    const isCollapsed = Boolean(section.collapsed);
    const secMatches = !q || (section.title || '').toLowerCase().includes(q);
    const stepCount = (section.steps || []).length;

    const secEl = document.createElement('div');
    secEl.id = `section-card-${sIdx}`;
    secEl.className = 'bg-white dark:bg-surface-900 border border-slate-200/80 dark:border-white/[0.07] rounded-xl shadow-2xs overflow-hidden transition-all';

    secEl.innerHTML = `
      <!-- Section Header Bar -->
      <div class="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/50 dark:bg-surface-850/40">
        <div class="flex items-center space-x-2.5 flex-1 mr-3">
          <button data-action="toggle-section" data-sec-idx="${sIdx}" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-xs p-1 rounded-md hover:bg-slate-200/50 dark:hover:bg-white/[0.06] transition" title="Toggle Section">
            <i class="ph ${isCollapsed ? 'ph-caret-right' : 'ph-caret-down'}"></i>
          </button>
          <span class="text-[11px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-white/[0.07] text-slate-600 dark:text-slate-300">${String(sIdx + 1).padStart(2, '0')}</span>
          <input type="text" value="${escapeHtml(section.title || '')}" placeholder="Section title..."
            class="text-sm font-semibold tracking-tight text-slate-900 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-brand-500 focus:outline-none px-1 py-0.5 w-full transition"
            data-action="update-sec-title" data-sec-idx="${sIdx}">
          ${sectionTimeInputsHtml(section, sIdx, 'section')}
        </div>

        <div class="flex items-center space-x-1 shrink-0">
          <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500 mr-1.5 hidden sm:inline">${stepCount} ${stepCount === 1 ? 'step' : 'steps'}</span>
          <button data-action="move-sec-up" data-sec-idx="${sIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.06] transition" title="Move Section Up">
            <i class="ph ph-arrow-up text-xs"></i>
          </button>
          <button data-action="move-sec-down" data-sec-idx="${sIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.06] transition" title="Move Section Down">
            <i class="ph ph-arrow-down text-xs"></i>
          </button>
          <button data-action="duplicate-section" data-sec-idx="${sIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.06] transition" title="Duplicate Section">
            <i class="ph ph-copy text-xs"></i>
          </button>
          <button data-action="delete-section" data-sec-idx="${sIdx}" class="p-1 text-slate-400 hover:text-rose-600 rounded-md hover:bg-rose-50 dark:hover:bg-rose-950/30 transition" title="Delete Section">
            <i class="ph ph-trash text-xs"></i>
          </button>
        </div>
      </div>

      <!-- Section Body Container -->
      <div id="section-body-${sIdx}" class="${isCollapsed ? 'hidden' : 'p-4 sm:p-5 space-y-4'}">
        <div id="steps-container-${sIdx}" class="space-y-3.5"></div>

        <button data-action="add-step" data-sec-idx="${sIdx}" class="w-full py-2 border border-dashed border-slate-200 dark:border-white/[0.09] hover:border-slate-400 dark:hover:border-white/[0.2] rounded-lg flex items-center justify-center space-x-1.5 text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 text-xs font-medium transition bg-slate-50/40 dark:bg-surface-850/30">
          <i class="ph ph-plus text-xs"></i>
          <span>Add Step</span>
        </button>
      </div>
    `;

    container.appendChild(secEl);

    const stepsContainer = secEl.querySelector(`#steps-container-${sIdx}`);
    let stepCountRendered = 0;

    section.steps.forEach((step, stepIdx) => {
      if (step.checkpoint && step.checkpoint.capture) {
        sampleCtx[step.checkpoint.capture] = step.checkpoint.mode === 'pattern'
          ? (generateMaskExample(step.checkpoint.pattern) || 'SAMPLE-VAL')
          : substitutePlaceholders(step.checkpoint.answer || 'SAMPLE-VAL', sampleCtx);
      }

      const stepMatches = !q ||
        (step.title || '').toLowerCase().includes(q) ||
        (step.body || '').toLowerCase().includes(q) ||
        (step.solution || '').toLowerCase().includes(q) ||
        (step.checkpoint && (step.checkpoint.prompt || '').toLowerCase().includes(q));

      if (stepMatches || secMatches) {
        renderStepCard(stepsContainer, sIdx, stepIdx, step, sampleCtx);
        stepCountRendered++;
      }
    });

    if (q && stepCountRendered === 0 && !secMatches) {
      secEl.classList.add('hidden');
    }
  });

  renderOutline();
  updateBadges();
  runFullValidation(false);
  autoGrowAllTextareas(container);
}

function renderStepCard(parentEl, sIdx, stepIdx, step, sampleCtx) {
  const stepEl = document.createElement('div');
  stepEl.id = `step-card-${sIdx}-${stepIdx}`;
  stepEl.className = 'bg-white dark:bg-surface-850/90 border border-slate-200/80 dark:border-white/[0.07] rounded-xl p-4 space-y-3.5 transition-all';

  const typeDot = {
    desk: 'bg-amber-500',
    computer: 'bg-sky-500',
    info: 'bg-slate-400'
  }[step.type || 'desk'];

  const isStepCollapsed = Boolean(step.collapsed);
  const isPreviewOpen = Boolean(step.previewOpen);
  const bodyTextareaId = `step-body-${sIdx}-${stepIdx}`;

  const renderedInlineMd = isPreviewOpen
    ? parseMarkdownSafe(resolveMarkdownImages(step.body || '', sampleCtx))
    : '';

  stepEl.innerHTML = `
    <div class="flex flex-wrap items-center justify-between gap-2">
      <div class="flex items-center space-x-2 flex-1 min-w-[200px]">
        <button data-action="toggle-step" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.05]">
          <i class="ph ${isStepCollapsed ? 'ph-caret-right' : 'ph-caret-down'} text-xs"></i>
        </button>
        <div class="relative flex items-center">
          <span class="w-1.5 h-1.5 rounded-full ${typeDot} absolute left-2.5 pointer-events-none"></span>
          <select data-action="change-step-type" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}"
            class="text-[11px] font-medium pl-5 pr-2 py-1 rounded-md border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-surface-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer">
            <option value="desk" ${step.type === 'desk' ? 'selected' : ''}>Hands-On [desk]</option>
            <option value="computer" ${step.type === 'computer' ? 'selected' : ''}>Workstation [computer]</option>
            <option value="info" ${step.type === 'info' ? 'selected' : ''}>Read [info]</option>
          </select>
        </div>
        <input type="text" value="${escapeHtml(step.title || '')}" placeholder="Step ${stepIdx + 1} title (optional)..."
          class="text-xs font-medium text-slate-800 dark:text-slate-100 bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-brand-500 focus:outline-none px-1.5 py-0.5 flex-1 transition"
          data-action="update-step-title" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}">
      </div>

      <div class="flex items-center space-x-1 shrink-0">
        <button data-action="toggle-step-preview" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}"
          class="px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition ${isPreviewOpen ? 'bg-brand-50 dark:bg-brand-500/15 text-brand-600 dark:text-brand-300 border border-brand-200/60 dark:border-brand-500/30' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.05]'}" title="Toggle Live Split Preview (Seat 1)">
          <i class="ph ph-columns text-xs"></i>
          <span>Preview</span>
        </button>
        <button data-action="move-step-up" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-white/[0.05]" title="Move Up">
          <i class="ph ph-arrow-up text-xs"></i>
        </button>
        <button data-action="move-step-down" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-white/[0.05]" title="Move Down">
          <i class="ph ph-arrow-down text-xs"></i>
        </button>
        <button data-action="duplicate-step" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 rounded hover:bg-slate-100 dark:hover:bg-white/[0.05]" title="Duplicate Step">
          <i class="ph ph-copy text-xs"></i>
        </button>
        <button data-action="delete-step" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="p-1 text-slate-400 hover:text-rose-600 rounded hover:bg-rose-50 dark:hover:bg-rose-950/30" title="Delete Step">
          <i class="ph ph-trash text-xs"></i>
        </button>
      </div>
    </div>

    <div id="step-content-${sIdx}-${stepIdx}" class="${isStepCollapsed ? 'hidden' : 'space-y-3.5'}">
      <!-- Cohesive Markdown Editor Frame & Optional Split Preview -->
      <div class="${isPreviewOpen ? 'grid grid-cols-1 lg:grid-cols-2 gap-3.5 items-start' : ''}">
        <div class="rounded-lg border border-slate-200/90 dark:border-white/[0.08] overflow-hidden bg-slate-50/40 dark:bg-surface-900 focus-within:border-brand-500 dark:focus-within:border-brand-500 transition">
          ${renderMarkdownToolbar(bodyTextareaId, sIdx, stepIdx)}
          <textarea id="${bodyTextareaId}" rows="3"
            class="autogrow-textarea w-full text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-100 bg-transparent p-3 focus:outline-none placeholder:text-slate-400 min-h-[5rem] block"
            placeholder="Write imperative instructions... (e.g. Connect the cable to port {{ PORT_NUM }})."
            data-action="update-step-body" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}">${escapeHtml(step.body || '')}</textarea>
        </div>
        ${isPreviewOpen ? `
          <div class="bg-slate-50/70 dark:bg-surface-900/70 border border-slate-200/80 dark:border-white/[0.07] rounded-lg p-3.5 space-y-2">
            <div class="flex items-center justify-between border-b border-slate-200/60 dark:border-white/[0.06] pb-1.5">
              <span class="text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">
                Seat 1 Preview
              </span>
              <span class="text-[10px] font-mono text-slate-400">${escapeHtml(substitutePlaceholders(step.title || `Step ${stepIdx + 1}`, sampleCtx))}</span>
            </div>
            <div id="inline-preview-body-${sIdx}-${stepIdx}" class="prose-preview text-xs text-slate-700 dark:text-slate-200">
              ${renderedInlineMd}
            </div>
          </div>
        ` : ''}
      </div>

      ${step.type !== 'info' ? `
        <!-- Minimalist Add-Ons Footer: Hints, Solution & Checkpoint Gate -->
        <div class="pt-2 border-t border-slate-100 dark:border-white/[0.05] space-y-3">

          <!-- Hints List -->
          <div class="space-y-2">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <i class="ph ph-lightbulb text-amber-500 text-xs"></i>
                <span>Hints</span>
                <span class="text-[10px] font-mono text-slate-400">(${step.hints ? step.hints.length : 0}/20)</span>
              </span>
              <button data-action="add-hint" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition">
                + Add Hint
              </button>
            </div>
            ${(step.hints && step.hints.length > 0) ? `
              <div id="hints-list-${sIdx}-${stepIdx}" class="space-y-2">
                ${(step.hints || []).map((hint, hIdx) => {
                  const hintTextId = `hint-text-${sIdx}-${stepIdx}-${hIdx}`;
                  return `
                  <div class="bg-slate-50/70 dark:bg-surface-900/60 border border-slate-200/70 dark:border-white/[0.06] border-l-2 border-l-amber-500 rounded-lg p-2.5 space-y-2">
                    <div class="flex items-center justify-between gap-2">
                      <input type="text" value="${escapeHtml(hint.label || '')}" placeholder="Question prompt (e.g. Where is the patch panel?)"
                        class="text-xs font-medium text-slate-800 dark:text-slate-200 bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.07] rounded-md px-2.5 py-1 flex-1 focus:outline-none focus:border-brand-500"
                        data-action="update-hint-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-hint-idx="${hIdx}" data-field="label">
                      <button data-action="delete-hint" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-hint-idx="${hIdx}" class="text-slate-400 hover:text-rose-600 p-1 rounded">
                        <i class="ph ph-x text-xs pointer-events-none"></i>
                      </button>
                    </div>
                    <textarea id="${hintTextId}" rows="2" placeholder="Hint explanation (Markdown supported)..."
                      class="autogrow-textarea w-full text-xs font-mono text-slate-700 dark:text-slate-200 bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.07] rounded-md p-2 focus:outline-none focus:border-brand-500 min-h-[3.25rem]"
                      data-action="update-hint-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-hint-idx="${hIdx}" data-field="text">${escapeHtml(hint.text || '')}</textarea>
                  </div>
                `}).join('')}
              </div>
            ` : ''}
          </div>

          <!-- Walkthrough Solution -->
          <div class="space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="text-[11px] font-medium text-slate-500 dark:text-slate-400 flex items-center gap-1.5">
                <i class="ph ph-check-square-offset text-emerald-500 text-xs"></i>
                <span>Walkthrough Solution</span>
                <span class="text-[10px] text-slate-400 dark:text-slate-500 font-normal">· ${(step.hints && step.hints.length > 0) ? 'Unlocked after hints' : 'Available immediately'}</span>
              </span>
            </div>
            <textarea id="solution-${sIdx}-${stepIdx}" rows="2" placeholder="Optional step-by-step solution revealed after hints are opened..."
              class="autogrow-textarea w-full text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50/50 dark:bg-surface-900 border border-slate-200/80 dark:border-white/[0.07] rounded-lg p-2.5 focus:outline-none focus:border-brand-500 min-h-[3.25rem] transition"
              data-action="update-solution" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}">${escapeHtml(step.solution || '')}</textarea>
          </div>

          <!-- Checkpoint Gate -->
          <div>
            ${step.checkpoint ? `
              <div class="bg-slate-50/80 dark:bg-surface-900/80 border border-slate-200/90 dark:border-white/[0.08] border-l-2 border-l-brand-500 rounded-lg p-3.5 space-y-3">
                <div class="flex items-center justify-between">
                  <span class="text-[11px] font-semibold text-slate-800 dark:text-slate-200 flex items-center gap-1.5">
                    <i class="ph-fill ph-flag text-brand-600 dark:text-brand-400 text-xs"></i>
                    <span>Checkpoint Gate</span>
                  </span>
                  <button data-action="remove-checkpoint" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="text-[11px] font-medium text-slate-400 hover:text-rose-600 dark:hover:text-rose-400 transition">
                    Remove
                  </button>
                </div>

                <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                  <div class="sm:col-span-2">
                    <label class="block text-[10px] font-medium text-slate-400 mb-1">Question Prompt</label>
                    <input type="text" value="${escapeHtml(step.checkpoint.prompt || '')}" placeholder="Enter the value to continue..."
                      class="w-full text-xs text-slate-800 dark:text-slate-200 bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 focus:outline-none focus:border-brand-500"
                      data-action="update-cp-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-field="prompt">
                  </div>
                  <div>
                    <label class="block text-[10px] font-medium text-slate-400 mb-1">Validation Mode</label>
                    <select data-action="update-cp-mode" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}"
                      class="w-full text-xs bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500">
                      <option value="exact" ${step.checkpoint.mode !== 'pattern' ? 'selected' : ''}>Exact Match</option>
                      <option value="pattern" ${step.checkpoint.mode === 'pattern' ? 'selected' : ''}>Pattern Mask</option>
                    </select>
                  </div>
                </div>

                ${step.checkpoint.mode === 'pattern' ? `
                  <div class="space-y-2">
                    <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                      <div class="sm:col-span-2">
                        <div class="flex items-center justify-between mb-1">
                          <label class="text-[10px] font-medium text-slate-400">Mask (<code class="font-mono">9 A a X x ? * \\c</code>)</label>
                          <button type="button" data-on-click="copyMaskPreviewToPlaceholder(${sIdx}, ${stepIdx})" class="text-[10px] font-medium text-brand-600 dark:text-brand-400 hover:underline">
                            Sample: <span id="cp-mask-preview-${sIdx}-${stepIdx}" class="font-mono">${escapeHtml(generateMaskExample(step.checkpoint.pattern))}</span> (Use as placeholder)
                          </button>
                        </div>
                        <input type="text" value="${escapeHtml(step.checkpoint.pattern || '')}" placeholder="e.g. XXXX.XXXX.XXXX"
                          class="w-full text-xs font-mono bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500"
                          data-action="update-cp-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-field="pattern">
                      </div>
                      <div>
                        <label class="block text-[10px] font-medium text-slate-400 mb-1">Capture Variable</label>
                        <input type="text" value="${escapeHtml(step.checkpoint.capture || '')}" placeholder="e.g. SERIAL"
                          class="w-full text-xs font-mono bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500"
                          data-action="update-cp-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-field="capture">
                      </div>
                    </div>

                    <!-- Live Pattern Mask Tester -->
                    <div class="bg-white dark:bg-surface-850 border border-slate-200/70 dark:border-white/[0.06] rounded-md px-2.5 py-1.5 flex flex-col sm:flex-row sm:items-center gap-2">
                      <span class="text-[10px] font-medium text-slate-400 shrink-0">Test Mask:</span>
                      <input type="text" placeholder="Type sample entry to test against mask..."
                        data-on-input="runLiveMaskTest(${sIdx}, ${stepIdx}, this.value)"
                        class="flex-1 text-xs font-mono bg-transparent border-0 p-0 text-slate-800 dark:text-slate-200 focus:outline-none">
                      <span id="cp-mask-test-result-${sIdx}-${stepIdx}" class="text-[10px] font-mono text-slate-400 shrink-0">Ready</span>
                    </div>
                  </div>
                ` : `
                  <div class="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    <div class="sm:col-span-2">
                      <label class="block text-[10px] font-medium text-slate-400 mb-1">Expected Answer (use <code class="font-mono">|</code> for alternatives)</label>
                      <input type="text" value="${escapeHtml(formatCheckpointAnswers(step.checkpoint))}" placeholder="e.g. {{ HOST_IP }} | {{ HOST_CIDR }}"
                        class="w-full text-xs font-mono bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500"
                        data-action="update-cp-answers" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}">
                    </div>
                    <div>
                      <label class="block text-[10px] font-medium text-slate-400 mb-1">Capture Variable</label>
                      <input type="text" value="${escapeHtml(step.checkpoint.capture || '')}" placeholder="Optional (e.g. CONFIRMED_IP)"
                        class="w-full text-xs font-mono bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500"
                        data-action="update-cp-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-field="capture">
                    </div>
                  </div>
                `}

                <div>
                  <label class="block text-[10px] font-medium text-slate-400 mb-1">Input Placeholder Hint</label>
                  <input type="text" id="cp-placeholder-${sIdx}-${stepIdx}" value="${escapeHtml(step.checkpoint.placeholder || '')}" placeholder="e.g. 10.0.0.1XX"
                    class="w-full text-xs bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-700 dark:text-slate-300 focus:outline-none focus:border-brand-500"
                    data-action="update-cp-field" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" data-field="placeholder">
                </div>
              </div>
            ` : `
              <button data-action="add-checkpoint" data-sec-idx="${sIdx}" data-step-idx="${stepIdx}" class="text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-brand-600 dark:hover:text-brand-400 flex items-center gap-1.5 transition">
                <i class="ph ph-flag text-xs"></i>
                <span>+ Add Checkpoint Gate</span>
              </button>
            `}
          </div>
        </div>
      ` : ''}
    </div>
  `;

  parentEl.appendChild(stepEl);
}

function runLiveMaskTest(sIdx, stepIdx, sampleInput) {
  const resEl = document.getElementById(`cp-mask-test-result-${sIdx}-${stepIdx}`);
  if (!resEl) return;
  const pattern = templateData.content[sIdx]?.steps[stepIdx]?.checkpoint?.pattern || '';
  if (!sampleInput) {
    resEl.textContent = 'Type to test mask';
    resEl.className = 'text-[10px] font-mono text-slate-400 shrink-0';
    return;
  }
  const res = matchPatternMask(sampleInput, pattern);
  if (res.matched) {
    resEl.innerHTML = `<span class="text-emerald-600 dark:text-emerald-400 font-bold">✓ Valid → ${escapeHtml(res.canonical)}</span>`;
  } else {
    resEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-bold">✗ ${escapeHtml(res.error || 'Rejected')}</span>`;
  }
}

function copyMaskPreviewToPlaceholder(sIdx, stepIdx) {
  const step = templateData.content[sIdx]?.steps[stepIdx];
  if (!step || !step.checkpoint) return;
  const sample = generateMaskExample(step.checkpoint.pattern);
  if (!sample) return;
  step.checkpoint.placeholder = `e.g. ${sample}`;
  const inputEl = document.getElementById(`cp-placeholder-${sIdx}-${stepIdx}`);
  if (inputEl) inputEl.value = step.checkpoint.placeholder;
  pushHistorySnapshot();
  scheduleAutoSave();
  showToast(`Updated placeholder to "e.g. ${sample}"`, 'success');
}

function toggleAllStepPreviews() {
  let anyOpen = false;
  const items = (s) => s.items || s.steps || [];
  templateData.content.forEach(s => items(s).forEach(st => { if (st.previewOpen) anyOpen = true; }));
  const nextState = !anyOpen;
  templateData.content.forEach(s => items(s).forEach(st => { st.previewOpen = nextState; }));
  const btn = document.getElementById('toggleAllPreviewsBtn');
  if (btn) {
    btn.innerHTML = nextState
      ? `<i class="ph ph-eye-slash text-xs mr-1"></i>Hide Step Previews`
      : `<i class="ph ph-eye text-xs mr-1"></i>Preview All Steps`;
  }
  renderBuilder();
}

function renderMarkdownToolbar(textareaId, sIdx, stepIdx) {
  return `
    <div class="flex flex-wrap items-center gap-0.5 px-2.5 py-1.5 bg-slate-100/70 dark:bg-surface-850 border-b border-slate-200/80 dark:border-white/[0.06] text-slate-500 dark:text-slate-400">
      <button type="button" data-on-click="applyFormat('${textareaId}', 'bold')" class="px-1.5 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs font-semibold transition" title="Bold">B</button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'italic')" class="px-1.5 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs italic transition" title="Italic">I</button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'strike')" class="px-1.5 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs line-through transition" title="Strikethrough">S</button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'code')" class="px-1.5 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-[11px] font-mono transition" title="Inline Code">&lt;/&gt;</button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'codeblock')" class="p-1 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs transition" title="Code Block">
        <i class="ph ph-terminal-window"></i>
      </button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'table')" class="p-1 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs transition" title="Table">
        <i class="ph ph-table"></i>
      </button>
      <button type="button" data-on-click="applyFormat('${textareaId}', 'link')" class="p-1 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-xs transition" title="Link">
        <i class="ph ph-link"></i>
      </button>
      <div class="h-3 w-px bg-slate-200 dark:bg-white/[0.08] mx-1"></div>
      <button type="button" data-on-click="openPhotoInsertPicker(${sIdx}, ${stepIdx}, '${textareaId}')" class="px-2 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-[11px] font-medium flex items-center gap-1 transition">
        <i class="ph ph-image text-xs"></i>
        <span>Image</span>
      </button>
      <button type="button" data-on-click="pickTokenForTextarea('${textareaId}', ${sIdx}, ${stepIdx})" class="px-2 py-0.5 hover:bg-slate-200/70 dark:hover:bg-white/[0.07] hover:text-slate-900 dark:hover:text-white rounded text-[11px] font-medium flex items-center gap-1 text-brand-600 dark:text-brand-400 transition">
        <i class="ph ph-brackets-curly text-xs"></i>
        <span>Token</span>
      </button>
    </div>
  `;
}

function formatCheckpointAnswers(cp) {
  if (!cp) return '';
  const parts = [];
  if (cp.answer) parts.push(cp.answer);
  if (Array.isArray(cp.answers)) {
    cp.answers.forEach(a => { if (a && !parts.includes(a)) parts.push(a); });
  }
  return parts.join(' | ');
}

function applyFormat(textareaId, fmt) {
  const textarea = document.getElementById(textareaId);
  if (!textarea) return;

  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;
  const val = textarea.value;
  const sel = val.substring(start, end);

  let replacement = '';
  let cursorOffset = 0;

  switch (fmt) {
    case 'bold': replacement = `**${sel || 'bold text'}**`; cursorOffset = 2; break;
    case 'italic': replacement = `*${sel || 'italic text'}*`; cursorOffset = 1; break;
    case 'strike': replacement = `~~${sel || 'struck text'}~~`; cursorOffset = 2; break;
    case 'code': replacement = `\`${sel || 'code'}\``; cursorOffset = 1; break;
    case 'codeblock': replacement = `\n\`\`\`\n${sel || 'echo "hello"'}\n\`\`\`\n`; cursorOffset = 5; break;
    case 'table':
      replacement = `\n| Field | Value |\n| --- | --- |\n| Setting | **{{ VALUE }}** |\n`;
      cursorOffset = replacement.length;
      break;
    case 'link':
      replacement = `[${sel || 'link text'}](https://example.com)`;
      cursorOffset = replacement.length;
      break;
  }

  textarea.value = val.substring(0, start) + replacement + val.substring(end);
  textarea.focus();
  textarea.setSelectionRange(start + cursorOffset, start + cursorOffset);
  textarea.dispatchEvent(new Event('input', { bubbles: true }));
  autoGrowTextarea(textarea);
}

document.addEventListener('input', (e) => {
  const target = e.target;
  const action = target.dataset.action;
  const sIdx = target.dataset.secIdx !== undefined ? parseInt(target.dataset.secIdx, 10) : null;
  const stepIdx = target.dataset.stepIdx !== undefined ? parseInt(target.dataset.stepIdx, 10) : null;

  if (target.tagName === 'TEXTAREA' && target.classList.contains('autogrow-textarea')) {
    autoGrowTextarea(target);
  }

  if (action && action.startsWith('exam-')) {
    examHandleInput(action, target, sIdx);
  } else if (action === 'update-step-body') {
    templateData.content[sIdx].steps[stepIdx].body = target.value;
    // Live update split preview if open
    const inlinePreview = document.getElementById(`inline-preview-body-${sIdx}-${stepIdx}`);
    if (inlinePreview) {
      const sampleCtx = buildEvaluatedContext(1, 'Mary-Jane', "O'Neil");
      inlinePreview.innerHTML = parseMarkdownSafe(resolveMarkdownImages(target.value, sampleCtx));
    }
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-sec-minutes') {
    const raw = String(target.value || '').trim();
    templateData.content[sIdx].minutes = raw === '' ? null : Number(raw);
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-sec-title') {
    templateData.content[sIdx].title = target.value;
    pushHistorySnapshot();
    renderOutline();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-step-title') {
    templateData.content[sIdx].steps[stepIdx].title = target.value;
    pushHistorySnapshot();
    renderOutline();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-hint-field') {
    const hIdx = parseInt(target.dataset.hintIdx, 10);
    const field = target.dataset.field;
    templateData.content[sIdx].steps[stepIdx].hints[hIdx][field] = target.value;
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-solution') {
    templateData.content[sIdx].steps[stepIdx].solution = target.value;
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-cp-field') {
    const field = target.dataset.field;
    templateData.content[sIdx].steps[stepIdx].checkpoint[field] = target.value;
    if (field === 'pattern') {
      const previewEl = document.getElementById(`cp-mask-preview-${sIdx}-${stepIdx}`);
      if (previewEl) previewEl.textContent = generateMaskExample(target.value);
    }
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'update-cp-answers') {
    const parts = target.value.split(/(?<!\\)\|/).map(s => s.replace(/\\\|/g, '|').trim()).filter(Boolean);
    templateData.content[sIdx].steps[stepIdx].checkpoint.answer = parts[0] || '';
    templateData.content[sIdx].steps[stepIdx].checkpoint.answers = parts.slice(1);
    pushHistorySnapshot();
    runFullValidation(false);
    scheduleAutoSave();
  }
});

document.addEventListener('click', (e) => {
  const target = e.target.closest('[data-action]');
  if (!target) return;

  const action = target.dataset.action;
  const sIdx = target.dataset.secIdx !== undefined ? parseInt(target.dataset.secIdx, 10) : null;
  const stepIdx = target.dataset.stepIdx !== undefined ? parseInt(target.dataset.stepIdx, 10) : null;

  if (action.startsWith('exam-')) examHandleClick(action, target, sIdx);
  else if (action === 'toggle-section') toggleSectionCollapse(sIdx);
  else if (action === 'toggle-step') toggleStepCollapse(sIdx, stepIdx);
  else if (action === 'toggle-step-preview') toggleStepPreview(sIdx, stepIdx);
  else if (action === 'add-step') addNewStep(sIdx);
  else if (action === 'delete-section') deleteSection(sIdx);
  else if (action === 'delete-step') deleteStep(sIdx, stepIdx);
  else if (action === 'move-sec-up') moveSection(sIdx, -1);
  else if (action === 'move-sec-down') moveSection(sIdx, 1);
  else if (action === 'move-step-up') moveStep(sIdx, stepIdx, -1);
  else if (action === 'move-step-down') moveStep(sIdx, stepIdx, 1);
  else if (action === 'duplicate-section') duplicateSection(sIdx);
  else if (action === 'duplicate-step') duplicateStep(sIdx, stepIdx);
  else if (action === 'add-hint') addHintToStep(sIdx, stepIdx);
  else if (action === 'delete-hint') deleteHint(sIdx, stepIdx, parseInt(target.dataset.hintIdx, 10));
  else if (action === 'add-checkpoint') addCheckpointToStep(sIdx, stepIdx);
  else if (action === 'remove-checkpoint') removeCheckpointFromStep(sIdx, stepIdx);
});

document.addEventListener('change', (e) => {
  const target = e.target;
  const action = target.dataset.action;
  const sIdx = target.dataset.secIdx !== undefined ? parseInt(target.dataset.secIdx, 10) : null;
  const stepIdx = target.dataset.stepIdx !== undefined ? parseInt(target.dataset.stepIdx, 10) : null;

  if (action && action.startsWith('exam-')) {
    examHandleChange(action, target, sIdx);
  } else if (action === 'update-sec-optional') {
    templateData.content[sIdx].optional = target.checked;
    pushHistorySnapshot(true);
    runFullValidation(false);
    scheduleAutoSave();
  } else if (action === 'change-step-type') {
    templateData.content[sIdx].steps[stepIdx].type = target.value;
    pushHistorySnapshot(true);
    renderBuilder();
    scheduleAutoSave();
  } else if (action === 'update-cp-mode') {
    templateData.content[sIdx].steps[stepIdx].checkpoint.mode = target.value;
    pushHistorySnapshot(true);
    renderBuilder();
    scheduleAutoSave();
  }
});

function toggleSectionCollapse(sIdx) {
  templateData.content[sIdx].collapsed = !templateData.content[sIdx].collapsed;
  renderBuilder();
  scheduleAutoSave();
}
function toggleStepCollapse(sIdx, stepIdx) {
  const step = templateData.content[sIdx].steps[stepIdx];
  step.collapsed = !step.collapsed;
  renderBuilder();
  scheduleAutoSave();
}
function toggleStepPreview(sIdx, stepIdx) {
  const step = templateData.content[sIdx].steps[stepIdx];
  step.previewOpen = !step.previewOpen;
  renderBuilder();
}
function toggleAllSections(collapse) {
  templateData.content.forEach(sec => {
    sec.collapsed = collapse;
    (sec.items || sec.steps || []).forEach(st => { st.collapsed = collapse; });
  });
  renderBuilder();
}
function addNewSection() {
  if (isExamMode()) return addExamSection();
  templateData.content.push({
    title: `Section ${templateData.content.length + 1}`,
    collapsed: false,
    steps: [{
      type: "desk",
      title: "New Step",
      body: "Describe action here...",
      collapsed: false,
      previewOpen: false,
      hints: [],
      solution: "",
      checkpoint: null
    }]
  });
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function addNewStep(sIdx) {
  templateData.content[sIdx].steps.push({
    type: "desk",
    title: `Step ${templateData.content[sIdx].steps.length + 1}`,
    body: "Describe task instructions...",
    collapsed: false,
    previewOpen: false,
    hints: [],
    solution: "",
    checkpoint: null
  });
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function deleteSection(sIdx) {
  if (isExamMode()) {
    // The submit section stays, and so does at least one part before it.
    if (examIsSubmit(templateData.content[sIdx])) return;
    if (templateData.content.length <= 2) {
      showToast("At least one section is required.", "error");
      return;
    }
  }
  if (templateData.content.length <= 1) {
    showToast("At least one section is required.", "error");
    return;
  }
  templateData.content.splice(sIdx, 1);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
  showToast("Section deleted (Ctrl+Z to undo)", "info");
}
function deleteStep(sIdx, stepIdx) {
  if (templateData.content[sIdx].steps.length <= 1) {
    showToast("Sections must have at least one step.", "error");
    return;
  }
  templateData.content[sIdx].steps.splice(stepIdx, 1);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
  showToast("Step deleted (Ctrl+Z to undo)", "info");
}
function moveSection(sIdx, dir) {
  const target = sIdx + dir;
  if (target < 0 || target >= templateData.content.length) return;
  // An exam's submit section is always last.
  if (isExamMode() && [sIdx, target].some(i => examIsSubmit(templateData.content[i]))) return;
  const [sec] = templateData.content.splice(sIdx, 1);
  templateData.content.splice(target, 0, sec);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function moveStep(sIdx, stepIdx, dir) {
  const steps = templateData.content[sIdx].steps;
  const target = stepIdx + dir;
  if (target < 0 || target >= steps.length) return;
  const [st] = steps.splice(stepIdx, 1);
  steps.splice(target, 0, st);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function duplicateSection(sIdx) {
  if (isExamMode() && examIsSubmit(templateData.content[sIdx])) return;
  const clone = JSON.parse(JSON.stringify(templateData.content[sIdx]));
  clone.title += " (Copy)";
  // A copy is new: it gets its own ids when saved (vLabs matches by id on push).
  delete clone.id;
  (clone.steps || clone.items || []).forEach(it => { delete it.id; });
  templateData.content.splice(sIdx + 1, 0, clone);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function duplicateStep(sIdx, stepIdx) {
  const clone = JSON.parse(JSON.stringify(templateData.content[sIdx].steps[stepIdx]));
  clone.title += " (Copy)";
  delete clone.id; // a copy gets its own id when saved
  templateData.content[sIdx].steps.splice(stepIdx + 1, 0, clone);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function addHintToStep(sIdx, stepIdx) {
  const step = templateData.content[sIdx].steps[stepIdx];
  if (!step.hints) step.hints = [];
  if (step.hints.length >= 20) {
    showToast("Maximum 20 hints per step allowed.", "error");
    return;
  }
  step.hints.push({ label: "Question prompt?", text: "Walkthrough nudge..." });
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function deleteHint(sIdx, stepIdx, hIdx) {
  templateData.content[sIdx].steps[stepIdx].hints.splice(hIdx, 1);
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function addCheckpointToStep(sIdx, stepIdx) {
  templateData.content[sIdx].steps[stepIdx].checkpoint = {
    prompt: "Enter value to continue",
    placeholder: "e.g. value",
    mode: "exact",
    answer: "1",
    answers: [],
    pattern: "",
    capture: ""
  };
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}
function removeCheckpointFromStep(sIdx, stepIdx) {
  templateData.content[sIdx].steps[stepIdx].checkpoint = null;
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}

function renderOutline() {
  if (isExamMode()) return renderExamOutline();
  const list = document.getElementById('outlineList');
  const countEl = document.getElementById('outlineStepCount');
  if (!list) return;

  let totalSteps = 0;
  let html = '';

  templateData.content.forEach((sec, sIdx) => {
    html += `
      <div class="pt-2.5 pb-1 px-1 flex items-center space-x-1.5">
        <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500">${String(sIdx + 1).padStart(2, '0')}</span>
        <span class="text-[11px] font-semibold text-slate-700 dark:text-slate-300 truncate">${escapeHtml(sec.title || 'Untitled')}</span>
      </div>
      <div class="border-l border-slate-200/80 dark:border-white/[0.07] ml-2.5 pl-2 space-y-0.5">
    `;
    sec.steps.forEach((st, stIdx) => {
      totalSteps++;
      const hasCp = st.type !== 'info' && st.checkpoint;
      html += `
        <button data-on-click="jumpToStep(${sIdx}, ${stIdx})" class="w-full text-left px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.05] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 truncate flex items-center space-x-2 transition">
          <span class="w-1.5 h-1.5 rounded-full shrink-0 ${st.type === 'desk' ? 'bg-amber-500' : st.type === 'computer' ? 'bg-sky-500' : 'bg-slate-400'}"></span>
          <span class="truncate flex-1 text-[11px]">${escapeHtml(st.title || `Step ${stIdx + 1}`)}</span>
          ${hasCp ? `<i class="ph-fill ph-flag text-[10px] text-brand-500/80 shrink-0" title="Checkpoint Gate"></i>` : ''}
        </button>
      `;
    });
    html += `</div>`;
  });

  list.innerHTML = html;
  if (countEl) countEl.textContent = `${totalSteps} steps`;
}

function jumpToStep(sIdx, stepIdx) {
  if (isExamMode()) return jumpToQuestion(sIdx, stepIdx ?? 0);
  switchView('builder');
  if (templateData.content[sIdx]) {
    templateData.content[sIdx].collapsed = false;
    if (templateData.content[sIdx].steps[stepIdx]) {
      templateData.content[sIdx].steps[stepIdx].collapsed = false;
    }
  }
  renderBuilder();

  requestAnimationFrame(() => {
    const el = stepIdx !== null && stepIdx !== undefined
      ? document.getElementById(`step-card-${sIdx}-${stepIdx}`)
      : document.getElementById(`section-card-${sIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-jump');
      setTimeout(() => el.classList.remove('highlight-jump'), 1000);
    }
  });
}

function handleGlobalSearch(val) {
  globalSearchQuery = val || '';
  const banner = document.getElementById('searchNoticeBanner');
  const clearBtn = document.getElementById('clearSearchBtn');

  if (globalSearchQuery) {
    banner?.classList.remove('hidden');
    clearBtn?.classList.remove('hidden');
    document.getElementById('searchNoticeText').textContent = `Filtering by: "${globalSearchQuery}"`;
  } else {
    banner?.classList.add('hidden');
    clearBtn?.classList.add('hidden');
  }
  renderBuilder();
}

function clearGlobalSearch() {
  const input = document.getElementById('globalStepSearch');
  if (input) input.value = '';
  handleGlobalSearch('');
}

function filterOutline(val) {
  const q = (val || '').toLowerCase();
  const btns = document.querySelectorAll('#outlineList button');
  btns.forEach(b => {
    b.style.display = b.textContent.toLowerCase().includes(q) ? 'flex' : 'none';
  });
}

function computeChainedVariableResults() {
  const ctx1 = { seat: 1, first_name: 'Mary-Jane', last_name: "O'Neil" };
  const ctx7 = { seat: 7, first_name: 'Mary-Jane', last_name: "O'Neil" };
  const allowed = new Set();
  const seenNames = new Set();
  const results = [];

  (templateData.variables || []).forEach((v, idx) => {
    const name = (v.name || '').trim();
    const expr = (v.expression || '').trim();
    let nameError = null;

    if (!name) {
      nameError = 'Missing variable name';
    } else if (!VALID_VAR_NAME_RE.test(name)) {
      nameError = 'Invalid name (use [A-Za-z_][A-Za-z0-9_]*)';
    } else if (RESERVED_NAMES.has(name)) {
      nameError = `"${name}" is a reserved identifier`;
    } else if (seenNames.has(name)) {
      nameError = `"${name}" is declared more than once`;
    }

    const res1 = evaluateFormulaTyped(expr, ctx1, allowed);
    const res7 = evaluateFormulaTyped(expr, ctx7, allowed);
    const val1 = res1.display;
    const val7 = res7.display;
    const isFormulaError = res1.error || res7.error;

    if (name && !nameError) {
      seenNames.add(name);
      allowed.add(name);
      ctx1[name] = res1.value;
      ctx7[name] = res7.value;
    }

    results.push({ idx, name, expr, val1, val7, nameError, isFormulaError });
  });

  return results;
}

function updateVariablePreviewBadgesInDom() {
  const results = computeChainedVariableResults();
  results.forEach(r => {
    const badgeEl = document.getElementById(`var-preview-badge-${r.idx}`);
    if (!badgeEl) return;
    if (r.nameError) {
      badgeEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold"><i class="ph-bold ph-warning-circle"></i> ${escapeHtml(r.nameError)}</span>`;
    } else if (r.isFormulaError) {
      badgeEl.innerHTML = `<span class="text-rose-600 dark:text-rose-400 font-semibold">${escapeHtml(r.val1)}</span>`;
    } else {
      badgeEl.innerHTML = `Seat 1: <strong class="text-brand-600 dark:text-brand-400">${escapeHtml(r.val1)}</strong> <span class="text-slate-300 dark:text-slate-700">|</span> Seat 7: <strong class="text-brand-600 dark:text-brand-400">${escapeHtml(r.val7)}</strong>`;
    }
  });
}

function renderVariablesList() {
  const container = document.getElementById('variablesList');
  if (!container) return;
  container.innerHTML = '';

  if (templateData.variables.length === 0) {
    container.innerHTML = `<div class="p-4 text-center text-slate-400 italic">No variables declared yet. Click "+ New Variable" above.</div>`;
    return;
  }

  const results = computeChainedVariableResults();

  results.forEach((r) => {
    const v = templateData.variables[r.idx];
    const div = document.createElement('div');
    div.className = 'bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-700/80 rounded-xl p-3 flex flex-col sm:flex-row items-start sm:items-center gap-2.5';
    div.innerHTML = `
      <div class="flex items-center space-x-1 shrink-0">
        <button data-on-click="moveVariable(${r.idx}, -1)" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" title="Move Up">
          <i class="ph ph-arrow-up text-xs"></i>
        </button>
        <button data-on-click="moveVariable(${r.idx}, 1)" class="p-1 text-slate-400 hover:text-slate-700 dark:hover:text-slate-200" title="Move Down">
          <i class="ph ph-arrow-down text-xs"></i>
        </button>
      </div>
      <input type="text" value="${escapeHtml(v.name || '')}" placeholder="VAR_NAME"
        class="w-36 text-xs font-mono font-bold bg-white dark:bg-surface-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:border-brand-500 focus:outline-none"
        data-on-input="updateVarField(${r.idx}, 'name', this.value)">
      <span class="text-slate-400 font-bold">=</span>
      <input type="text" value="${escapeHtml(v.expression || '')}" placeholder="expression (e.g. '10.0.0.' + (100 + seat))"
        class="flex-1 w-full text-xs font-mono bg-white dark:bg-surface-900 border border-slate-200 dark:border-slate-700 rounded-lg px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:border-brand-500 focus:outline-none"
        data-on-input="updateVarField(${r.idx}, 'expression', this.value)">
      <div id="var-preview-badge-${r.idx}" class="text-[11px] font-mono text-slate-500 dark:text-slate-400 shrink-0 bg-white dark:bg-surface-900 px-2.5 py-1 rounded-lg border border-slate-200/70 dark:border-slate-800"></div>
      <button data-on-click="deleteVariable(${r.idx})" class="text-slate-400 hover:text-rose-600 p-1 shrink-0" title="Delete Variable">
        <i class="ph ph-trash"></i>
      </button>
    `;
    container.appendChild(div);
  });

  updateVariablePreviewBadgesInDom();
}

function addNewVariable() {
  if ((templateData.variables || []).length >= 100) {
    showToast("Maximum 100 variables allowed.", "error");
    return;
  }
  templateData.variables.push({ name: `VAR_${templateData.variables.length + 1}`, expression: "seat" });
  pushHistorySnapshot(true);
  renderVariablesList();
  updateBadges();
  runFullValidation(false);
  scheduleAutoSave();
}

function updateVarField(idx, field, val) {
  templateData.variables[idx][field] = val;
  updateVariablePreviewBadgesInDom();
  pushHistorySnapshot();
  updateBadges();
  runFullValidation(false);
  scheduleAutoSave();
}

function moveVariable(idx, dir) {
  const target = idx + dir;
  if (target < 0 || target >= templateData.variables.length) return;
  const [v] = templateData.variables.splice(idx, 1);
  templateData.variables.splice(target, 0, v);
  pushHistorySnapshot(true);
  renderVariablesList();
  runFullValidation(false);
  scheduleAutoSave();
}

function deleteVariable(idx) {
  templateData.variables.splice(idx, 1);
  pushHistorySnapshot(true);
  renderVariablesList();
  updateBadges();
  runFullValidation(false);
  scheduleAutoSave();
}

function extractPlaceholdersFromText(str) {
  if (!str || typeof str !== 'string') return [];
  const matches = [];
  const re = /\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    matches.push(m[1]);
  }
  return matches;
}

function analyzeTemplateDependencies() {
  const vars = templateData.variables || [];
  const varMap = new Map();
  vars.forEach((v, idx) => {
    if (v.name) varMap.set(v.name, { ...v, idx, usedInFormulas: [], usedInSteps: [], dependsOn: [] });
  });

  // Analyze formula-to-formula dependencies
  vars.forEach((v) => {
    if (!v.name) return;
    const entry = varMap.get(v.name);
    const ids = extractFormulaIdentifiers(v.expression || '');
    ids.forEach(id => {
      if (FORMULA_BUILTINS.has(id)) {
        entry.dependsOn.push({ type: 'builtin', name: id });
      } else if (varMap.has(id) && id !== v.name) {
        entry.dependsOn.push({ type: 'variable', name: id });
        varMap.get(id).usedInFormulas.push(v.name);
      } else if (!FORMULA_HELPERS.has(id)) {
        entry.dependsOn.push({ type: 'unknown', name: id });
      }
    });
  });

  // Analyze captures and step usages
  const capturesMap = new Map(); // name -> { name, sIdx, stIdx, usedInSteps: [], outOfOrderRefs: [] }
  const builtInUsage = {
    SEAT_ID: [],
    FIRST_NAME: [],
    LAST_NAME: [],
    FULL_NAME: []
  };
  const undeclaredUsages = []; // { token, sIdx, stIdx, fieldLabel }

  if (isExamMode()) {
    examAnalyzeUsages(capturesMap, (token, ref) => {
      if (BUILTIN_PLACEHOLDERS.has(token)) builtInUsage[token].push(ref);
      else if (varMap.has(token)) varMap.get(token).usedInSteps.push(ref);
      else if (capturesMap.has(token)) {
        // An exam's saved answer is there from the next section on.
        const cap = capturesMap.get(token);
        (ref.sIdx > cap.sIdx ? cap.usedInSteps : cap.outOfOrderRefs).push(ref);
      } else undeclaredUsages.push({ token, ...ref });
    });
    return { varMap, capturesMap, builtInUsage, undeclaredUsages };
  }

  // First pass: locate all checkpoint captures
  templateData.content.forEach((sec, sIdx) => {
    sec.steps.forEach((st, stIdx) => {
      if (st.type !== 'info' && st.checkpoint && st.checkpoint.capture) {
        const capName = st.checkpoint.capture.trim();
        if (capName && !capturesMap.has(capName)) {
          capturesMap.set(capName, {
            name: capName,
            sIdx,
            stIdx,
            usedInSteps: [],
            outOfOrderRefs: []
          });
        }
      }
    });
  });

  // Second pass: scan every text field in sections and steps
  const recordTokenRef = (token, sIdx, stIdx, fieldLabel) => {
    const refObj = { sIdx, stIdx, fieldLabel };
    if (BUILTIN_PLACEHOLDERS.has(token)) {
      builtInUsage[token].push(refObj);
    } else if (varMap.has(token)) {
      varMap.get(token).usedInSteps.push(refObj);
    } else if (capturesMap.has(token)) {
      const cap = capturesMap.get(token);
      const isAfterCapture = (sIdx > cap.sIdx) || (sIdx === cap.sIdx && stIdx !== null && stIdx > cap.stIdx);
      if (isAfterCapture) {
        cap.usedInSteps.push(refObj);
      } else {
        cap.outOfOrderRefs.push(refObj);
      }
    } else {
      undeclaredUsages.push({ token, sIdx, stIdx, fieldLabel });
    }
  };

  templateData.content.forEach((sec, sIdx) => {
    extractPlaceholdersFromText(sec.title).forEach(t => recordTokenRef(t, sIdx, 0, 'Section Title'));
    sec.steps.forEach((st, stIdx) => {
      extractPlaceholdersFromText(st.title).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Step Title'));
      extractPlaceholdersFromText(st.body).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Step Body'));
      if (st.type !== 'info') {
        (st.hints || []).forEach((h, hIdx) => {
          extractPlaceholdersFromText(h.label).forEach(t => recordTokenRef(t, sIdx, stIdx, `Hint #${hIdx + 1} Label`));
          extractPlaceholdersFromText(h.text).forEach(t => recordTokenRef(t, sIdx, stIdx, `Hint #${hIdx + 1} Text`));
        });
        extractPlaceholdersFromText(st.solution).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Solution'));
        if (st.checkpoint) {
          extractPlaceholdersFromText(st.checkpoint.prompt).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Checkpoint Prompt'));
          extractPlaceholdersFromText(st.checkpoint.placeholder).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Checkpoint Placeholder'));
          if (st.checkpoint.mode !== 'pattern') {
            extractPlaceholdersFromText(st.checkpoint.answer).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Checkpoint Answer'));
            (st.checkpoint.answers || []).forEach(alt => {
              extractPlaceholdersFromText(alt).forEach(t => recordTokenRef(t, sIdx, stIdx, 'Checkpoint Alt Answer'));
            });
          }
        }
      }
    });
  });

  return { varMap, capturesMap, builtInUsage, undeclaredUsages };
}

/** Where a token is used or saved: S1·St2 in a lab, S1·Q2 / S1·Step 1 in an exam. */
const depRefLabel = (r) => r.label || (r.stIdx === null || r.stIdx === undefined ? `S${r.sIdx + 1}` : `S${r.sIdx + 1}·St${r.stIdx + 1}`);

function renderStepRefBadges(refs) {
  if (!refs || refs.length === 0) {
    return `<span class="text-[11px] text-slate-400 italic">Not referenced in any step</span>`;
  }
  // Deduplicate by sIdx-stIdx-fieldLabel
  const seen = new Set();
  return refs.filter(r => {
    const k = `${r.sIdx}-${r.stIdx}-${r.fieldLabel}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).map(r => `
    <button data-on-click="jumpToStep(${r.sIdx}, ${r.stIdx})" class="inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-mono font-semibold bg-brand-50 dark:bg-brand-950/50 text-brand-700 dark:text-brand-300 border border-brand-200/70 dark:border-brand-800/60 hover:bg-brand-100 dark:hover:bg-brand-900/60 transition" title="Jump to ${escapeHtml(depRefLabel(r))} (${escapeHtml(r.fieldLabel)})">
      <i class="ph-bold ph-arrow-bend-up-right"></i>
      <span>${escapeHtml(depRefLabel(r))}</span>
      <span class="text-slate-400 font-sans font-normal">(${escapeHtml(r.fieldLabel)})</span>
    </button>
  `).join(' ');
}

function renderDependencyGraph() {
  const container = document.getElementById('dependencyGraphContent');
  if (!container) return;

  const { varMap, capturesMap, builtInUsage, undeclaredUsages } = analyzeTemplateDependencies();
  const chainedResults = computeChainedVariableResults();
  const varEvalMap = new Map(chainedResults.map(r => [r.name, r]));

  let unusedCount = 0;
  varMap.forEach(v => {
    if (v.usedInFormulas.length === 0 && v.usedInSteps.length === 0) unusedCount++;
  });

  let outOfOrderCount = 0;
  capturesMap.forEach(c => { outOfOrderCount += c.outOfOrderRefs.length; });

  const totalIssues = undeclaredUsages.length + outOfOrderCount;

  let html = `
    <!-- Summary KPI Row -->
    <div class="grid grid-cols-2 sm:grid-cols-4 gap-3">
      <div class="p-3 rounded-xl bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-800">
        <span class="text-[10px] font-bold uppercase text-slate-400 block">Declared Formulas</span>
        <span class="text-lg font-bold text-slate-900 dark:text-slate-100">${varMap.size}</span>
      </div>
      <div class="p-3 rounded-xl bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-800">
        <span class="text-[10px] font-bold uppercase text-slate-400 block">${isExamMode() ? 'Saved Answers' : 'Checkpoint Captures'}</span>
        <span class="text-lg font-bold text-emerald-600 dark:text-emerald-400">${capturesMap.size}</span>
      </div>
      <div class="p-3 rounded-xl bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-800">
        <span class="text-[10px] font-bold uppercase text-slate-400 block">Unused Variables</span>
        <span class="text-lg font-bold ${unusedCount > 0 ? 'text-amber-600 dark:text-amber-400' : 'text-slate-900 dark:text-slate-100'}">${unusedCount}</span>
      </div>
      <div class="p-3 rounded-xl bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-800">
        <span class="text-[10px] font-bold uppercase text-slate-400 block">Token Issues</span>
        <span class="text-lg font-bold ${totalIssues > 0 ? 'text-rose-600 dark:text-rose-400' : 'text-emerald-600 dark:text-emerald-400'}">${totalIssues}</span>
      </div>
    </div>
  `;

  // Alert section if undeclared or out-of-order tokens exist
  if (undeclaredUsages.length > 0 || outOfOrderCount > 0) {
    html += `
      <div class="bg-rose-50 dark:bg-rose-950/30 border border-rose-200 dark:border-rose-800/50 rounded-xl p-4 space-y-2.5">
        <h3 class="font-bold uppercase text-[11px] text-rose-700 dark:text-rose-300 flex items-center gap-1.5">
          <i class="ph-bold ph-warning-octagon text-sm"></i> Undeclared or Out-of-Order Placeholders Detected
        </h3>
        <div class="space-y-2">
          ${undeclaredUsages.map(u => `
            <div class="flex items-center justify-between bg-white dark:bg-surface-900 px-3 py-2 rounded-lg border border-rose-200/70 dark:border-rose-800/40">
              <div>
                <code class="font-mono font-bold text-rose-600 dark:text-rose-400">{{ ${escapeHtml(u.token)} }}</code>
                <span class="text-slate-500 ml-2">is never declared as a variable or capture</span>
              </div>
              <button data-on-click="jumpToStep(${u.sIdx}, ${u.stIdx})" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-md text-[10px] font-semibold">
                Jump to ${depRefLabel(u)} (${escapeHtml(u.fieldLabel)})
              </button>
            </div>
          `).join('')}
          ${Array.from(capturesMap.values()).flatMap(c => c.outOfOrderRefs.map(r => `
            <div class="flex items-center justify-between bg-white dark:bg-surface-900 px-3 py-2 rounded-lg border border-rose-200/70 dark:border-rose-800/40">
              <div>
                <code class="font-mono font-bold text-rose-600 dark:text-rose-400">{{ ${escapeHtml(c.name)} }}</code>
                <span class="text-slate-500 ml-2">used in ${depRefLabel(r)} ${isExamMode() ? `but saved by ${depRefLabel(c)}: an answer is there from the next section on` : `before its capture checkpoint at ${depRefLabel(c)}`}</span>
              </div>
              <button data-on-click="jumpToStep(${r.sIdx}, ${r.stIdx})" class="px-2.5 py-1 bg-rose-600 hover:bg-rose-700 text-white rounded-md text-[10px] font-semibold">
                Jump to ${depRefLabel(r)}
              </button>
            </div>
          `)).join('')}
        </div>
      </div>
    `;
  }

  // 1. Declared Formulas & Lineage Matrix
  html += `
    <div class="space-y-2.5">
      <h3 class="font-bold uppercase text-[10px] tracking-wider text-slate-400">1. Declared Variables & Formula Lineage (${varMap.size})</h3>
      <div class="space-y-2.5">
        ${Array.from(varMap.values()).map(v => {
          const isUnused = v.usedInFormulas.length === 0 && v.usedInSteps.length === 0;
          const evalInfo = varEvalMap.get(v.name);
          const depsBadges = v.dependsOn.map(d => {
            if (d.type === 'builtin') return `<span class="px-1.5 py-0.5 rounded bg-slate-200 dark:bg-slate-800 font-mono text-[10px] text-slate-700 dark:text-slate-300">${escapeHtml(d.name)} (built-in)</span>`;
            if (d.type === 'variable') return `<span class="px-1.5 py-0.5 rounded bg-purple-100 dark:bg-purple-950/60 font-mono text-[10px] text-purple-700 dark:text-purple-300 font-semibold">${escapeHtml(d.name)}</span>`;
            return `<span class="px-1.5 py-0.5 rounded bg-rose-100 dark:bg-rose-950/60 font-mono text-[10px] text-rose-700 dark:text-rose-300 font-semibold">${escapeHtml(d.name)} (unknown)</span>`;
          }).join(' <i class="ph ph-plus text-[9px] text-slate-400"></i> ');

          const downstreamFormulas = v.usedInFormulas.map(f => `<span class="px-1.5 py-0.5 rounded bg-indigo-50 dark:bg-indigo-950/50 font-mono text-[10px] text-indigo-700 dark:text-indigo-300 font-semibold">${escapeHtml(f)}</span>`).join(' ');

          return `
            <div class="p-3.5 bg-slate-50 dark:bg-surface-850 border ${isUnused ? 'border-amber-300 dark:border-amber-800/70' : 'border-slate-200 dark:border-slate-700/80'} rounded-xl space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center space-x-2">
                  <span class="font-mono font-bold text-sm text-brand-600 dark:text-brand-400">{{ ${escapeHtml(v.name)} }}</span>
                  <span class="text-slate-400">=</span>
                  <code class="font-mono px-2 py-0.5 rounded bg-white dark:bg-surface-900 border border-slate-200 dark:border-slate-800 text-slate-800 dark:text-slate-200">${escapeHtml(v.expression)}</code>
                </div>
                <div class="flex items-center space-x-2">
                  ${evalInfo ? `<span class="text-[10px] font-mono text-slate-500">Seat 1: <strong>${escapeHtml(evalInfo.val1)}</strong></span>` : ''}
                  ${isUnused ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-100 dark:bg-amber-950/60 text-amber-700 dark:text-amber-300">Unused Variable</span>` : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/50 text-emerald-700 dark:text-emerald-400">Active</span>`}
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-2 pt-1.5 border-t border-slate-200/60 dark:border-slate-800 text-[11px]">
                <div>
                  <span class="text-slate-400 block mb-1">Depends On Inputs:</span>
                  <div class="flex flex-wrap items-center gap-1">${depsBadges || '<span class="text-slate-400 italic">Static literal</span>'}</div>
                  ${downstreamFormulas ? `<div class="mt-1.5"><span class="text-slate-400">Feeds Formulas: </span>${downstreamFormulas}</div>` : ''}
                </div>
                <div>
                  <span class="text-slate-400 block mb-1">Referenced in Steps (${v.usedInSteps.length}):</span>
                  <div class="flex flex-wrap gap-1">${renderStepRefBadges(v.usedInSteps)}</div>
                </div>
              </div>
            </div>
          `;
        }).join('') || '<div class="text-slate-400 italic p-3">No variables declared in front matter.</div>'}
      </div>
    </div>

    <!-- 2. Captured Checkpoint Values -->
    <div class="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
      <h3 class="font-bold uppercase text-[10px] tracking-wider text-slate-400">2. ${isExamMode() ? 'Saved Answers' : 'Captured Checkpoint Values'} (${capturesMap.size})</h3>
      <div class="space-y-2.5">
        ${Array.from(capturesMap.values()).map(c => {
          const isUnused = c.usedInSteps.length === 0;
          return `
            <div class="p-3.5 bg-emerald-50/40 dark:bg-emerald-950/15 border border-emerald-200/70 dark:border-emerald-800/40 rounded-xl space-y-2">
              <div class="flex flex-wrap items-center justify-between gap-2">
                <div class="flex items-center space-x-2">
                  <span class="font-mono font-bold text-sm text-emerald-700 dark:text-emerald-300">{{ ${escapeHtml(c.name)} }}</span>
                  <button data-on-click="jumpToStep(${c.sIdx}, ${c.stIdx})" class="px-2 py-0.5 rounded bg-emerald-600 text-white text-[10px] font-semibold hover:bg-emerald-700 transition">
                    ${isExamMode() ? 'Saved by' : 'Captured at'} ${depRefLabel(c)}
                  </button>
                </div>
                ${isUnused ? `<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-200 dark:bg-slate-800 text-slate-600 dark:text-slate-400">${isExamMode() ? 'Not reused in later sections' : 'Monitor-only (not reused in later steps)'}</span>` : `<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-950/60 text-emerald-700 dark:text-emerald-300">Reused in ${c.usedInSteps.length} place(s)</span>`}
              </div>
              <div>
                <span class="text-slate-400 block mb-1 text-[11px]">Downstream Step References:</span>
                <div class="flex flex-wrap gap-1">${renderStepRefBadges(c.usedInSteps)}</div>
              </div>
            </div>
          `;
        }).join('') || `<div class="text-slate-400 italic p-3">${isExamMode() ? 'No question saves its answer.' : 'No checkpoint captures configured.'}</div>`}
      </div>
    </div>

    <!-- 3. Built-In Participant Tokens Usage -->
    <div class="pt-4 border-t border-slate-200 dark:border-slate-800 space-y-2.5">
      <h3 class="font-bold uppercase text-[10px] tracking-wider text-slate-400">3. Built-In Participant Tokens</h3>
      <div class="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
        ${Object.entries(builtInUsage).map(([tok, refs]) => `
          <div class="p-3 bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-800 rounded-xl space-y-1.5">
            <div class="flex items-center justify-between">
              <span class="font-mono font-bold text-slate-800 dark:text-slate-200">{{ ${tok} }}</span>
              <span class="text-[10px] font-mono text-slate-400">${refs.length} ref(s)</span>
            </div>
            <div class="flex flex-wrap gap-1">${renderStepRefBadges(refs)}</div>
          </div>
        `).join('')}
      </div>
    </div>
  `;

  container.innerHTML = html;
}

function handleLibraryDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('dropZone')?.classList.add('border-brand-500', 'bg-brand-50/40', 'dark:bg-brand-950/20');
}

function handleLibraryDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('dropZone')?.classList.remove('border-brand-500', 'bg-brand-50/40', 'dark:bg-brand-950/20');
}

function handleLibraryDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  handleLibraryDragLeave(e);
  const files = Array.from(e.dataTransfer?.files || []);
  if (files.length > 0) {
    processImageFilesForLibrary(files);
  }
}

function handleImageFileSelect(e) {
  const files = Array.from(e.target.files || []);
  if (files.length > 0) {
    processImageFilesForLibrary(files);
  }
  e.target.value = '';
}

function processImageFilesForLibrary(files) {
  const accepted = [];
  files.forEach(file => {
    const ext = (file.name.split('.').pop() || '').toLowerCase();
    if (!IMAGE_MIMES[file.type] && !IMAGE_EXTENSIONS.includes(ext === 'jpeg' ? 'jpg' : ext)) {
      showToast(`Unsupported image format: ${file.name}. Use PNG, JPEG, GIF, or WebP.`, 'error');
      return;
    }
    if (file.size > IMAGE_MAX_BYTES) {
      showToast(`File ${file.name} exceeds the ${Math.round(IMAGE_MAX_BYTES / 1024 / 1024)}MB limit.`, 'error');
      return;
    }
    accepted.push(file);
  });
  if (!accepted.length) return;
  // Inside vLabs the library is vLabs' own: the app uploads the files.
  if (studioHost.embedded) {
    studioHost.uploadImages(accepted);
    return;
  }
  let processed = 0;
  accepted.forEach(file => {
    const reader = new FileReader();
    reader.onload = (evt) => {
      // Named exactly as vLabs names an upload (spaces and odd characters become -).
      const cleanName = normaliseImageName(file.name);
      if (!templateData.images) templateData.images = [];
      const existingIdx = templateData.images.findIndex(img => img.name.toLowerCase() === cleanName.toLowerCase());
      if (existingIdx >= 0) {
        templateData.images[existingIdx] = { name: cleanName, url: evt.target.result };
      } else {
        templateData.images.push({ name: cleanName, url: evt.target.result });
      }
      processed++;
      pushHistorySnapshot(true);
      renderImagesGrid();
      runFullValidation(false);
      scheduleAutoSave();
      if (processed === 1) {
        showToast(`Uploaded ${cleanName} to library`, 'success');
      }
    };
    reader.readAsDataURL(file);
  });
}

function extractReferencedImageNames() {
  if (isExamMode()) return extractExamImageRefs();
  const referenced = []; // { fileName, rawPath, locLabel, sIdx, stIdx, isDynamic }
  const scanText = (text, locLabel, sIdx, stIdx) => {
    if (!text || typeof text !== 'string') return;
    const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(text)) !== null) {
      const rawPath = m[1];
      const fileName = rawPath.split('/').pop();
      const isDynamic = /\{\{.*?\}\}/.test(fileName);
      referenced.push({ fileName, rawPath, locLabel, sIdx, stIdx, isDynamic });
    }
  };

  templateData.content.forEach((sec, sIdx) => {
    sec.steps.forEach((st, stIdx) => {
      scanText(st.body, `Section ${sIdx + 1} · Step ${stIdx + 1} body`, sIdx, stIdx);
      if (st.type !== 'info') {
        (st.hints || []).forEach((h, hIdx) => {
          scanText(h.text, `Section ${sIdx + 1} · Step ${stIdx + 1} hint #${hIdx + 1}`, sIdx, stIdx);
        });
        scanText(st.solution, `Section ${sIdx + 1} · Step ${stIdx + 1} solution`, sIdx, stIdx);
      }
    });
  });

  return referenced;
}

function renderImagesGrid() {
  const grid = document.getElementById('imagesGrid');
  const missingNotice = document.getElementById('missingImagesNotice');
  if (!grid) return;

  grid.innerHTML = '';
  const imgs = templateData.images || [];
  const referenced = extractReferencedImageNames();

  const missingSet = new Set();
  referenced.forEach(r => {
    if (r.isDynamic) return;
    const found = imgs.some(img => (img.name || '').toLowerCase() === r.fileName.toLowerCase());
    if (!found) missingSet.add(r.fileName);
  });

  const missing = Array.from(missingSet);
  if (missing.length > 0) {
    missingNotice?.classList.remove('hidden');
    missingNotice.innerHTML = `<i class="ph-bold ph-warning-circle mr-1"></i><strong>Missing referenced images (${missing.length}):</strong> <code class="font-mono">${missing.map(escapeHtml).join(', ')}</code>. Drag & drop them below.`;
  } else {
    missingNotice?.classList.add('hidden');
  }

  imgs.forEach((img, idx) => {
    const card = document.createElement('div');
    card.className = 'bg-slate-50 dark:bg-surface-850 border border-slate-200 dark:border-slate-700 rounded-xl p-2.5 flex flex-col space-y-2';
    card.innerHTML = `
      <div class="h-28 rounded-lg overflow-hidden bg-slate-200 dark:bg-surface-900 flex items-center justify-center">
        <img src="${img.url}" alt="${escapeHtml(img.name)}" class="h-full w-full object-contain">
      </div>
      <span class="text-xs font-mono font-semibold truncate text-slate-800 dark:text-slate-200" title="${escapeHtml(img.name)}">${escapeHtml(img.name)}</span>
      <div class="flex items-center justify-between pt-1 border-t border-slate-200 dark:border-slate-700">
        <button data-on-click="copySnippet('![${escapeHtml(img.name)}](${escapeHtml(img.name)})')" class="text-[10px] font-semibold text-brand-600 dark:text-brand-400 hover:underline">Copy Markdown</button>
        <button data-on-click="deleteImage(${idx})" class="text-slate-400 hover:text-rose-600 text-xs" title="Delete Image"><i class="ph ph-trash"></i></button>
      </div>
    `;
    grid.appendChild(card);
  });

  document.getElementById('imgCountBadge').textContent = imgs.length;
}

function deleteImage(idx) {
  if (studioHost.embedded) {
    studioHost.deleteImage(templateData.images[idx]?.name);
    return;
  }
  templateData.images.splice(idx, 1);
  pushHistorySnapshot(true);
  renderImagesGrid();
  runFullValidation(false);
  scheduleAutoSave();
}

function resetPreviewSimulation(rerender = true) {
  examPreviewState = { answers: {}, checked: false, showKey: false };
  previewState.clearedCheckpoints = {};
  previewState.openedHints = {};
  previewState.revealedSolutions = {};
  previewState.captures = {};
  previewState.feedback = {};
  previewState.inputValues = {};
  if (rerender) {
    renderParticipantPreview();
    showToast('Participant simulation state reset', 'info');
  }
}

function togglePreviewGateMode(checked) {
  previewState.progressiveGate = Boolean(checked);
  renderParticipantPreview();
}

function togglePreviewHint(sIdx, stIdx, hIdx) {
  const key = `${sIdx}-${stIdx}-${hIdx}`;
  previewState.openedHints[key] = !previewState.openedHints[key];
  renderParticipantPreview();
}

function revealPreviewSolution(sIdx, stIdx) {
  const key = `${sIdx}-${stIdx}`;
  previewState.revealedSolutions[key] = !previewState.revealedSolutions[key];
  renderParticipantPreview();
}

function unlockAllHintsAndSolutionInPreview(sIdx, stIdx) {
  const step = templateData.content[sIdx]?.steps[stIdx];
  if (!step) return;
  (step.hints || []).forEach((_, hIdx) => {
    previewState.openedHints[`${sIdx}-${stIdx}-${hIdx}`] = true;
  });
  previewState.revealedSolutions[`${sIdx}-${stIdx}`] = true;
  renderParticipantPreview();
}

function updatePreviewCheckpointInput(sIdx, stIdx, val) {
  previewState.inputValues[`${sIdx}-${stIdx}`] = val;
}

function submitPreviewCheckpoint(sIdx, stIdx) {
  const step = templateData.content[sIdx]?.steps[stIdx];
  if (!step || !step.checkpoint) return;

  const seat = parseInt(document.getElementById('previewSeat')?.value || '7', 10);
  const firstName = document.getElementById('previewFirstName')?.value || 'Mary-Jane';
  const lastName = document.getElementById('previewLastName')?.value || "O'Neil";
  const context = buildEvaluatedContext(seat, firstName, lastName, previewState.captures);

  const key = `${sIdx}-${stIdx}`;
  const userInput = previewState.inputValues[key] ?? '';
  const result = verifyCheckpointSubmission(step.checkpoint, userInput, context);

  if (result.matched) {
    previewState.clearedCheckpoints[key] = true;
    const capName = (step.checkpoint.capture || '').trim();
    if (capName) {
      previewState.captures[capName] = result.canonical;
    }
    previewState.feedback[key] = {
      ok: true,
      msg: capName
        ? `✓ Verified! Captured {{ ${capName} }} = "${result.canonical}"`
        : `✓ Checkpoint verified (${result.canonical})`
    };
  } else {
    previewState.clearedCheckpoints[key] = false;
    previewState.feedback[key] = {
      ok: false,
      msg: `✗ ${result.error}`
    };
  }

  renderParticipantPreview();
}

function autofillPreviewCheckpoint(sIdx, stIdx) {
  const step = templateData.content[sIdx]?.steps[stIdx];
  if (!step || !step.checkpoint) return;
  const cp = step.checkpoint;

  const seat = parseInt(document.getElementById('previewSeat')?.value || '7', 10);
  const firstName = document.getElementById('previewFirstName')?.value || 'Mary-Jane';
  const lastName = document.getElementById('previewLastName')?.value || "O'Neil";
  const context = buildEvaluatedContext(seat, firstName, lastName, previewState.captures);

  const key = `${sIdx}-${stIdx}`;
  if (cp.mode === 'pattern') {
    previewState.inputValues[key] = generateMaskExample(cp.pattern);
  } else {
    previewState.inputValues[key] = substitutePlaceholders(cp.answer || '', context);
  }
  submitPreviewCheckpoint(sIdx, stIdx);
}

function renderParticipantPreview() {
  if (isExamMode()) return renderExamPreview();
  const container = document.getElementById('previewManualContainer');
  const varsBar = document.getElementById('previewVariablesBar');
  if (!container) return;

  const seat = parseInt(document.getElementById('previewSeat')?.value || '7', 10);
  const firstName = document.getElementById('previewFirstName')?.value || 'Mary-Jane';
  const lastName = document.getElementById('previewLastName')?.value || "O'Neil";

  const context = buildEvaluatedContext(seat, firstName, lastName, previewState.captures);

  // Render top bar showing active variables & captured values for this participant
  if (varsBar) {
    const varPills = (templateData.variables || []).map(v => `
      <span class="px-2 py-0.5 rounded-md bg-slate-100 dark:bg-surface-850 border border-slate-200 dark:border-slate-700 font-mono">
        <span class="text-brand-600 dark:text-brand-400 font-semibold">${escapeHtml(v.name)}</span>=${escapeHtml(String(context[v.name] ?? ''))}
      </span>
    `).join('');

    const capPills = Object.entries(previewState.captures).map(([k, val]) => `
      <span class="px-2 py-0.5 rounded-md bg-emerald-50 dark:bg-emerald-950/40 border border-emerald-200 dark:border-emerald-800 font-mono">
        <i class="ph-fill ph-flag text-emerald-500 mr-0.5"></i><span class="text-emerald-700 dark:text-emerald-300 font-semibold">${escapeHtml(k)}</span>=${escapeHtml(String(val))}
      </span>
    `).join('');

    varsBar.innerHTML = `
      <span class="text-[10px] font-bold uppercase text-slate-400 mr-1">Resolved Context:</span>
      <span class="px-2 py-0.5 rounded-md bg-brand-50 dark:bg-brand-950/30 border border-brand-200/60 dark:border-brand-800/50 font-mono text-brand-700 dark:text-brand-300">SEAT_ID=${seat}</span>
      ${varPills}
      ${capPills}
    `;
  }

  let html = `
    <div class="bg-white dark:bg-surface-900 border border-slate-200 dark:border-slate-800 rounded-2xl p-6 shadow-xs space-y-6">
      <div class="border-b border-slate-100 dark:border-slate-800 pb-4 flex items-start justify-between gap-4">
        <div>
          <h1 class="text-xl font-bold text-slate-900 dark:text-slate-100">${escapeHtml(substitutePlaceholders(templateData.title, context))}</h1>
          <p class="text-xs text-slate-500 mt-1">${escapeHtml(substitutePlaceholders(templateData.description, context))}</p>
        </div>
        <span class="px-2.5 py-1 rounded-full text-[11px] font-mono font-bold bg-brand-50 dark:bg-brand-950/50 text-brand-600 dark:text-brand-400 border border-brand-200 dark:border-brand-800 shrink-0">
          Seat #${seat} · ${escapeHtml(firstName)} ${escapeHtml(lastName)}
        </span>
      </div>
  `;

  let previousSectionsCleared = true;

  templateData.content.forEach((sec, sIdx) => {
    if (previewState.progressiveGate && !previousSectionsCleared) {
      html += `
        <div class="p-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 bg-slate-50/50 dark:bg-surface-950/50 flex items-center justify-between text-xs text-slate-400">
          <span class="font-semibold flex items-center gap-2">
            <i class="ph-fill ph-lock-key text-sm"></i> Section ${sIdx + 1} · ${escapeHtml(substitutePlaceholders(sec.title, context))}
          </span>
          <span class="text-[11px]">Locked — clear all checkpoints in earlier sections to unlock</span>
        </div>
      `;
      return;
    }

    html += `
      <div class="space-y-4 pt-4 border-t border-slate-100 dark:border-slate-800 first:border-0 first:pt-0">
        <h2 class="text-sm font-bold uppercase tracking-wider text-brand-600 dark:text-brand-400">
          # ${sIdx + 1} · ${escapeHtml(substitutePlaceholders(sec.title, context))}
        </h2>
    `;

    let haltFurtherStepsInSection = false;
    const totalStepsInSec = sec.steps.length;

    sec.steps.forEach((st, stIdx) => {
      const stepKey = `${sIdx}-${stIdx}`;
      const hasCheckpoint = st.type !== 'info' && st.checkpoint && (
        (st.checkpoint.mode === 'pattern' && st.checkpoint.pattern) ||
        (st.checkpoint.mode !== 'pattern' && st.checkpoint.answer)
      );
      const isCpCleared = Boolean(previewState.clearedCheckpoints[stepKey]);

      if (hasCheckpoint && !isCpCleared) {
        previousSectionsCleared = false;
      }

      if (previewState.progressiveGate && haltFurtherStepsInSection) {
        html += `
          <div class="p-3 rounded-xl border border-dashed border-slate-200 dark:border-slate-800 text-slate-400 text-xs flex items-center gap-2">
            <i class="ph ph-lock"></i>
            <span>Step ${stIdx + 1} (${escapeHtml(substitutePlaceholders(st.title || `Step ${stIdx + 1}`, context))}) is hidden until the previous checkpoint is cleared.</span>
          </div>
        `;
        return;
      }

      const renderedBody = resolveMarkdownImages(st.body, context);
      const badgeTheme = st.type === 'desk'
        ? 'bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300 border-amber-300 dark:border-amber-800'
        : st.type === 'computer'
          ? 'bg-blue-100 text-blue-800 dark:bg-blue-950/60 dark:text-blue-300 border-blue-300 dark:border-blue-800'
          : 'bg-slate-200 text-slate-700 dark:bg-slate-800 dark:text-slate-300 border-slate-300 dark:border-slate-700';

      const badgeLabel = st.type === 'desk' ? 'Hands-On' : st.type === 'computer' ? 'Workstation' : 'Read';

      // Hints & Solution state
      const hints = st.type !== 'info' ? (st.hints || []) : [];
      let openedHintsCount = 0;
      hints.forEach((_, hIdx) => {
        if (previewState.openedHints[`${sIdx}-${stIdx}-${hIdx}`]) openedHintsCount++;
      });
      const allHintsOpened = hints.length === 0 || openedHintsCount === hints.length;
      const isSolutionRevealed = Boolean(previewState.revealedSolutions[stepKey]);

      html += `
        <div class="bg-slate-50/70 dark:bg-surface-850 border ${st.type === 'info' ? 'border-dashed' : ''} border-slate-200 dark:border-slate-800 rounded-xl p-4 space-y-3.5">
          <div class="flex items-center justify-between border-b border-slate-200/60 dark:border-slate-800 pb-2.5">
            <div class="flex items-center space-x-2">
              <span class="text-[10px] font-mono text-slate-400">${stIdx + 1} / ${totalStepsInSec}</span>
              <span class="text-xs font-bold text-slate-900 dark:text-slate-100">
                ${escapeHtml(substitutePlaceholders(st.title || `Step ${stIdx + 1}`, context))}
              </span>
            </div>
            <div class="flex items-center space-x-2">
              <button data-on-click="jumpToStep(${sIdx}, ${stIdx})" class="text-[10px] text-slate-400 hover:text-brand-500" title="Edit Step in Builder">
                <i class="ph ph-pencil-simple"></i> Edit
              </button>
              <span class="text-[10px] uppercase font-semibold px-2 py-0.5 rounded border ${badgeTheme}">
                ${badgeLabel}
              </span>
            </div>
          </div>

          <div class="prose-preview text-xs text-slate-700 dark:text-slate-200">
            ${parseMarkdownSafe(renderedBody)}
          </div>

          ${hints.length > 0 ? `
            <div class="space-y-1.5 pt-2 border-t border-slate-200/60 dark:border-slate-800">
              <div class="text-[10px] font-bold uppercase text-amber-600 dark:text-amber-400 flex items-center justify-between">
                <span><i class="ph-bold ph-lightbulb"></i> Hints (${openedHintsCount}/${hints.length} opened)</span>
              </div>
              ${hints.map((h, hIdx) => {
                const isOpen = Boolean(previewState.openedHints[`${sIdx}-${stIdx}-${hIdx}`]);
                return `
                  <div class="border border-amber-200/80 dark:border-amber-800/50 rounded-lg overflow-hidden bg-amber-50/40 dark:bg-amber-950/20">
                    <button data-on-click="togglePreviewHint(${sIdx}, ${stIdx}, ${hIdx})" class="w-full px-3 py-2 text-left text-xs font-semibold text-amber-900 dark:text-amber-200 flex items-center justify-between hover:bg-amber-100/50 dark:hover:bg-amber-900/30 transition">
                      <span><i class="ph-bold ph-question mr-1.5 text-amber-500"></i>${escapeHtml(substitutePlaceholders(h.label || 'Hint', context))}</span>
                      <i class="ph ${isOpen ? 'ph-caret-up' : 'ph-caret-down'} text-xs"></i>
                    </button>
                    ${isOpen ? `
                      <div class="px-3 py-2.5 border-t border-amber-200/60 dark:border-amber-800/40 prose-preview text-xs text-slate-700 dark:text-slate-200 bg-white/80 dark:bg-surface-900/80">
                        ${parseMarkdownSafe(resolveMarkdownImages(h.text || '', context))}
                      </div>
                    ` : ''}
                  </div>
                `;
              }).join('')}
            </div>
          ` : ''}

          ${(st.type !== 'info' && st.solution && st.solution.trim()) ? `
            <div class="pt-2 border-t border-slate-200/60 dark:border-slate-800">
              <div class="flex items-center justify-between">
                <button data-on-click="${allHintsOpened ? `revealPreviewSolution(${sIdx}, ${stIdx})` : `unlockAllHintsAndSolutionInPreview(${sIdx}, ${stIdx})`}"
                  class="inline-flex items-center space-x-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold transition ${allHintsOpened ? 'bg-emerald-600 hover:bg-emerald-700 text-white' : 'bg-slate-200 dark:bg-surface-800 text-slate-600 dark:text-slate-400 hover:bg-slate-300'}">
                  <i class="ph-bold ${allHintsOpened ? 'ph-key' : 'ph-lock-key'}"></i>
                  <span>${isSolutionRevealed ? 'Hide Walkthrough Solution' : allHintsOpened ? 'Reveal Walkthrough Solution' : `Open all ${hints.length} hint(s) to unlock Solution (Click to auto-open)`}</span>
                </button>
              </div>
              ${isSolutionRevealed ? `
                <div class="mt-2 p-3.5 rounded-xl bg-emerald-50/60 dark:bg-emerald-950/25 border border-emerald-200 dark:border-emerald-800/60 prose-preview text-xs text-slate-800 dark:text-slate-200">
                  <div class="text-[10px] font-bold uppercase text-emerald-700 dark:text-emerald-400 mb-1.5 flex items-center gap-1">
                    <i class="ph-bold ph-check-circle"></i> Walkthrough Solution
                  </div>
                  ${parseMarkdownSafe(resolveMarkdownImages(st.solution, context))}
                </div>
              ` : ''}
            </div>
          ` : ''}

          ${hasCheckpoint ? (() => {
            const cp = st.checkpoint;
            const val = previewState.inputValues[stepKey] ?? '';
            const fb = previewState.feedback[stepKey];
            return `
              <div class="pt-3 border-t border-slate-200/80 dark:border-slate-800">
                <div class="p-3.5 rounded-xl ${isCpCleared ? 'bg-emerald-50/50 dark:bg-emerald-950/20 border-emerald-300 dark:border-emerald-800/60' : 'bg-brand-50/50 dark:bg-brand-950/20 border-brand-200/80 dark:border-brand-800/50'} border space-y-2.5">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <label class="text-xs font-bold text-slate-800 dark:text-slate-100 flex items-center gap-1.5">
                      <i class="ph-fill ph-flag ${isCpCleared ? 'text-emerald-600' : 'text-brand-600'}"></i>
                      <span>${escapeHtml(substitutePlaceholders(cp.prompt || 'Enter the value to continue', context))}</span>
                    </label>
                    <div class="flex items-center space-x-2">
                      <span class="text-[10px] font-mono px-2 py-0.5 rounded bg-white/80 dark:bg-surface-900 border border-slate-200 dark:border-slate-700 text-slate-500">
                        ${cp.mode === 'pattern' ? `Mask: ${escapeHtml(cp.pattern)}` : `Exact Match`}
                        ${cp.capture ? ` · Captures {{ ${escapeHtml(cp.capture)} }}` : ''}
                      </span>
                      <button type="button" data-on-click="autofillPreviewCheckpoint(${sIdx}, ${stIdx})" class="text-[10px] font-semibold text-brand-600 dark:text-brand-400 hover:underline" title="Author shortcut: Fill valid sample answer & verify">
                        Auto-Fill Valid
                      </button>
                    </div>
                  </div>

                  <div class="flex items-center space-x-2">
                    <input type="text" value="${escapeHtml(val)}"
                      placeholder="${escapeHtml(substitutePlaceholders(cp.placeholder || '', context))}"
                      data-on-input="updatePreviewCheckpointInput(${sIdx}, ${stIdx}, this.value)"
                      data-on-keydown="if(event.key==='Enter') submitPreviewCheckpoint(${sIdx}, ${stIdx})"
                      class="flex-1 text-xs font-mono px-3 py-2 rounded-lg bg-white dark:bg-surface-900 border border-slate-300 dark:border-slate-700 text-slate-900 dark:text-slate-100 focus:outline-none focus:ring-2 focus:ring-brand-500">
                    <button type="button" data-on-click="submitPreviewCheckpoint(${sIdx}, ${stIdx})" class="px-4 py-2 bg-brand-600 hover:bg-brand-700 text-white rounded-lg text-xs font-semibold shadow-2xs transition shrink-0">
                      Verify
                    </button>
                  </div>

                  ${fb ? `
                    <div class="text-xs font-semibold ${fb.ok ? 'text-emerald-700 dark:text-emerald-400' : 'text-rose-600 dark:text-rose-400'}">
                      ${escapeHtml(fb.msg)}
                    </div>
                  ` : ''}
                </div>
              </div>
            `;
          })() : ''}
        </div>
      `;

      if (hasCheckpoint && !isCpCleared) {
        haltFurtherStepsInSection = true;
      }
    });

    html += `</div>`;
  });

  html += `</div>`;
  container.innerHTML = html;
}

/**
 * Variable names and formulas (labs and exams), by vLabs' own rules
 * (shared/validate-template.js: every formula for seats 1–100), shown at each
 * variable. Returns the declared names.
 */
function collectVariableIssues(addError) {
  const vars = templateData.variables || [];
  if (vars.length > LIMITS.variables) {
    addError("Variables", `Too many variables (${vars.length} / ${LIMITS.variables} max)`, { view: 'variables' });
  }
  const list = vars.map(v => ({ name: (v.name || '').trim(), expression: (v.expression || '').trim() }));
  for (const { index, name, message } of variableIssues(list)) {
    addError(`Variable #${index + 1}${name ? ` (${name})` : ''}`, message, { view: 'variables' });
  }
  return new Set(list.map(v => v.name).filter(Boolean));
}

function runFullValidation(showToasts = true) {
  const issues = []; // { severity: 'error' | 'warning', loc: string, msg: string, sIdx?: number, stIdx?: number, view?: string }

  const addError = (loc, msg, nav = {}) => issues.push({ severity: 'error', loc, msg, ...nav });
  const addWarning = (loc, msg, nav = {}) => issues.push({ severity: 'warning', loc, msg, ...nav });

  if (isExamMode()) return renderValidationIssues(issues, showToasts, collectExamIssues(addError, addWarning));

  // 1. Front Matter & Structural Limits (§13, §14)
  const title = (templateData.title || '').trim();
  const desc = (templateData.description || '');
  if (!title) {
    addError("Front Matter", "Title is required", { view: 'builder' });
  } else if (title.length > 200) {
    addError("Front Matter", `Title exceeds 200 characters (${title.length} / 200)`, { view: 'builder' });
  }
  if (desc.length > 1000) {
    addError("Front Matter", `Description exceeds 1000 characters (${desc.length} / 1000)`, { view: 'builder' });
  }

  const declaredVarNames = collectVariableIssues(addError);

  // Pre-collect all captures and their first definition step
  const allCaptureLocations = new Map(); // captureName -> { sIdx, stIdx }
  (templateData.content || []).forEach((sec, sIdx) => {
    (sec.steps || []).forEach((st, stIdx) => {
      if (st.type !== 'info' && st.checkpoint && st.checkpoint.capture) {
        const cName = st.checkpoint.capture.trim();
        if (cName && !allCaptureLocations.has(cName)) {
          allCaptureLocations.set(cName, { sIdx, stIdx });
        }
      }
    });
  });

  // 3. Sections, Steps, Placeholders, Checkpoints & Captures
  const sections = templateData.content || [];
  if (sections.length === 0) {
    addError("Structure", "At least one section is required", { view: 'builder' });
  } else if (sections.length > LIMITS.sections) {
    addError("Structure", `Too many sections (${sections.length} / ${LIMITS.sections} max)`, { view: 'builder' });
  }

  const activeCapturedVarNames = new Set();

  const validateTextPlaceholders = (text, locLabel, sIdx, stIdx) => {
    const tokens = extractPlaceholdersFromText(text);
    tokens.forEach(tok => {
      if (BUILTIN_PLACEHOLDERS.has(tok) || declaredVarNames.has(tok) || activeCapturedVarNames.has(tok)) {
        return;
      }
      if (allCaptureLocations.has(tok)) {
        addError(locLabel, `{{ ${tok} }} is used in ${locLabel} before the checkpoint that captures it`, { sIdx, stIdx });
      } else {
        addError(locLabel, `Unknown placeholder {{ ${tok} }} in ${locLabel}`, { sIdx, stIdx });
      }
    });
  };

  sections.forEach((sec, sIdx) => {
    const secLoc = `Section ${sIdx + 1}`;
    const secTitle = (sec.title || '').trim();
    if (!secTitle) {
      addError(secLoc, `Section ${sIdx + 1} needs a title`, { sIdx, stIdx: 0 });
    } else if (secTitle.length > 200) {
      addError(secLoc, `Section ${sIdx + 1} title exceeds 200 characters`, { sIdx, stIdx: 0 });
    }
    validateTextPlaceholders(sec.title, `${secLoc} title`, sIdx, 0);
    if (sec.minutes !== null && sec.minutes !== undefined && sec.minutes !== '' && !validSectionMinutes(sec.minutes)) {
      addError(secLoc, `Section ${sIdx + 1} time allocated must be a whole number of minutes from 1 to 600 (or empty)`, { sIdx, stIdx: 0 });
    }

    const steps = sec.steps || [];
    if (steps.length === 0) {
      addError(secLoc, `Section ${sIdx + 1} has no steps`, { sIdx, stIdx: 0 });
    } else if (steps.length > 100) {
      addError(secLoc, `Section ${sIdx + 1} has too many steps (${steps.length} / 100 max)`, { sIdx, stIdx: 0 });
    }

    steps.forEach((st, stIdx) => {
      const stLoc = `Section ${sIdx + 1} · Step ${stIdx + 1}`;
      if ((st.title || '').length > 200) {
        addError(stLoc, `${stLoc} title exceeds 200 characters`, { sIdx, stIdx });
      }
      validateTextPlaceholders(st.title, `${stLoc} title`, sIdx, stIdx);

      const body = st.body || '';
      if (!body.trim()) {
        addError(stLoc, `${stLoc} has an empty body`, { sIdx, stIdx });
      } else if (body.length > 20000) {
        addError(stLoc, `${stLoc} body exceeds 20,000 characters`, { sIdx, stIdx });
      }
      validateTextPlaceholders(body, `${stLoc} body`, sIdx, stIdx);

      if (st.type !== 'info') {
        const hints = st.hints || [];
        if (hints.length > 20) {
          addError(stLoc, `${stLoc} has too many hints (${hints.length} / 20 max)`, { sIdx, stIdx });
        }
        hints.forEach((h, hIdx) => {
          const hLoc = `${stLoc} hint #${hIdx + 1}`;
          if ((h.label || '').length > 120) {
            addError(hLoc, `Hint label exceeds 120 characters`, { sIdx, stIdx });
          }
          if ((h.text || '').length > 4000) {
            addError(hLoc, `Hint text exceeds 4000 characters`, { sIdx, stIdx });
          }
          validateTextPlaceholders(h.label, `${hLoc} label`, sIdx, stIdx);
          validateTextPlaceholders(h.text, `${hLoc} text`, sIdx, stIdx);
        });

        if (st.solution) {
          if (st.solution.length > 4000) {
            addError(stLoc, `${stLoc} solution exceeds 4000 characters`, { sIdx, stIdx });
          }
          validateTextPlaceholders(st.solution, `${stLoc} solution`, sIdx, stIdx);
          if (hints.length === 0) {
            addWarning(stLoc, `${stLoc} has a walkthrough solution but 0 hints (solution will be immediately available to participants)`, { sIdx, stIdx });
          }
        }

        if (st.checkpoint) {
          const cp = st.checkpoint;
          const cpLoc = `${stLoc} checkpoint`;
          if ((cp.prompt || '').length > 300) {
            addError(cpLoc, `Checkpoint prompt exceeds 300 characters`, { sIdx, stIdx });
          }
          if ((cp.placeholder || '').length > 120) {
            addError(cpLoc, `Checkpoint placeholder exceeds 120 characters`, { sIdx, stIdx });
          }
          validateTextPlaceholders(cp.prompt, `${cpLoc} prompt`, sIdx, stIdx);
          validateTextPlaceholders(cp.placeholder, `${cpLoc} placeholder`, sIdx, stIdx);

          if (cp.mode === 'pattern') {
            const patRes = parsePatternMaskTokens(cp.pattern || '');
            if (!patRes.valid) {
              addError(`${cpLoc} pattern`, patRes.error, { sIdx, stIdx });
            }
            if (!cp.placeholder || !cp.placeholder.trim()) {
              addWarning(cpLoc, `Pattern checkpoint should include a placeholder showing the expected format`, { sIdx, stIdx });
            }
          } else {
            const ans = (cp.answer || '').trim();
            if (!ans) {
              addWarning(cpLoc, `Exact checkpoint has an empty answer (will be ignored/dropped on save)`, { sIdx, stIdx });
            } else if (ans.length > 200) {
              addError(cpLoc, `Checkpoint answer exceeds 200 characters`, { sIdx, stIdx });
            }
            validateTextPlaceholders(cp.answer, `${cpLoc} answer`, sIdx, stIdx);

            const alts = cp.answers || [];
            if (alts.length > LIMITS.altAnswers) {
              addError(cpLoc, `Too many accepted answers (${alts.length + 1} / ${LIMITS.acceptedAnswers} max, the answer included)`, { sIdx, stIdx });
            }
            alts.forEach((alt, aIdx) => {
              if ((alt || '').length > 200) {
                addError(cpLoc, `Alternative answer #${aIdx + 1} exceeds 200 characters`, { sIdx, stIdx });
              }
              validateTextPlaceholders(alt, `${cpLoc} alternative #${aIdx + 1}`, sIdx, stIdx);
            });
          }

          // Validate capture variable name (becomes available AFTER this step!)
          const capName = (cp.capture || '').trim();
          if (capName) {
            if (capName.length > 40) {
              addError(cpLoc, `Capture name "${capName}" exceeds 40 characters`, { sIdx, stIdx });
            } else if (!VALID_VAR_NAME_RE.test(capName)) {
              addError(cpLoc, `"${capName}" is not a valid variable name`, { sIdx, stIdx });
            } else if (RESERVED_NAMES.has(capName)) {
              addError(cpLoc, `Capture variable name "${capName}" is reserved`, { sIdx, stIdx });
            } else if (declaredVarNames.has(capName)) {
              addError(cpLoc, `"${capName}" is already a declared variable`, { sIdx, stIdx });
            } else if (activeCapturedVarNames.has(capName)) {
              addError(cpLoc, `"${capName}" is already captured by an earlier checkpoint`, { sIdx, stIdx });
            }
            activeCapturedVarNames.add(capName);
          }
        }
      }
    });
  });

  // 4. Image Library References Check (§12, §14)
  const referencedImages = extractReferencedImageNames();
  const libImages = templateData.images || [];
  referencedImages.forEach(ref => {
    if (ref.isDynamic) return;
    const exists = libImages.some(img => (img.name || '').toLowerCase() === ref.fileName.toLowerCase());
    if (!exists) {
      addError(ref.locLabel, `Image "${ref.fileName}" referenced in ${ref.locLabel} is not in the image library — upload it first`, { sIdx: ref.sIdx, stIdx: ref.stIdx });
    }
  });

  return renderValidationIssues(
    issues,
    showToasts,
    `Checked metadata limits, ${declaredVarNames.size} formula(s) for seats 1–100, ${allCaptureLocations.size} capture(s), placeholders, masks, and image assets.`
  );
}

/** Badge, results list and toasts for a validation run (labs and exams). */
function renderValidationIssues(issues, showToasts, okDetail) {
  // The Studio's own checks point at the field to fix. Once they pass, vLabs'
  // validator has the last word, so "Ready to save" means vLabs will take it.
  if (!issues.some(i => i.severity === 'error')) {
    vlabsSaveErrors().forEach(msg => issues.push({ severity: 'error', loc: 'vLabs save check', msg, view: 'builder' }));
  }
  const errorCount = issues.filter(i => i.severity === 'error').length;
  const warnCount = issues.filter(i => i.severity === 'warning').length;

  const badge = document.getElementById('validationErrorBadge');
  if (badge) {
    badge.textContent = errorCount;
    badge.className = errorCount > 0
      ? 'sidebar-label ml-auto text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-rose-100 text-rose-700 dark:bg-rose-950/60 dark:text-rose-400'
      : warnCount > 0
        ? 'sidebar-label ml-auto text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-amber-100 text-amber-700 dark:bg-amber-950/60 dark:text-amber-400'
        : 'sidebar-label ml-auto text-[10px] font-bold px-1.5 py-0.2 rounded-full bg-emerald-100 text-emerald-700 dark:bg-emerald-950/60 dark:text-emerald-400';
  }

  const resultsList = document.getElementById('validationResultsList');
  if (resultsList) {
    if (issues.length === 0) {
      resultsList.innerHTML = `
        <div class="p-4 bg-emerald-50 dark:bg-emerald-950/30 border border-emerald-200 dark:border-emerald-800/50 text-emerald-800 dark:text-emerald-300 rounded-xl flex items-center justify-between">
          <div class="flex items-center space-x-2.5">
            <i class="ph-fill ph-check-circle text-xl text-emerald-500"></i>
            <div>
              <div class="font-bold">All vLabs ${STUDIO_VERSION} Validation Rules Passed</div>
              <div class="text-[11px] opacity-80">${escapeHtml(okDetail)}</div>
            </div>
          </div>
          <span class="px-2.5 py-1 rounded-full text-[10px] font-bold bg-emerald-100 dark:bg-emerald-900/60 text-emerald-700 dark:text-emerald-300">READY TO SAVE</span>
        </div>
      `;
    } else {
      const summaryBanner = `
        <div class="p-3 rounded-xl border ${errorCount > 0 ? 'bg-rose-50/70 dark:bg-rose-950/20 border-rose-200 dark:border-rose-800/40 text-rose-800 dark:text-rose-200' : 'bg-amber-50/70 dark:bg-amber-950/20 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-200'} flex items-center justify-between">
          <span class="font-semibold">
            Found <strong>${errorCount}</strong> error(s) and <strong>${warnCount}</strong> warning(s)
          </span>
          <span class="text-[11px] opacity-80">Click any issue below to jump directly to its location</span>
        </div>
      `;
      resultsList.innerHTML = summaryBanner + issues.map(issue => {
        const isErr = issue.severity === 'error';
        const jumpAction = issue.sIdx !== undefined
          ? `jumpToStep(${issue.sIdx}, ${issue.stIdx ?? 0})`
          : `switchView('${issue.view || 'builder'}')`;

        return `
          <div class="p-3 ${isErr ? 'bg-rose-50 dark:bg-rose-950/30 border-rose-200 dark:border-rose-800/40 text-rose-800 dark:text-rose-200' : 'bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-800/40 text-amber-800 dark:text-amber-200'} border rounded-xl flex flex-col sm:flex-row sm:items-center justify-between gap-2">
            <div class="space-y-0.5">
              <div class="flex items-center space-x-2">
                <span class="px-1.5 py-0.5 rounded text-[9px] font-bold uppercase ${isErr ? 'bg-rose-200/80 dark:bg-rose-900 text-rose-900 dark:text-rose-200' : 'bg-amber-200/80 dark:bg-amber-900 text-amber-900 dark:text-amber-200'}">${issue.severity}</span>
                <strong class="font-mono text-[11px]">${escapeHtml(issue.loc)}</strong>
              </div>
              <p class="text-xs">${escapeHtml(issue.msg)}</p>
            </div>
            <button data-on-click="${jumpAction}" class="px-3 py-1.5 rounded-lg text-[11px] font-semibold shrink-0 transition ${isErr ? 'bg-rose-600 hover:bg-rose-700 text-white' : 'bg-amber-600 hover:bg-amber-700 text-white'} flex items-center gap-1 self-start sm:self-center">
              <i class="ph-bold ph-arrow-bend-up-right"></i> Jump to Issue
            </button>
          </div>
        `;
      }).join('');
    }
  }

  if (showToasts) {
    if (errorCount === 0 && warnCount === 0) {
      showToast('Validation passed with 0 errors!', 'success');
    } else if (errorCount > 0) {
      showToast(`Validation found ${errorCount} error(s)`, 'error');
    } else {
      showToast(`Validation passed with ${warnCount} warning(s)`, 'info');
    }
  }

  return errorCount === 0;
}

/** A section's time allocation: whole minutes from 1 to 600 (vLabs 1.6.0). */
function formatSectionTime(minutes) {
  return `${Number(minutes) || 0} min`;
}

/** The minutes box for a section's time allocation (session lengths are set
    in hours and minutes when a session starts, not in the template), and the
    section's Optional checkbox. */
function sectionTimeInputsHtml(section, sIdx, noun) {
  return `
    <label class="flex items-center shrink-0 text-[10px] font-mono text-slate-400 dark:text-slate-500" title="Time allocated to this ${noun}, in minutes (empty = none). Time on the ${noun} is judged against it.">
      <i class="ph ph-timer text-xs mr-1"></i>
      <input type="number" min="1" max="600" step="1" inputmode="numeric" value="${section.minutes ? escapeHtml(String(section.minutes)) : ''}" placeholder="min"
        class="w-14 text-[11px] font-mono text-slate-700 dark:text-slate-200 bg-transparent border-b border-slate-200 dark:border-white/[0.1] hover:border-slate-300 dark:hover:border-slate-700 focus:border-brand-500 focus:outline-none px-1 py-0.5 transition"
        data-action="update-sec-minutes" data-sec-idx="${sIdx}" aria-label="Minutes allocated to ${noun} ${sIdx + 1}">
      <span class="ml-1 hidden sm:inline">min</span>
    </label>
    <label class="flex items-center shrink-0 gap-1 text-[10px] font-medium text-slate-500 dark:text-slate-400 cursor-pointer" title="Optional ${noun}: participants can still do it, but it is left out of progress and is not needed to finish.">
      <input type="checkbox" ${section.optional ? 'checked' : ''} class="accent-brand-500"
        data-action="update-sec-optional" data-sec-idx="${sIdx}" aria-label="${noun[0].toUpperCase()}${noun.slice(1)} ${sIdx + 1} is optional">
      <span>Optional</span>
    </label>`;
}

function validSectionMinutes(v) {
  return normaliseMinutes(v) !== null;
}

function generateMarkdown() {
  if (isExamMode()) return examToMarkdownText(templateData);
  return templateToMarkdown(templateData);
}

function generateCanonicalJson() {
  if (isExamMode()) return generateExamCanonicalJson();
  return templateToJson(templateData);
}

/** Read pasted or imported text: canonical JSON, exam Markdown or lab Markdown. */
function parseMarkdown(mdText) {
  const normalizedMd = String(mdText || '').replace(/\r\n/g, '\n');
  if (/^\s*\{[\s\S]*\}\s*$/.test(normalizedMd)) {
    let parsedJson;
    try {
      parsedJson = JSON.parse(normalizedMd);
    } catch (err) {
      throw new Error(`The JSON could not be read: ${err.message}`);
    }
    return normalizeImportedJsonTemplate(parsedJson);
  }
  // Exam Markdown (vLabs exam format): front matter `kind: exam`, or
  // `## [single]`-style question headings.
  if (looksLikeExamMarkdown(normalizedMd)) return studioExamFromCanonical(examParseMarkdown(normalizedMd));
  return studioLabFromCanonical(parseMarkdownTemplate(normalizedMd));
}

function normalizeImportedJsonTemplate(json) {
  if (json && json.kind === 'exam') return studioExamFromCanonical(json);
  return studioLabFromCanonical(json);
}

/**
 * A lab in vLabs' canonical shape (shared/template-schema.js) as the Studio
 * edits it: the same fields plus collapse / preview flags, and the library.
 */
function studioLabFromCanonical(raw) {
  const tpl = normaliseTemplate(raw);
  if (!tpl.content.length) tpl.content.push(blankSection(1));
  return {
    title: tpl.title,
    description: tpl.description,
    variables: tpl.variables,
    content: tpl.content.map(sec => ({
      ...sec,
      collapsed: false,
      steps: (sec.steps.length ? sec.steps : [blankStep()]).map(st => ({ ...st, collapsed: false, previewOpen: false }))
    })),
    images: templateData.images || []
  };
}

/** File-name stem for this template's exports. */
function templateFileSlug() {
  return (templateData.title || "template").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, '') || 'template';
}

async function exportAsZipPackage() {
  document.getElementById('exportMenu')?.classList.add('hidden');
  const content = await buildZipPackage();
  const a = document.createElement("a");
  a.href = URL.createObjectURL(content);
  a.download = `${templateFileSlug()}.zip`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Archive package downloaded (.zip)", "success");
}

/** The template and its images as a vLabs package (.zip Blob). */
async function buildZipPackage() {
  const zip = new JSZip();
  const mdContent = generateMarkdown();
  zip.file("template.md", mdContent);
  zip.file("template.json", generateCanonicalJson());

  const imagesFolder = zip.folder("images");
  let imgs = templateData.images || [];
  if (studioHost.embedded) {
    // vLabs' library is shared by every template: package only this one's
    // images (all of them when a name is per-seat, e.g. bench-{{ SEAT_ID }}.png).
    const refs = extractReferencedImageNames();
    if (!refs.some(r => r.isDynamic)) {
      const wanted = new Set(refs.map(r => r.fileName.toLowerCase()));
      imgs = imgs.filter(img => wanted.has(String(img.name).toLowerCase()));
    }
  }

  for (const img of imgs) {
    if (img.url && !img.url.startsWith("data:")) {
      try {
        const res = await fetch(img.url);
        if (res.ok) imagesFolder.file(img.name, await res.blob());
      } catch (_) {
        showToast(`Could not add ${img.name} to the package`, 'error');
      }
    } else if (img.url) {
      const commaIdx = img.url.indexOf(',');
      const header = img.url.slice(0, commaIdx);
      const payload = img.url.slice(commaIdx + 1);
      if (header.includes(';base64')) {
        imagesFolder.file(img.name, payload, { base64: true });
      } else {
        imagesFolder.file(img.name, decodeURIComponent(payload));
      }
    }
  }

  return zip.generateAsync({ type: "blob" });
}

function exportAsMarkdown() {
  document.getElementById('exportMenu')?.classList.add('hidden');
  const md = generateMarkdown();
  const blob = new Blob([md], { type: "text/markdown;charset=utf-8" });
  const slug = (templateData.title || "template").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, '') || 'template';
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.md`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Markdown downloaded (.md)", "success");
}

function exportAsJson() {
  document.getElementById('exportMenu')?.classList.add('hidden');
  const jsonStr = generateCanonicalJson();
  const blob = new Blob([jsonStr], { type: "application/json;charset=utf-8" });
  const slug = (templateData.title || "template").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, '') || 'template';
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${slug}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  showToast("Canonical JSON downloaded (.json)", "success");
}

function copyMarkdownToClipboard() {
  document.getElementById('exportMenu')?.classList.add('hidden');
  const md = generateMarkdown();
  copySnippet(md, "Markdown copied to clipboard");
}

const GUIDE_PRESETS_MARKDOWN = {
  exam: `---
kind: exam
title: Network Fundamentals — Quiz (Sample)
description: A short sample exam showing every question and step type.
variables:
  SUBNET = '10.' + seat + '.0.0/24'
---

# Part 1 · Addressing
> minutes: 5

## [info] Your bench
You are on seat {{ SEAT_ID }}. Your subnet is **{{ SUBNET }}**.

## [single] Which address is a valid private IPv4 address?
- [ ] 8.8.8.8
- [x] 192.168.1.20
- [ ] 172.32.0.1
> points: 2

## [multiple] Select every protocol that normally runs over UDP.
- [x] DNS
- [ ] SSH
- [x] DHCP
- [ ] HTTPS

## [truefalse] A /24 network has 254 usable host addresses.
> answer: true

# Part 2 · Bench check
> minutes: 15

## [checklist] Cable the bench
Cable your switch to the router as shown on the bench card. Tick each item
once it is done.
- [ ] Switch port Gi0/1 is cabled to the router
- [ ] The link light is green on both ends

## [short] Read the serial number off the back of your switch.
> pattern: XXXX.XXXX.XXXX
> placeholder: e.g. ABCD.1234.EFGH
> capture: SERIAL

## [checklist] Instructor check
Raise your hand so your instructor can check your bench.
- [ ] My instructor has checked my bench

# Part 3 · Short answers
> minutes: 10

## [short] What TCP port does HTTPS use by default?
> accept: 443 | tcp/443

## [short] Type the serial number of your switch again.
> accept: {{ SERIAL }}

## [long]
In two or three sentences, explain why networks are split into VLANs.
> points: 5

# [submit] Review and submit

Check that every question has an answer. Once you submit you cannot change
your answers.
`,
  minimal: `---
title: Course Name — Lab Name
description: Who it is for, how long it takes, how many seats.
variables:
  SEAT_TAG = 'S' + pad(seat, 2)
---

# Section 1 · Briefing

## [info] What you will do
{{ FIRST_NAME }}, you are seat {{ SEAT_ID }} (tag {{ SEAT_TAG }}). Read this, then start.

# Section 2 · First task

## [desk] Do the thing
Imperative instructions for one action. State what success looks like.

> hint: The question a stuck person asks :: The nudge that gets them moving.

> checkpoint: What value proves it was done?
> accept: {{ SEAT_TAG }} | S{{ SEAT_ID }}
> placeholder: e.g. S07

# Section 3 · Second task

## [computer] Record something you cannot predict
Where to find it and in what notation.

> checkpoint: Enter the asset tag
> pattern: AAA-9999
> capture: ASSET
> placeholder: e.g. ABC-1234

## [computer] Use it
Attach the label **{{ ASSET }}** and re-enter the tag to confirm.

> checkpoint: Confirm the asset tag
> accept: {{ ASSET }}

# Section 4 · Wrap up
> optional: true

## [info] Done
What to leave as-is and what to hand in. Your tag was {{ ASSET }}.`,

  network: `---
title: Switch & Host Addressing — Bench Lab
description: Cable a bench, assign a static IP, verify connectivity. 60 min, 24 seats.
variables:
  PORT_NUM    = seat
  SEAT_TAG    = 'S' + pad(seat, 2)
  VLAN        = 10 + seat
  HOST_IP     = '10.0.0.' + (100 + seat)
  HOST_CIDR   = HOST_IP + '/24'
  GATEWAY_IP  = '192.168.1.' + (100 + seat)
  SUBNET      = '255.255.255.0'
  POD         = ceil(seat / 4)
  POD_MEMBER  = mod(seat - 1, 4) + 1
---

# Section 1 · Briefing

## [info] Welcome
Welcome, {{ FIRST_NAME }} — you are **seat {{ SEAT_ID }}**, bench pod {{ POD }} (member {{ POD_MEMBER }} of 4).

In this lab you will cable your workstation to switch port {{ PORT_NUM }}, assign a static address and prove the link works. Values in **bold** are specific to your seat; your neighbour's will differ.

## [info] Safety
- Power down before touching the patch panel.
- Route cables under the desk lip, never across the aisle.

# Section 2 · Cabling

## [desk] Find your port
Locate **port {{ PORT_NUM }}** on the patch panel. It is labelled with your seat tag **{{ SEAT_TAG }}**.

> hint: Where is the patch panel? :: The grey 24-port unit at eye level above your desk.

## [desk] Connect the patch cable
Connect the cable tagged **{{ SEAT_TAG }}** from port {{ PORT_NUM }} to your workstation NIC. Push until the clip *clicks*.

Count the link LEDs lit on the patch panel for your pod (ports {{ POD }}1–{{ POD }}4 area) and enter the number of **amber** LEDs you see on **your** port to continue.

> hint: No LED at all? :: Reseat both ends; an unlit port means no electrical link yet.
> A solid amber LED means 100 Mb/s, green means 1 Gb/s.

> checkpoint: How many amber LEDs are lit on your port?
> accept: 0 | 1
> placeholder: 0 or 1

# Section 3 · Configuration

## [computer] Assign a static IP
Apply this configuration to your workstation:

| Setting | Value |
| --- | --- |
| IP address | \`{{ HOST_IP }}\` |
| Subnet mask | \`{{ SUBNET }}\` |
| Default gateway | \`{{ GATEWAY_IP }}\` |
| VLAN | \`{{ VLAN }}\` |

> hint: Command line (Linux) :: \`\`\`
> sudo ip addr add {{ HOST_CIDR }} dev eth0
> sudo ip route add default via {{ GATEWAY_IP }}
> \`\`\`

## [computer] Verify connectivity
Ping the gateway and confirm replies with TTL 64:

\`\`\`
ping -c 4 {{ GATEWAY_IP }}
\`\`\`

Then read your own address back and enter it below.

> hint: How do I read my IP? :: \`ip addr show eth0\` (Linux) or \`ipconfig\` (Windows); copy the IPv4 address.

> solution:
> Your host address is built from your seat number: \`10.0.0.\` + (100 + {{ SEAT_ID }}) = **{{ HOST_IP }}**.
> If ping fails, check the gateway is \`{{ GATEWAY_IP }}\` and the mask is \`{{ SUBNET }}\`.

> checkpoint: Enter the IPv4 address shown on your workstation
> accept: {{ HOST_IP }} | {{ HOST_CIDR }}
> placeholder: e.g. 10.0.0.1XX

# Section 4 · Wrap up
> optional: true

## [info] Done
Nice work, {{ FULL_NAME }}. Leave the cable connected to port {{ PORT_NUM }} and raise your hand for a bench check. Your host was **{{ HOST_IP }}** on VLAN {{ VLAN }}.`,

  device: `---
title: Camera Provisioning — Unbox to Online
description: Unbox a camera, record its identifiers, claim it in the console, verify it streams. 45 min.
variables:
  BENCH        = 'B' + pad(seat, 2)
  DEVICE_NAME  = 'cam-' + slug(last_name) + '-' + pad(seat, 2)
  SITE         = 'Training Floor ' + ceil(seat / 10)
  CLAIM_URL    = 'https://console.example/claim'
---

# Section 1 · Identify the device

## [info] What you will do
{{ FIRST_NAME }}, you are at bench **{{ BENCH }}**. You will unbox one camera, record its serial number and MAC address, claim it under the name **{{ DEVICE_NAME }}** and confirm it comes online.

## [desk] Record the serial number
Unbox the camera. The serial is on the white label on the back, four groups separated by dots. Enter it below (dots optional).

> hint: Which label? :: The one with the QR code. The serial starts after "S/N".

> checkpoint: Enter the serial number printed on the label
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
> placeholder: e.g. ABCD.1234.WXYZ

## [desk] Record the MAC address
On the same label, below the serial, is the MAC address: six pairs separated by colons.

> checkpoint: Enter the MAC address
> pattern: XX:XX:XX:XX:XX:XX
> capture: MAC
> placeholder: e.g. A1:B2:C3:D4:E5:F6

# Section 2 · Claim and name

## [computer] Claim the camera
Open {{ CLAIM_URL }} and claim serial **{{ SERIAL }}**. When prompted:

| Field | Value |
| --- | --- |
| Name | \`{{ DEVICE_NAME }}\` |
| Site | \`{{ SITE }}\` |

The console shows the MAC it discovered. It must read **{{ MAC }}** — if it does not, you claimed the wrong unit; unclaim and retry.

> hint: Claim fails with "already claimed" :: The camera was used in a previous class. Ask the instructor to release serial {{ SERIAL }}.

> checkpoint: Type the device name exactly as you entered it in the console
> accept: {{ DEVICE_NAME }}
> placeholder: cam-…

## [computer] Confirm the identity
To prove you are looking at your own device, re-enter the serial the console shows on the device page.

> checkpoint: Serial shown on the console device page
> accept: {{ SERIAL }}
> placeholder: the serial you recorded earlier

# Section 3 · Verify

## [desk] Power and link
Connect the camera to the PoE port on bench {{ BENCH }}. Within 90 s the status LED turns solid blue.

> hint: LED stays amber :: Amber = booting or no network. Wait 2 minutes, then reseat the cable.

## [computer] Confirm it streams
In the console, open **{{ DEVICE_NAME }}** → Live. Note the firmware version shown in the Info panel and enter it (format \`v\` major.minor.patch).

> checkpoint: Firmware version shown
> pattern: v99.9.9
> capture: FIRMWARE
> placeholder: e.g. v12.3.4

# Section 4 · Wrap up
> optional: true

## [info] Record
Done. For the records: bench {{ BENCH }}, serial **{{ SERIAL }}**, MAC **{{ MAC }}**, named **{{ DEVICE_NAME }}**, firmware {{ FIRMWARE }}. Leave the camera powered; the instructor will release it after class.`,

  software: `---
title: Developer Onboarding — First Pull Request
description: Create your account, clone the repo, open a PR. Self-paced, 90 min.
variables:
  USERNAME   = slug(first_name) + '.' + slug(last_name)
  EMAIL      = USERNAME + '@lab.example'
  INITIALS   = initials(first_name + ' ' + last_name)
  BRANCH     = 'onboarding/' + slug(last_name) + '-' + pad(seat, 2)
  TICKET     = 'ONB-' + pad(seat, 4)
---

# Section 1 · Accounts

## [info] Your identity in this lab
Hi {{ FIRST_NAME }}. Everything you create today uses these values — keep this page open:

| Item | Value |
| --- | --- |
| Username | \`{{ USERNAME }}\` |
| Email | \`{{ EMAIL }}\` |
| Initials | \`{{ INITIALS }}\` |
| Branch | \`{{ BRANCH }}\` |
| Ticket | \`{{ TICKET }}\` |

## [computer] Create your account
Sign up at the lab portal with username \`{{ USERNAME }}\` and email \`{{ EMAIL }}\`. The welcome email contains a one-time code of six digits.

> hint: No email after 2 minutes :: Check the spam folder, then ask the instructor to resend for {{ EMAIL }}.

> checkpoint: Enter the six-digit code from the welcome email
> pattern: 999999
> capture: WELCOME_CODE
> placeholder: e.g. 482913

# Section 2 · The repository

## [computer] Clone and branch
\`\`\`
git clone https://git.lab.example/training/hello.git
cd hello
git checkout -b {{ BRANCH }}
\`\`\`

## [computer] Make the change
Add a file \`contributors/{{ USERNAME }}.md\` containing your initials \`{{ INITIALS }}\` and commit it with the message \`{{ TICKET }}: add {{ USERNAME }}\`.

Run \`git log --oneline -1\` and enter the short commit hash (7 hex characters).

> hint: What is a short hash? :: The first 7 characters of the commit id, e.g. \`a1b2c3d\`.

> checkpoint: Short commit hash of your commit
> pattern: xxxxxxx
> capture: COMMIT
> placeholder: e.g. a1b2c3d

# Section 3 · The pull request

## [computer] Open the PR
Push \`{{ BRANCH }}\` and open a pull request titled \`{{ TICKET }}: add {{ USERNAME }}\`. The PR page URL ends in \`/pull/<number>\`.

> checkpoint: Paste the PR URL
> pattern: *\\/pull\\/*
> capture: PR_URL
> placeholder: https://git.lab.example/training/hello/pull/42

## [computer] Confirm the commit is in the PR
Open the PR's **Commits** tab. The hash listed must be the one you recorded. Enter it again to confirm.

> checkpoint: Short hash shown in the PR's Commits tab
> accept: {{ COMMIT }}

# Section 4 · Done

## [info] Summary
{{ FULL_NAME }} ({{ USERNAME }}) opened {{ PR_URL }} from branch \`{{ BRANCH }}\` with commit \`{{ COMMIT }}\`. A reviewer will pick it up; you are done.`
};

function loadTemplatePreset(type) {
  document.getElementById('presetMenu')?.classList.add('hidden');
  const md = GUIDE_PRESETS_MARKDOWN[type];
  if (!md) return;

  const preset = parseMarkdown(md);
  if (!studioHost.allowsKind(preset.kind === 'exam' ? 'exam' : 'lab')) return;
  preset.images = studioHost.embedded ? templateData.images || [] : [];
  if (!studioHost.embedded) studioDocs.startNew();
  templateData = preset;
  resetPreviewSimulation(false);
  pushHistorySnapshot(true);
  refreshAllActiveViews();
  showToast(`Loaded Guide Example (${type})`, "success");
  scheduleAutoSave();
}

function onMetadataChanged() {
  templateData.title = document.getElementById('templateTitle').value;
  templateData.description = document.getElementById('templateDescription').value;
  updateMetadataCharCounters();
  pushHistorySnapshot();
  runFullValidation(false);
  scheduleAutoSave();
}

function updateBadges() {
  const varBadge = document.getElementById('varCountBadge');
  const imgBadge = document.getElementById('imgCountBadge');
  if (varBadge) varBadge.textContent = (templateData.variables || []).length;
  if (imgBadge) imgBadge.textContent = (templateData.images || []).length;
}

function openTokenCheatsheet(callback = null, maxSIdx = null, maxStepIdx = null) {
  tokenSelectCallback = callback;
  const modal = document.getElementById('tokenModal');
  if (!modal) return;

  const builtInList = document.getElementById('builtInTokensList');
  const declaredList = document.getElementById('declaredTokensList');
  const captureList = document.getElementById('captureTokensList');

  const builtIns = ['SEAT_ID', 'FIRST_NAME', 'LAST_NAME', 'FULL_NAME'];
  builtInList.innerHTML = builtIns.map(t => `
    <button data-on-click="handleTokenSelect('${t}')" class="p-2 rounded-lg bg-slate-50 dark:bg-surface-850 hover:bg-brand-50 dark:hover:bg-brand-950/40 border border-slate-200 dark:border-slate-700 font-mono text-left text-brand-600 dark:text-brand-400 font-semibold truncate">
      {{ ${t} }}
    </button>
  `).join('');

  const declared = (templateData.variables || []).map(v => v.name).filter(Boolean);
  declaredList.innerHTML = declared.length ? declared.map(t => `
    <button data-on-click="handleTokenSelect('${escapeHtml(t)}')" class="p-2 rounded-lg bg-slate-50 dark:bg-surface-850 hover:bg-brand-50 dark:hover:bg-brand-950/40 border border-slate-200 dark:border-slate-700 font-mono text-left text-brand-600 dark:text-brand-400 font-semibold truncate">
      {{ ${escapeHtml(t)} }}
    </button>
  `).join('') : '<span class="text-slate-400 italic col-span-2">No variables declared</span>';

  const captures = [];
  if (isExamMode()) {
    // Answers saved by short questions, usable from the following section on.
    examCaptures(templateData).forEach(c => {
      captures.push({ name: c.name, sIdx: c.si, where: c.where, isReachable: maxSIdx === null || c.si < maxSIdx });
    });
  } else templateData.content.forEach((s, sIdx) => (s.steps || []).forEach((st, stIdx) => {
    if (st.type !== 'info' && st.checkpoint && st.checkpoint.capture) {
      const isReachable = maxSIdx === null || (sIdx < maxSIdx) || (sIdx === maxSIdx && stIdx < maxStepIdx);
      captures.push({ name: st.checkpoint.capture, sIdx, stIdx, isReachable });
    }
  }));
  captureList.innerHTML = captures.length ? captures.map(c => `
    <button data-on-click="handleTokenSelect('${escapeHtml(c.name)}')" class="p-2 rounded-lg ${c.isReachable ? 'bg-emerald-50/50 dark:bg-emerald-950/20 hover:bg-emerald-100/50 border-emerald-200 dark:border-emerald-800 text-emerald-600 dark:text-emerald-400' : 'bg-slate-100 dark:bg-surface-850 border-slate-200 dark:border-slate-800 text-slate-400'} border font-mono text-left font-semibold truncate" title="${isExamMode() ? `Saved by ${c.where}${c.isReachable ? '' : ' (only available in later sections)'}` : c.isReachable ? `Captured at S${c.sIdx + 1}·St${c.stIdx + 1}` : `Captured at S${c.sIdx + 1}·St${c.stIdx + 1} (Not yet available at this step)`}">
      {{ ${escapeHtml(c.name)} }} ${!c.isReachable ? '⚠️' : ''}
    </button>
  `).join('') : `<span class="text-slate-400 italic col-span-2">${isExamMode() ? 'No short answers are saved as variables' : 'No captures defined'}</span>`;

  modal.classList.remove('hidden');
}

function closeTokenCheatsheet() {
  document.getElementById('tokenModal')?.classList.add('hidden');
  tokenSelectCallback = null;
}

function handleTokenSelect(token) {
  if (tokenSelectCallback) {
    tokenSelectCallback(token);
  } else {
    copySnippet(`{{ ${token} }}`, `Copied {{ ${token} }}`);
  }
  closeTokenCheatsheet();
}

function pickTokenForTextarea(textareaId, sIdx, stepIdx) {
  openTokenCheatsheet((token) => {
    const ta = document.getElementById(textareaId);
    if (!ta) return;
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const tokenStr = `{{ ${token} }}`;
    ta.value = val.substring(0, start) + tokenStr + val.substring(end);
    ta.focus();
    ta.setSelectionRange(start + tokenStr.length, start + tokenStr.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    autoGrowTextarea(ta);
  }, sIdx, stepIdx);
}

function openPhotoInsertPicker(sIdx, stepIdx, textareaId) {
  activeImageInsertContext = { sIdx, stepIdx, textareaId };
  const modal = document.getElementById('imagePickerModal');
  const grid = document.getElementById('imagePickerGrid');
  if (!modal || !grid) return;

  const imgs = templateData.images || [];
  if (!imgs.length) {
    showToast('No images in library. Upload images in the Image Library tab first.', 'info');
    switchView('images');
    return;
  }

  grid.innerHTML = imgs.map((img) => `
    <div data-on-click="selectImageForInsertion('${escapeHtml(img.name)}')" class="p-2 border border-slate-200 dark:border-slate-700 hover:border-brand-500 rounded-xl cursor-pointer bg-slate-50 dark:bg-surface-850 flex flex-col items-center space-y-1.5 transition">
      <div class="h-20 w-full rounded-lg overflow-hidden bg-slate-200 dark:bg-surface-900 flex items-center justify-center">
        <img src="${img.url}" alt="${escapeHtml(img.name)}" class="h-full w-full object-contain">
      </div>
      <span class="text-[11px] font-mono truncate w-full text-center text-slate-700 dark:text-slate-300">${escapeHtml(img.name)}</span>
    </div>
  `).join('');

  modal.classList.remove('hidden');
}

function closeImagePickerModal() {
  document.getElementById('imagePickerModal')?.classList.add('hidden');
  activeImageInsertContext = null;
}

function selectImageForInsertion(imgName) {
  if (!activeImageInsertContext) return;
  const ta = document.getElementById(activeImageInsertContext.textareaId);
  if (ta) {
    const start = ta.selectionStart;
    const end = ta.selectionEnd;
    const val = ta.value;
    const snippet = `![${imgName}](${imgName})\n`;
    ta.value = val.substring(0, start) + snippet + val.substring(end);
    ta.focus();
    ta.setSelectionRange(start + snippet.length, start + snippet.length);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    autoGrowTextarea(ta);
  }
  closeImagePickerModal();
}

let loadedImportRawContent = '';
let loadedImportImages = null; // null or array of { name, url }

function openImportModal() {
  const modal = document.getElementById('importModal');
  clearImportedFile();
  modal?.classList.remove('hidden');
}

function closeImportModal() {
  document.getElementById('importModal')?.classList.add('hidden');
}

function toggleRawPasteAccordion() {
  const container = document.getElementById('rawPasteContainer');
  const icon = document.getElementById('rawPasteAccordionIcon');
  if (!container || !icon) return;
  const isHidden = container.classList.toggle('hidden');
  icon.className = isHidden ? 'ph ph-caret-right text-xs' : 'ph ph-caret-down text-xs';
}

function handleImportDragOver(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('importDropZone')?.classList.add('border-brand-500', 'bg-brand-50/40', 'dark:bg-brand-950/20');
}

function handleImportDragLeave(e) {
  e.preventDefault();
  e.stopPropagation();
  document.getElementById('importDropZone')?.classList.remove('border-brand-500', 'bg-brand-50/40', 'dark:bg-brand-950/20');
}

function handleImportDrop(e) {
  e.preventDefault();
  e.stopPropagation();
  handleImportDragLeave(e);
  const files = e.dataTransfer?.files;
  if (files && files.length > 0) {
    processImportedFile(files[0]);
  }
}

function handleImportFileSelect(e) {
  const file = e.target.files?.[0];
  if (file) {
    processImportedFile(file);
  }
}

function guessImageMimeType(filename) {
  const lower = filename.toLowerCase();
  if (lower.endsWith('.png')) return 'image/png';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg';
  if (lower.endsWith('.gif')) return 'image/gif';
  if (lower.endsWith('.webp')) return 'image/webp';
  return 'image/png';
}

async function processImportedFile(file) {
  if (!file) return;
  const card = document.getElementById('importLoadedFileCard');
  const nameEl = document.getElementById('importFileName');
  const detailsEl = document.getElementById('importFileDetails');
  const statusEl = document.getElementById('importStatusText');
  const iconEl = document.getElementById('importFileIcon');
  const ta = document.getElementById('importMarkdownTextarea');
  const sizeKb = (file.size / 1024).toFixed(1);

  if (file.name.toLowerCase().endsWith('.zip')) {
    if (typeof JSZip === 'undefined') {
      showToast('JSZip is not loaded; cannot extract .zip file.', 'error');
      return;
    }
    try {
      if (statusEl) statusEl.textContent = 'Extracting .zip archive...';
      const zip = await JSZip.loadAsync(file);
      const extractedImages = [];
      const skipped = [];
      // As vLabs reads a package: the canonical template.json first (it is
      // lossless), else template.md, else any other .json / .md in it.
      const entries = Object.values(zip.files).filter(e => !e.dir);
      const named = (re) => entries.find(e => re.test(e.name.split('/').pop() || ''));
      const textEntry = named(/^template\.json$/i) || named(/^template\.md$/i)
        || named(/^[^.].*\.json$/i) || named(/^[^.].*\.(md|markdown|txt)$/i);
      const mdText = textEntry ? await textEntry.async('string') : '';
      for (const entry of entries) {
        const baseName = entry.name.split('/').pop();
        if (!baseName || baseName.startsWith('.')) continue;
        // vLabs takes PNG, JPEG, GIF and WebP only (no SVG).
        if (/\.svg$/i.test(baseName)) skipped.push(baseName);
        else if (/\.(png|jpe?g|gif|webp)$/i.test(baseName)) {
          const b64 = await entry.async('base64');
          const mime = guessImageMimeType(baseName);
          extractedImages.push({
            name: normaliseImageName(baseName),
            url: `data:${mime};base64,${b64}`
          });
        }
      }

      if (!mdText) {
        showToast('No template.md or .json file found inside the .zip package.', 'error');
        return;
      }
      if (skipped.length) {
        showToast(`Left out ${skipped.join(', ')}: vLabs takes PNG, JPEG, GIF and WebP images, not SVG.`, 'error');
      }

      loadedImportRawContent = mdText;
      loadedImportImages = extractedImages;
      if (ta) ta.value = loadedImportRawContent;
      if (nameEl) nameEl.textContent = file.name;
      if (iconEl) iconEl.className = 'ph-bold ph-file-zip text-base';

      const inspected = parseMarkdown(loadedImportRawContent);
      const secCount = inspected.content ? inspected.content.length : 0;
      let stepCount = 0;
      (inspected.content || []).forEach(s => stepCount += (s.items || s.steps || []).length);

      if (detailsEl) {
        detailsEl.textContent = `${sizeKb} KB · "${inspected.title || 'Untitled'}" (${secCount} sections, ${stepCount} steps, ${extractedImages.length} image asset(s))`;
      }
      if (statusEl) {
        statusEl.textContent = `Ready: ${secCount} sections, ${stepCount} steps, ${extractedImages.length} image(s) extracted`;
      }
      card?.classList.remove('hidden');
      document.getElementById('executeImportBtn')?.removeAttribute('disabled');
    } catch (err) {
      showToast(`Failed to read .zip archive: ${err.message}`, 'error');
    }
    return;
  }

  // Standard .md, .markdown, .txt, or .json file
  const reader = new FileReader();
  reader.onload = (evt) => {
    const text = evt.target?.result || '';
    loadedImportRawContent = String(text);
    loadedImportImages = null;

    if (ta) ta.value = loadedImportRawContent;
    if (nameEl) nameEl.textContent = file.name;
    if (iconEl) iconEl.className = file.name.toLowerCase().endsWith('.json') ? 'ph-bold ph-brackets-curly text-base' : 'ph-bold ph-file-text text-base';

    try {
      const inspected = parseMarkdown(loadedImportRawContent);
      const secCount = inspected.content ? inspected.content.length : 0;
      let stepCount = 0;
      (inspected.content || []).forEach(s => stepCount += (s.items || s.steps || []).length);
      if (detailsEl) detailsEl.textContent = `${sizeKb} KB · "${inspected.title || 'Untitled'}" (${secCount} sections, ${stepCount} steps)`;
      if (statusEl) statusEl.textContent = `Ready: ${secCount} sections, ${stepCount} steps detected`;
    } catch (_) {
      if (detailsEl) detailsEl.textContent = `${sizeKb} KB · Ready to import`;
      if (statusEl) statusEl.textContent = `File ready for import.`;
    }

    card?.classList.remove('hidden');
    document.getElementById('executeImportBtn')?.removeAttribute('disabled');
  };
  reader.readAsText(file);
}

function clearImportedFile() {
  loadedImportRawContent = '';
  loadedImportImages = null;
  const card = document.getElementById('importLoadedFileCard');
  const fileInput = document.getElementById('importFileInput');
  const ta = document.getElementById('importMarkdownTextarea');
  const statusEl = document.getElementById('importStatusText');

  if (card) card.classList.add('hidden');
  if (fileInput) fileInput.value = '';
  if (ta) ta.value = '';
  if (statusEl) statusEl.textContent = 'Select or drop a file to begin.';
}

function onImportTextareaInput() {
  const ta = document.getElementById('importMarkdownTextarea');
  loadedImportRawContent = ta?.value || '';
  loadedImportImages = null;
  const statusEl = document.getElementById('importStatusText');
  if (loadedImportRawContent.trim()) {
    if (statusEl) statusEl.textContent = 'Raw template content entered.';
  } else {
    if (statusEl) statusEl.textContent = 'Select or drop a file to begin.';
  }
}

function executeImport() {
  const text = loadedImportRawContent || document.getElementById('importMarkdownTextarea')?.value || '';
  if (!text.trim()) {
    showToast('Please drop a file (.md, .zip, .json) or paste content.', 'error');
    return;
  }
  try {
    const parsed = parseMarkdown(text);
    if (!studioHost.allowsKind(parsed.kind === 'exam' ? 'exam' : 'lab')) return;
    if (studioHost.embedded) {
      // The package's images go to vLabs' library; the app uploads them.
      parsed.images = templateData.images || [];
      if (Array.isArray(loadedImportImages) && loadedImportImages.length > 0) {
        studioHost.uploadDataUrlImages(loadedImportImages);
      }
    } else {
      // Offline, an import is a new document with the package's own images.
      parsed.images = Array.isArray(loadedImportImages) ? loadedImportImages : [];
      studioDocs.startNew();
    }
    templateData = parsed;
    resetPreviewSimulation(false);
    pushHistorySnapshot(true);
    closeImportModal();
    refreshAllActiveViews();
    const imgMsg = Array.isArray(loadedImportImages) && loadedImportImages.length > 0
      ? ` (+${loadedImportImages.length} image asset(s))`
      : '';
    showToast(`Template imported successfully${imgMsg}`, 'success');
    scheduleAutoSave();
  } catch (err) {
    showToast(`Failed to parse template: ${err.message}`, 'error');
  }
}

function togglePresetMenu() {
  const menu = document.getElementById('presetMenu');
  if (menu) menu.classList.toggle('hidden');
}

function toggleExportMenu() {
  const menu = document.getElementById('exportMenu');
  if (menu) menu.classList.toggle('hidden');
}

function showToast(message, type = 'info') {
  let toastBox = document.getElementById('toastContainer');
  if (!toastBox) {
    toastBox = document.createElement('div');
    toastBox.id = 'toastContainer';
    toastBox.className = 'fixed bottom-5 right-5 z-[100] flex flex-col space-y-2 pointer-events-none';
    document.body.appendChild(toastBox);
  }
  const toast = document.createElement('div');
  const bg = type === 'error' ? 'bg-rose-600 text-white' : type === 'success' ? 'bg-emerald-600 text-white' : 'bg-slate-800 text-slate-100 dark:bg-slate-700';
  toast.className = `${bg} px-4 py-2.5 rounded-xl shadow-lg text-xs font-semibold flex items-center space-x-2 transition-all duration-300 transform translate-y-2 opacity-0 pointer-events-auto`;
  toast.innerHTML = `<span>${escapeHtml(message)}</span>`;
  toastBox.appendChild(toast);
  requestAnimationFrame(() => {
    toast.classList.remove('translate-y-2', 'opacity-0');
  });
  setTimeout(() => {
    toast.classList.add('opacity-0', 'translate-y-2');
    setTimeout(() => toast.remove(), 350);
  }, 3000);
}

function escapeHtml(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function copySnippet(text, toastMsg = 'Copied to clipboard') {
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => {
        showToast(toastMsg, 'success');
      }).catch(() => fallbackCopy(text, toastMsg));
    } else {
      fallbackCopy(text, toastMsg);
    }
  } catch (_) {
    fallbackCopy(text, toastMsg);
  }
}

function fallbackCopy(text, toastMsg) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  try {
    document.execCommand('copy');
    showToast(toastMsg, 'success');
  } catch (e) {
    showToast('Unable to copy to clipboard', 'error');
  }
  document.body.removeChild(ta);
}

function scheduleAutoSave(immediate = false) {
  // Inside vLabs the app saves (to the server, with versions); tell it.
  if (studioHost.embedded) {
    studioHost.notifyChange();
    return;
  }
  // Offline, the open document is kept in the browser (documents.js).
  clearTimeout(autoSaveTimer);
  const saveFn = () => studioDocs.save(templateData);

  if (immediate) saveFn();
  else autoSaveTimer = setTimeout(saveFn, 500);
}

// Global click listener to close dropdown menus
window.addEventListener('click', (e) => {
  if (!e.target.closest('#presetDropdownContainer')) document.getElementById('presetMenu')?.classList.add('hidden');
  if (!e.target.closest('#exportDropdownContainer')) document.getElementById('exportMenu')?.classList.add('hidden');
  if (!e.target.closest('#newDropdownContainer')) document.getElementById('newMenu')?.classList.add('hidden');
  if (!e.target.closest('#docsDropdownContainer')) studioDocs.closeMenu();
});

// Global keyboard shortcuts (Escape + Undo/Redo when not inside native text inputs, or global Ctrl+Z/Y)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    closeImportModal();
    closeTokenCheatsheet();
    closeImagePickerModal();
    closeConfirmModal();
    return;
  }

  const isMod = e.ctrlKey || e.metaKey;
  if (isMod && e.key.toLowerCase() === 's') {
    e.preventDefault();
    if (studioHost.embedded) studioHost.requestSave();
    else studioDocs.saveToFile();
    return;
  }
  if (isMod && e.key.toLowerCase() === 'z') {
    if (e.shiftKey) {
      e.preventDefault();
      performRedo();
    } else {
      e.preventDefault();
      performUndo();
    }
  } else if (isMod && e.key.toLowerCase() === 'y') {
    e.preventDefault();
    performRedo();
  }
});

// App Startup Routine
window.addEventListener('load', async () => {
  loadAppSettings();
  initTheme();

  if (studioHost.embedded) {
    studioHost.start();
    return;
  }

  const saved = await studioDocs.init();
  if (saved && Array.isArray(saved.content)) {
    templateData = saved;
  } else {
    // Default to the Network Bench Lab example so new authors can immediately explore all features
    templateData = parseMarkdown(GUIDE_PRESETS_MARKDOWN.network);
  }

  pushHistorySnapshot(true);
  renderBuilder();
  renderVariablesList();
  renderImagesGrid();
  runFullValidation(false);
  autoGrowAllTextareas();
});
