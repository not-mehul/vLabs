function isExamMode() {
  return templateData && templateData.kind === 'exam';
}

function createBlankExam() {
  return {
    kind: 'exam',
    title: 'Untitled Exam',
    description: '',
    variables: [],
    content: [
      {
        title: 'Section 1',
        minutes: null,
        collapsed: false,
        items: [{ ...examBlankQuestion('single'), prompt: 'Which option is correct?', options: ['Option A', 'Option B'], collapsed: false }]
      },
      { ...examDefaultSubmitSection(), collapsed: false }
    ],
    images: []
  };
}

/** A canonical vLabs exam → the Studio's working copy (UI flags, images kept). */
function studioExamFromCanonical(exam) {
  const e = examNormalise(exam);
  return {
    kind: 'exam',
    title: e.title,
    description: e.description,
    variables: e.variables,
    content: e.content.map(sec => examIsSubmit(sec)
      ? { ...sec, collapsed: false }
      : { ...sec, collapsed: false, items: sec.items.map(it => ({ ...it, collapsed: false })) }),
    images: (templateData && templateData.images) || []
  };
}

function promptNewBlankExam() {
  document.getElementById('presetMenu')?.classList.add('hidden');
  document.getElementById('newMenu')?.classList.add('hidden');
  openConfirmModal({
    title: 'Start New Blank Exam?',
    message: studioHost.embedded
      ? 'This will replace the template with a fresh blank exam. You can still use Undo (Ctrl+Z) right after if needed.'
      : 'This starts a new blank exam. The one you have open stays under Documents.',
    confirmText: 'Create Blank Exam',
    onConfirm: () => {
      if (!studioHost.allowsKind('exam')) return;
      if (!studioHost.embedded) studioDocs.startNew();
      templateData = { ...createBlankExam(), images: studioHost.embedded ? templateData.images || [] : [] };
      resetPreviewSimulation(false);
      pushHistorySnapshot(true);
      refreshAllActiveViews();
      scheduleAutoSave();
      showToast('Started a new blank exam', 'success');
    }
  });
}

function toggleNewMenu() {
  document.getElementById('newMenu')?.classList.toggle('hidden');
}

/** Show / hide the lab-only parts of the chrome for the current kind. */
function applyKindChrome() {
  const exam = isExamMode();
  // Exams saved by the Studio before they had variables.
  if (exam && !Array.isArray(templateData.variables)) templateData.variables = [];
  // Exams have variables, saved answers, the variable map, per-item
  // previews and gating (a section opens once the one before is answered).
  const depsHead = document.getElementById('dependencyCapturesHint');
  if (depsHead) depsHead.textContent = exam ? 'saved answers' : 'checkpoint captures';
  const capturesHead = document.getElementById('captureTokensHead');
  if (capturesHead) capturesHead.textContent = exam ? 'Saved Answers (later sections only)' : 'Captured Checkpoint Values';
  const label = document.getElementById('specKindLabel');
  if (label) label.textContent = exam ? 'Exam Specification' : 'Lab Specification';
  const badge = document.getElementById('kindBadge');
  if (badge) {
    badge.textContent = exam ? 'Exam' : 'Lab';
    badge.className = exam
      ? 'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300'
      : 'text-[10px] font-semibold uppercase tracking-wider px-1.5 py-0.5 rounded bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300';
  }
  const addLabel = document.getElementById('addSectionLabel');
  if (addLabel) addLabel.textContent = exam ? 'Add Section' : 'Add Section';
  const search = document.getElementById('globalStepSearch');
  if (search) search.placeholder = exam ? 'Filter questions and steps...' : 'Filter steps, tokens...';
  const outlineFilter = document.getElementById('outlineQuickFilter');
  if (outlineFilter) outlineFilter.placeholder = exam ? 'Jump to question or step...' : 'Jump to step...';
  const title = document.getElementById('templateTitle');
  if (title) title.placeholder = exam ? 'e.g. Network Fundamentals — Unit Test' : 'e.g. Switch & Host Addressing — Bench Lab';
}

const EXAM_TYPE_DOT = {
  info: 'bg-slate-400', checklist: 'bg-amber-500',
  single: 'bg-violet-500', multiple: 'bg-fuchsia-500', truefalse: 'bg-sky-500', short: 'bg-emerald-500', long: 'bg-rose-400'
};
const EXAM_INPUT_CLS = 'w-full text-xs text-slate-800 dark:text-slate-200 bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 focus:outline-none focus:border-brand-500';
const examLetter = (i) => String.fromCharCode(65 + i);
const examGradingBadge = (q) => examIsManual(q)
  ? '<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">marked by hand</span>'
  : '<span class="text-[10px] font-medium px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">auto-graded</span>';
function examAcceptedNote(q) {
  if (q.match === 'pattern') {
    const example = examMaskExample(q.pattern || '');
    return example
      ? `Graded automatically: any answer that fits, e.g. ${example}. Punctuation may be left out.`
      : 'Write a pattern: 9 a digit, A a letter, X a letter or digit; other letters and digits must match as written.';
  }
  return q.accepted.length
    ? 'Graded automatically; case and spacing are ignored.'
    : 'No accepted answers: marked by hand in the session monitor.';
}
const examAcceptedText = (q) => (q.accepted || []).map(a => a.replace(/\|/g, '\\|')).join(' | ');
const examQuestions = () => templateData.content.flatMap(s => (s.items || []).filter(examIsQuestion));
const examTotalPoints = () => examQuestions().reduce((n, q) => n + (Number(q.points) || 0), 0);
const examQuestionCount = () => examQuestions().length;

/** "Step 2" / "Q3": steps and questions are numbered separately in each
    section, as in vLabs' messages ("Section 1 · question 3"). */
function examItemLabels(items) {
  let steps = 0;
  let questions = 0;
  return (items || []).map(it => (examIsQuestion(it) ? `Q${(questions += 1)}` : `Step ${(steps += 1)}`));
}

function examSectionHeaderHtml(section, sIdx) {
  const isCollapsed = Boolean(section.collapsed);
  const submit = examIsSubmit(section);
  const items = section.items || [];
  const nq = items.filter(examIsQuestion).length;
  const ns = items.length - nq;
  const last = templateData.content.length - 1;
  const btn = (action, icon, title, disabled, danger) => `
    <button data-action="${action}" data-sec-idx="${sIdx}" ${disabled ? 'disabled' : ''} class="p-1 text-slate-400 ${danger ? 'hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30' : 'hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.06]'} rounded-md transition disabled:opacity-30" title="${title}"><i class="ph ${icon} text-xs"></i></button>`;
  const count = submit
    ? 'last step'
    : [nq ? `${nq} ${nq === 1 ? 'question' : 'questions'}` : '', ns ? `${ns} ${ns === 1 ? 'step' : 'steps'}` : ''].filter(Boolean).join(' · ') || 'empty';
  return `
    <div class="px-4 py-3 border-b border-slate-100 dark:border-white/[0.06] flex items-center justify-between bg-slate-50/50 dark:bg-surface-850/40">
      <div class="flex items-center space-x-2.5 flex-1 mr-3">
        <button data-action="toggle-section" data-sec-idx="${sIdx}" class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 text-xs p-1 rounded-md hover:bg-slate-200/50 dark:hover:bg-white/[0.06] transition" title="Toggle Section">
          <i class="ph ${isCollapsed ? 'ph-caret-right' : 'ph-caret-down'}"></i>
        </button>
        <span class="text-[11px] font-mono font-medium px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-white/[0.07] text-slate-600 dark:text-slate-300">${submit ? '<i class="ph ph-flag"></i>' : String(sIdx + 1).padStart(2, '0')}</span>
        <input type="text" value="${escapeHtml(section.title || '')}" placeholder="${submit ? 'Review and submit' : 'Section title...'}"
          class="text-sm font-semibold tracking-tight text-slate-900 dark:text-white bg-transparent border-b border-transparent hover:border-slate-300 dark:hover:border-slate-700 focus:border-brand-500 focus:outline-none px-1 py-0.5 w-full transition"
          data-action="update-sec-title" data-sec-idx="${sIdx}">
        ${submit ? '<span class="shrink-0 text-[10px] font-medium px-1.5 py-0.5 rounded bg-violet-100 text-violet-700 dark:bg-violet-500/15 dark:text-violet-300">Submit</span>' : sectionTimeInputsHtml(section, sIdx, 'section')}
      </div>
      <div class="flex items-center space-x-1 shrink-0">
        <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500 mr-1.5 hidden sm:inline">${count}</span>
        ${submit ? '' : [
          btn('move-sec-up', 'ph-arrow-up', 'Move Section Up', sIdx === 0),
          btn('move-sec-down', 'ph-arrow-down', 'Move Section Down', sIdx >= last - 1),
          btn('duplicate-section', 'ph-copy', 'Duplicate Section', false),
          btn('delete-section', 'ph-trash', 'Delete Section', last <= 1, true)
        ].join('')}
      </div>
    </div>`;
}

/** Options / correct answer / accepted answers or pattern of a question. */
function examAnswerEditorHtml(q, sIdx, ii) {
  const at = `data-sec-idx="${sIdx}" data-item-idx="${ii}"`;
  if (q.type === 'single' || q.type === 'multiple') {
    const multi = q.type === 'multiple';
    return `
      <div class="space-y-1.5">
        <span class="block text-[10px] font-medium text-slate-400">Options — mark ${multi ? 'every correct one (all must be chosen to score)' : 'the correct one'}</span>
        ${q.options.map((o, oi) => {
          const on = multi ? q.correct.includes(oi) : q.correct === oi;
          return `
            <div class="flex items-center gap-2">
              <input type="${multi ? 'checkbox' : 'radio'}" name="q-correct-${sIdx}-${ii}" ${on ? 'checked' : ''} ${at} data-opt-idx="${oi}" data-action="exam-q-correct"
                class="shrink-0 text-emerald-600 focus:ring-0" title="Correct answer" aria-label="Option ${examLetter(oi)} is correct">
              <span class="text-[11px] font-mono font-semibold w-4 text-slate-400">${examLetter(oi)}</span>
              <input type="text" value="${escapeHtml(o)}" placeholder="Option ${examLetter(oi)}" ${at} data-opt-idx="${oi}" data-action="exam-q-option"
                class="${EXAM_INPUT_CLS} ${on ? '!border-emerald-400 dark:!border-emerald-500/60 bg-emerald-50/40 dark:bg-emerald-500/[0.06]' : ''}">
              <button data-action="exam-q-del-option" ${at} data-opt-idx="${oi}" class="p-1 text-slate-400 hover:text-rose-600 rounded disabled:opacity-30" ${q.options.length <= 2 ? 'disabled' : ''} title="Remove option">
                <i class="ph ph-x text-xs pointer-events-none"></i>
              </button>
            </div>`;
        }).join('')}
        ${q.options.length < EXAM_LIMITS.options ? `
          <button data-action="exam-q-add-option" ${at} class="text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition">+ Add option</button>` : ''}
      </div>`;
  }
  if (q.type === 'truefalse') {
    return `
      <div class="flex items-center gap-4 text-xs text-slate-700 dark:text-slate-200">
        <span class="text-[10px] font-medium text-slate-400">Correct answer</span>
        <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="q-tf-${sIdx}-${ii}" value="true" ${q.correct === true ? 'checked' : ''} ${at} data-action="exam-q-tf"> True</label>
        <label class="inline-flex items-center gap-1.5 cursor-pointer"><input type="radio" name="q-tf-${sIdx}-${ii}" value="false" ${q.correct === false ? 'checked' : ''} ${at} data-action="exam-q-tf"> False</label>
      </div>`;
  }
  if (q.type === 'short') {
    const pattern = q.match === 'pattern';
    return `
      <div class="space-y-2">
        <div class="flex flex-wrap items-center gap-2">
          <label class="text-[10px] font-medium text-slate-400">Check the answer by</label>
          <select data-action="exam-q-match" ${at} class="text-[11px] font-medium px-2 py-1 rounded-md border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-surface-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer">
            <option value="exact" ${pattern ? '' : 'selected'}>Exact answers</option>
            <option value="pattern" ${pattern ? 'selected' : ''}>Pattern (format only)</option>
          </select>
        </div>
        ${pattern ? `
          <div>
            <label class="block text-[10px] font-medium text-slate-400 mb-1">Pattern, as in a lab checkpoint: <code class="font-mono">9</code> a digit, <code class="font-mono">A</code> a letter, <code class="font-mono">X</code> a letter or digit</label>
            <input type="text" value="${escapeHtml(q.pattern || '')}" placeholder="e.g. XXXX.XXXX.XXXX" maxlength="${EXAM_LIMITS.pattern}" ${at} data-action="exam-q-pattern" class="${EXAM_INPUT_CLS} font-mono sm:w-80" spellcheck="false">
          </div>` : `
          <div>
            <label class="block text-[10px] font-medium text-slate-400 mb-1">Accepted answers (separate with <code class="font-mono">|</code>, write <code class="font-mono">\\|</code> for a literal pipe)</label>
            <input type="text" value="${escapeHtml(examAcceptedText(q))}" placeholder="e.g. 443 | tcp/443" ${at} data-action="exam-q-accepted" class="${EXAM_INPUT_CLS} font-mono">
          </div>`}
        <p id="q-accepted-note-${sIdx}-${ii}" class="text-[10px] text-slate-400">${escapeHtml(examAcceptedNote(q))}</p>
        <div class="grid sm:grid-cols-2 gap-2">
          <div>
            <label class="block text-[10px] font-medium text-slate-400 mb-1">Answer box placeholder (optional)</label>
            <input type="text" value="${escapeHtml(q.placeholder || '')}" placeholder="Type your answer" maxlength="${EXAM_LIMITS.placeholder}" ${at} data-action="exam-q-placeholder" class="${EXAM_INPUT_CLS}">
          </div>
          <div>
            <label class="block text-[10px] font-medium text-slate-400 mb-1">Save the answer as <code class="font-mono">{{ NAME }}</code> for later sections (optional)</label>
            <input type="text" value="${escapeHtml(q.capture || '')}" placeholder="e.g. ROUTER_IP" maxlength="${EXAM_LIMITS.captureName}" ${at} data-action="exam-q-capture" class="${EXAM_INPUT_CLS} font-mono">
          </div>
        </div>
      </div>`;
  }
  return `<p class="text-[11px] text-slate-400"><i class="ph ph-pencil-simple-line"></i> Long answers are always marked by hand in the session monitor.</p>`;
}

/** Instructions and, for a Checklist, the boxes the participant ticks. */
function examStepEditorHtml(it, sIdx, ii) {
  const at = `data-sec-idx="${sIdx}" data-item-idx="${ii}"`;
  const bodyId = `exam-item-body-${sIdx}-${ii}`;
  const tasks = it.tasks || [];
  const checklist = it.type === 'checklist';
  return `
    <input type="text" value="${escapeHtml(it.title || '')}" placeholder="Title (optional)" maxlength="${EXAM_LIMITS.itemTitle}" ${at} data-action="exam-item-title" class="${EXAM_INPUT_CLS}">
    <div class="rounded-lg border border-slate-200/90 dark:border-white/[0.08] overflow-hidden bg-slate-50/40 dark:bg-surface-900 focus-within:border-brand-500 dark:focus-within:border-brand-500 transition">
      ${renderMarkdownToolbar(bodyId, sIdx, ii)}
      <textarea id="${bodyId}" rows="3" ${at} data-action="exam-item-body"
        class="autogrow-textarea w-full text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-100 bg-transparent p-3 focus:outline-none placeholder:text-slate-400 min-h-[3.5rem] block"
        placeholder="${checklist ? 'Instructions (optional), e.g. Cable the switch to the router, then call your instructor over.' : 'Instructions (Markdown; images by library file name)'}">${escapeHtml(it.body || '')}</textarea>
    </div>
    ${checklist ? `
      <div class="space-y-1.5">
        <span class="block text-[10px] font-medium text-slate-400">Checklist: the participant ticks every item to move on (nobody approves it)</span>
        ${tasks.map((t, ti) => `
          <div class="flex items-center gap-2">
            <i class="ph ph-check-square text-sm text-amber-500 shrink-0"></i>
            <input type="text" value="${escapeHtml(t)}" placeholder="e.g. My instructor has checked my cabling" ${at} data-task-idx="${ti}" data-action="exam-task" class="${EXAM_INPUT_CLS}">
            <button data-action="exam-del-task" ${at} data-task-idx="${ti}" class="p-1 text-slate-400 hover:text-rose-600 rounded" title="Remove item"><i class="ph ph-x text-xs pointer-events-none"></i></button>
          </div>`).join('')}
        ${tasks.length < EXAM_LIMITS.tasks ? `<button data-action="exam-add-task" ${at} class="text-[11px] font-medium text-slate-600 dark:text-slate-300 hover:text-brand-600 dark:hover:text-brand-400 transition">+ Add checklist item</button>` : ''}
      </div>` : ''}`;
}

/** One item of a section: an Informational or Checklist step, or a question. */
function examItemCardHtml(it, sIdx, ii, label, count) {
  const collapsed = Boolean(it.collapsed);
  const question = examIsQuestion(it);
  const at = `data-sec-idx="${sIdx}" data-item-idx="${ii}"`;
  const promptId = `q-prompt-${sIdx}-${ii}`;
  const summary = question ? it.prompt : (it.title || it.body);
  const tool = (action, icon, title, disabled, danger) => `<button data-action="${action}" ${at} ${disabled ? 'disabled' : ''} class="p-1 text-slate-400 ${danger ? 'hover:text-rose-600 hover:bg-rose-50 dark:hover:bg-rose-950/30' : 'hover:text-slate-700 dark:hover:text-slate-200 hover:bg-slate-100 dark:hover:bg-white/[0.05]'} rounded disabled:opacity-30" title="${title}"><i class="ph ${icon} text-xs pointer-events-none"></i></button>`;
  return `
    <div id="q-card-${sIdx}-${ii}" class="bg-white dark:bg-surface-850/90 border ${question ? 'border-slate-200/80 dark:border-white/[0.07]' : 'border-l-4 border-l-amber-400/80 border-slate-200/80 dark:border-white/[0.07]'} rounded-xl p-4 space-y-3 transition-all">
      <div class="flex flex-wrap items-center justify-between gap-2">
        <div class="flex items-center gap-2 flex-1 min-w-[220px]">
          <button data-action="exam-toggle-item" ${at} class="text-slate-400 hover:text-slate-700 dark:hover:text-slate-200 p-1 rounded hover:bg-slate-100 dark:hover:bg-white/[0.05]">
            <i class="ph ${collapsed ? 'ph-caret-right' : 'ph-caret-down'} text-xs pointer-events-none"></i>
          </button>
          <span class="text-[11px] font-mono font-semibold ${question ? 'text-brand-600 dark:text-brand-400' : 'text-amber-600 dark:text-amber-400'}">${label}</span>
          <div class="relative flex items-center">
            <span class="w-1.5 h-1.5 rounded-full ${EXAM_TYPE_DOT[it.type]} absolute left-2.5 pointer-events-none"></span>
            <select data-action="exam-item-type" ${at} aria-label="Type"
              class="text-[11px] font-medium pl-5 pr-2 py-1 rounded-md border border-slate-200/80 dark:border-white/[0.08] bg-slate-50 dark:bg-surface-900 text-slate-700 dark:text-slate-200 focus:outline-none focus:border-brand-500 cursor-pointer">
              ${EXAM_ITEM_TYPE_NAMES.map(t => `<option value="${t}" ${it.type === t ? 'selected' : ''}>${EXAM_ITEM_TYPES[t]} [${t}]</option>`).join('')}
            </select>
          </div>
          ${question ? `
            <label class="inline-flex items-center gap-1 text-[11px] text-slate-400">
              <input type="number" min="0" max="100" step="0.5" value="${escapeHtml(String(it.points))}" ${at} data-action="exam-q-points"
                class="w-14 text-xs font-mono text-slate-800 dark:text-slate-200 bg-slate-50 dark:bg-surface-900 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-1.5 py-1 focus:outline-none focus:border-brand-500" aria-label="Points">
              pts
            </label>
            <span id="q-grading-${sIdx}-${ii}">${examGradingBadge(it)}</span>` : ''}
          ${collapsed ? `<span class="text-[11px] text-slate-500 truncate max-w-[16rem]">${escapeHtml(String(summary || '').replace(/\s+/g, ' ').slice(0, 80))}</span>` : ''}
        </div>
        <div class="flex items-center space-x-1 shrink-0">
          <button data-action="exam-toggle-preview" ${at} class="px-2 py-1 rounded-md text-[11px] font-medium flex items-center gap-1 transition ${it.previewOpen ? 'bg-brand-50 dark:bg-brand-500/15 text-brand-600 dark:text-brand-300 border border-brand-200/60 dark:border-brand-500/30' : 'text-slate-500 dark:text-slate-400 hover:bg-slate-100 dark:hover:bg-white/[0.05]'}" title="Toggle Live Preview (Seat 1)">
            <i class="ph ph-columns text-xs pointer-events-none"></i><span class="pointer-events-none">Preview</span>
          </button>
          ${tool('exam-move-item-up', 'ph-arrow-up', 'Move Up', ii === 0)}
          ${tool('exam-move-item-down', 'ph-arrow-down', 'Move Down', ii === count - 1)}
          ${tool('exam-dup-item', 'ph-copy', 'Duplicate', count >= EXAM_LIMITS.itemsPerSection)}
          ${tool('exam-del-item', 'ph-trash', 'Delete', count <= 1, true)}
        </div>
      </div>
      <div class="${collapsed ? 'hidden' : 'space-y-3'}">
        ${question ? `
          <div class="rounded-lg border border-slate-200/90 dark:border-white/[0.08] overflow-hidden bg-slate-50/40 dark:bg-surface-900 focus-within:border-brand-500 dark:focus-within:border-brand-500 transition">
            ${renderMarkdownToolbar(promptId, sIdx, ii)}
            <textarea id="${promptId}" rows="2" ${at} data-action="exam-q-prompt"
              class="autogrow-textarea w-full text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-100 bg-transparent p-3 focus:outline-none placeholder:text-slate-400 min-h-[3.5rem] block"
              placeholder="Question prompt (Markdown; images by library file name)">${escapeHtml(it.prompt || '')}</textarea>
          </div>
          ${examAnswerEditorHtml(it, sIdx, ii)}` : examStepEditorHtml(it, sIdx, ii)}
        ${it.previewOpen ? examItemPreviewHtml(it, sIdx, ii, label) : ''}
      </div>
    </div>`;
}

/** The variable map's view of an exam: each saved answer into `captures`,
    then every {{ token }} in reading order to `record(token, ref)`. */
function examAnalyzeUsages(captures, record) {
  templateData.content.forEach((sec, sIdx) => {
    const labels = examItemLabels(sec.items || []);
    (sec.items || []).forEach((it, ii) => {
      const name = examIsQuestion(it) ? String(it.capture || '').trim() : '';
      if (name && !captures.has(name)) {
        captures.set(name, { name, sIdx, stIdx: ii, label: `S${sIdx + 1}·${labels[ii]}`, usedInSteps: [], outOfOrderRefs: [] });
      }
    });
  });
  templateData.content.forEach((sec, sIdx) => {
    const scan = (text, stIdx, label, fieldLabel) =>
      extractPlaceholdersFromText(text).forEach(t => record(t, { sIdx, stIdx, label, fieldLabel }));
    scan(sec.title, null, `S${sIdx + 1}`, 'Section Title');
    if (examIsSubmit(sec)) scan(sec.body, null, `S${sIdx + 1}`, 'Submit Text');
    const labels = examItemLabels(sec.items || []);
    (sec.items || []).forEach((it, ii) => {
      const label = `S${sIdx + 1}·${labels[ii]}`;
      if (examIsQuestion(it)) {
        scan(it.prompt, ii, label, 'Prompt');
        (it.options || []).forEach((o, oi) => scan(o, ii, label, `Option ${examLetter(oi)}`));
        (it.accepted || []).forEach(a => scan(a, ii, label, 'Accepted Answer'));
      } else {
        scan(it.title, ii, label, 'Step Title');
        scan(it.body, ii, label, 'Step Body');
        (it.tasks || []).forEach((t, ti) => scan(t, ii, label, `Checklist Item ${ti + 1}`));
      }
    });
  });
}

/** Seat 1's placeholder values, with a stand-in for each saved answer. */
function examSampleContext() {
  const saved = {};
  examCaptures(examNormalise(templateData)).forEach(c => {
    if (!(c.name in saved)) saved[c.name] = `[answer to ${c.where}]`;
  });
  return buildEvaluatedContext(1, 'Mary-Jane', "O'Neil", saved);
}

/** One item as seat 1 sees it, under its editor (labs' step preview). */
function examItemPreviewHtml(it, sIdx, ii, label) {
  const ctx = examSampleContext();
  const md = (text) => parseMarkdownSafe(resolveMarkdownImages(text || '', ctx));
  let inner;
  if (examIsQuestion(it)) {
    const choices = EXAM_HAS_OPTIONS(it.type)
      ? (it.options || []).map((o, oi) => `<div class="flex items-start gap-2"><span class="font-mono text-[11px] text-slate-400">${examLetter(oi)}</span><div>${md(o)}</div></div>`).join('')
      : it.type === 'truefalse' ? '<p class="text-slate-500">True / False</p>' : '';
    inner = `${md(it.prompt)}${choices ? `<div class="mt-2 space-y-1">${choices}</div>` : ''}`;
  } else {
    const title = (it.title || '').trim();
    inner = `${title ? `<p class="font-semibold">${escapeHtml(substitutePlaceholders(title, ctx))}</p>` : ''}${md(it.body)}${(it.tasks || []).filter(t => t.trim()).map(t => `<div class="flex items-start gap-2"><i class="ph ph-square text-slate-400 mt-0.5"></i><div>${md(t)}</div></div>`).join('')}`;
  }
  return `
    <div id="q-inline-preview-${sIdx}-${ii}" data-label="${escapeHtml(label)}" class="bg-slate-50/70 dark:bg-surface-900/70 border border-slate-200/80 dark:border-white/[0.07] rounded-lg p-3.5 space-y-2">
      <div class="flex items-center justify-between border-b border-slate-200/60 dark:border-white/[0.06] pb-1.5">
        <span class="text-[10px] font-medium uppercase tracking-wider text-slate-400 dark:text-slate-500">Seat 1 Preview</span>
        <span class="text-[10px] font-mono text-slate-400">${escapeHtml(label)}</span>
      </div>
      <div class="prose-preview text-xs text-slate-700 dark:text-slate-200">${inner}</div>
    </div>`;
}

/** Re-render an open item preview in place as the author types. */
function examRefreshItemPreview(it, sIdx, ii) {
  const el = document.getElementById(`q-inline-preview-${sIdx}-${ii}`);
  if (el) el.outerHTML = examItemPreviewHtml(it, sIdx, ii, el.dataset.label || '');
}

/** Text above the button, and the review switch, of the submit section. */
function examSubmitBodyHtml(section, sIdx) {
  const bodyId = `sec-body-${sIdx}`;
  return `
    <div>
      <label class="block text-[10px] font-medium text-slate-400 mb-1">Text above the submit button (Markdown, optional)</label>
      <div class="rounded-lg border border-slate-200/90 dark:border-white/[0.08] overflow-hidden bg-slate-50/40 dark:bg-surface-900 focus-within:border-brand-500 dark:focus-within:border-brand-500 transition">
        ${renderMarkdownToolbar(bodyId, sIdx, 0)}
        <textarea id="${bodyId}" rows="3" data-sec-idx="${sIdx}" data-action="exam-sec-body"
          class="autogrow-textarea w-full text-xs font-mono leading-relaxed text-slate-800 dark:text-slate-100 bg-transparent p-3 focus:outline-none placeholder:text-slate-400 min-h-[3.5rem] block"
          placeholder="e.g. Check every section before you hand in.">${escapeHtml(section.body || '')}</textarea>
      </div>
    </div>
    <label class="flex items-start gap-2 text-xs text-slate-600 dark:text-slate-300 cursor-pointer">
      <input type="checkbox" class="mt-0.5" data-action="exam-sec-review" data-sec-idx="${sIdx}" ${section.review !== false ? 'checked' : ''}>
      <span>Show a review first: how many questions are answered, with links to any unanswered question or unfinished checklist. Untick for a plain submit button.</span>
    </label>`;
}

/** Keep exactly one submit section, last, and every other section as a list
    of items. */
function ensureExamSubmitSection() {
  templateData.content.forEach(sec => {
    if (!examIsSubmit(sec) && !Array.isArray(sec.items)) sec.items = [];
  });
  const content = templateData.content;
  const submits = content.filter(examIsSubmit);
  const rest = content.filter(sec => !examIsSubmit(sec));
  const last = submits[0] || { ...examDefaultSubmitSection(), collapsed: false };
  if (submits.length === 1 && content[content.length - 1] === last) return;
  templateData.content = [...rest, last];
}

/** All the text of an item, for the builder's filter. */
const examItemText = (it) => [it.title, it.body, it.prompt, ...(it.tasks || []), ...(it.options || []), ...(it.accepted || []), it.pattern, it.capture].filter(Boolean).join(' ');

function renderExamBuilder() {
  const container = document.getElementById('sectionsContainer');
  if (!container) return;
  ensureExamSubmitSection();
  document.getElementById('templateTitle').value = templateData.title || '';
  document.getElementById('templateDescription').value = templateData.description || '';
  updateMetadataCharCounters();
  const term = globalSearchQuery.toLowerCase().trim();
  const last = templateData.content.length - 1;
  container.innerHTML = templateData.content.map((section, sIdx) => {
    const submit = examIsSubmit(section);
    const items = section.items || [];
    const labels = examItemLabels(items);
    const secMatches = !term || [section.title, section.body].join(' ').toLowerCase().includes(term);
    const cards = items.map((it, ii) => (!term || secMatches || examItemText(it).toLowerCase().includes(term))
      ? examItemCardHtml(it, sIdx, ii, labels[ii], items.length)
      : '').join('');
    const hidden = term && !secMatches && !cards;
    const inner = submit
      ? examSubmitBodyHtml(section, sIdx)
      : `
          <div class="space-y-3.5">${cards}</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <span class="text-[11px] text-slate-400 mr-1">Add:</span>
            ${EXAM_ITEM_TYPE_NAMES.map(t => `
              <button data-action="exam-add-item" data-sec-idx="${sIdx}" data-item-type="${t}" ${items.length >= EXAM_LIMITS.itemsPerSection ? 'disabled' : ''} class="px-2 py-1 border border-dashed border-slate-200 dark:border-white/[0.09] hover:border-slate-400 dark:hover:border-white/[0.2] rounded-md text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition inline-flex items-center gap-1.5 disabled:opacity-40">
                <span class="w-1.5 h-1.5 rounded-full ${EXAM_TYPE_DOT[t]}"></span>${EXAM_ITEM_TYPES[t]}
              </button>`).join('')}
          </div>`;
    const addRow = sIdx === last - 1 ? `
      <div class="flex flex-wrap items-center gap-1.5 px-1">
        <button data-action="exam-add-section" class="px-2 py-1 border border-dashed border-slate-200 dark:border-white/[0.09] hover:border-slate-400 rounded-md text-[11px] font-medium text-slate-500 dark:text-slate-400 hover:text-slate-800 dark:hover:text-slate-200 transition">+ Add section</button>
        <span class="text-[11px] text-slate-400">before the submit step</span>
      </div>` : '';
    return `
      <div id="section-card-${sIdx}" class="${hidden ? 'hidden ' : ''}bg-white dark:bg-surface-900 border ${submit ? 'border-dashed border-violet-300/80 dark:border-violet-500/30' : 'border-slate-200/80 dark:border-white/[0.07]'} rounded-xl shadow-2xs overflow-hidden transition-all">
        ${examSectionHeaderHtml(section, sIdx)}
        <div id="section-body-${sIdx}" class="${section.collapsed ? 'hidden' : 'p-4 sm:p-5 space-y-4'}">${inner}</div>
      </div>${addRow}`;
  }).join('');
  renderOutline();
  updateBadges();
  runFullValidation(false);
  autoGrowAllTextareas(container);
}

function renderExamOutline() {
  const list = document.getElementById('outlineList');
  const countEl = document.getElementById('outlineStepCount');
  if (!list) return;
  list.innerHTML = templateData.content.map((sec, sIdx) => {
    const items = sec.items || [];
    const labels = examItemLabels(items);
    return `
    <div class="pt-2.5 pb-1 px-1 flex items-center space-x-1.5">
      <span class="text-[10px] font-mono text-slate-400 dark:text-slate-500">${examIsSubmit(sec) ? '<i class="ph ph-flag"></i>' : String(sIdx + 1).padStart(2, '0')}</span>
      <button data-on-click="jumpToQuestion(${sIdx}, null)" class="text-[11px] font-semibold text-slate-700 dark:text-slate-300 truncate hover:text-brand-600 text-left">${escapeHtml(sec.title || 'Untitled')}</button>
      ${sec.minutes ? `<span class="ml-auto text-[10px] font-mono text-slate-400">${formatSectionTime(sec.minutes)}</span>` : ''}
    </div>
    <div class="border-l border-slate-200/80 dark:border-white/[0.07] ml-2.5 pl-2 space-y-0.5">
      ${items.map((it, ii) => `
          <button data-on-click="jumpToQuestion(${sIdx}, ${ii})" class="w-full text-left px-2 py-1 rounded-md hover:bg-slate-100 dark:hover:bg-white/[0.05] text-slate-600 dark:text-slate-400 hover:text-slate-900 dark:hover:text-slate-100 truncate flex items-center space-x-2 transition">
            ${examIsQuestion(it) ? `<span class="w-1.5 h-1.5 rounded-full shrink-0 ${EXAM_TYPE_DOT[it.type]}"></span>` : `<i class="ph ${it.type === 'checklist' ? 'ph-check-square text-amber-500' : 'ph-info text-slate-400'} text-[11px] shrink-0"></i>`}
            <span class="text-[10px] font-mono text-slate-400 shrink-0">${labels[ii]}</span>
            <span class="truncate flex-1 text-[11px]">${escapeHtml((examIsQuestion(it) ? it.prompt || '(no prompt)' : it.title || it.body || EXAM_ITEM_TYPES[it.type]).replace(/[#*_>`]/g, '').replace(/\s+/g, ' ').slice(0, 60))}</span>
          </button>`).join('')}
    </div>`;
  }).join('');
  if (countEl) countEl.textContent = `${examQuestionCount()} questions`;
}

/** Open a section (and one of its items, by index) in the builder. */
function jumpToQuestion(sIdx, ii) {
  switchView('builder');
  const sec = templateData.content[sIdx];
  if (sec) {
    sec.collapsed = false;
    if (ii !== null && sec.items && sec.items[ii]) sec.items[ii].collapsed = false;
  }
  renderBuilder();
  requestAnimationFrame(() => {
    const el = (ii !== null && document.getElementById(`q-card-${sIdx}-${ii}`)) || document.getElementById(`section-card-${sIdx}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      el.classList.add('highlight-jump');
      setTimeout(() => el.classList.remove('highlight-jump'), 1000);
    }
  });
}

/** Add a section just before the submit section (which always stays last). */
function addExamSection() {
  const content = templateData.content;
  const at = content.findIndex(examIsSubmit);
  const where = at < 0 ? content.length : at;
  content.splice(where, 0, { title: `Section ${where + 1}`, minutes: null, collapsed: false, items: [{ ...examBlankQuestion('single'), collapsed: false }] });
  if (at < 0) content.push({ ...examDefaultSubmitSection(), collapsed: false });
  pushHistorySnapshot(true);
  renderBuilder();
  scheduleAutoSave();
}

/** Change an item's type, keeping what still makes sense: the prompt and
    points between questions (the options and answers between choice
    types), title, text and checklist between steps, and the text either
    way between a step and a question. */
function convertExamItem(it, type) {
  if (it.type === type) return it;
  const text = examIsQuestion(it) ? it.prompt : it.body;
  if (!examIsQuestion({ type })) {
    const next = { ...examBlankItem(type), title: it.title || '', body: text || '', collapsed: it.collapsed };
    if (type === 'checklist' && (it.tasks || []).length) next.tasks = [...it.tasks];
    return next;
  }
  const next = { ...examBlankQuestion(type), prompt: text || '', points: examIsQuestion(it) ? it.points : 1, collapsed: it.collapsed };
  if (EXAM_HAS_OPTIONS(type) && EXAM_HAS_OPTIONS(it.type)) {
    next.options = [...it.options];
    if (type === 'single') next.correct = Array.isArray(it.correct) ? (it.correct[0] ?? 0) : (it.correct ?? 0);
    else next.correct = Array.isArray(it.correct) ? [...it.correct] : (it.correct === null ? [] : [it.correct]);
  }
  return next;
}

function examCommit(rerender = true) {
  pushHistorySnapshot(true);
  if (rerender) renderBuilder();
  else { renderOutline(); runFullValidation(false); }
  scheduleAutoSave();
}

/** Refresh a short answer's grading note and badge in place (re-rendering
    while the author types would swallow their next click). */
function examRefreshShortNote(q, sIdx, ii) {
  const note = document.getElementById(`q-accepted-note-${sIdx}-${ii}`);
  if (note) note.textContent = examAcceptedNote(q);
  const badge = document.getElementById(`q-grading-${sIdx}-${ii}`);
  if (badge) badge.innerHTML = examGradingBadge(q);
}

function examHandleClick(action, target, sIdx) {
  if (action === 'exam-add-section') return addExamSection();
  const sec = templateData.content[sIdx];
  if (!sec || !Array.isArray(sec.items)) return;
  const items = sec.items;
  if (action === 'exam-add-item') {
    if (items.length >= EXAM_LIMITS.itemsPerSection) return showToast('Too many questions and steps in this section.', 'error');
    items.push({ ...examBlankItem(target.dataset.itemType || 'single'), collapsed: false });
    examCommit();
    const ii = items.length - 1;
    requestAnimationFrame(() => document.querySelector(`#q-card-${sIdx}-${ii} textarea, #q-card-${sIdx}-${ii} input[type="text"]`)?.focus());
    return;
  }
  const ii = parseInt(target.dataset.itemIdx, 10);
  const it = items[ii];
  if (!it) return;
  if (action === 'exam-toggle-item') { it.collapsed = !it.collapsed; renderBuilder(); scheduleAutoSave(); }
  else if (action === 'exam-toggle-preview') { it.previewOpen = !it.previewOpen; renderBuilder(); }
  else if (action === 'exam-del-item') {
    if (items.length <= 1) return showToast('A section needs at least one question or step.', 'error');
    items.splice(ii, 1);
    examCommit();
    showToast('Deleted (Ctrl+Z to undo)', 'info');
  } else if (action === 'exam-dup-item') {
    if (items.length >= EXAM_LIMITS.itemsPerSection) return;
    const copy = JSON.parse(JSON.stringify(it));
    delete copy.capture; // a saved name must stay unique
    delete copy.id; // a copy gets its own id when saved
    items.splice(ii + 1, 0, copy);
    examCommit();
  } else if (action === 'exam-move-item-up' || action === 'exam-move-item-down') {
    const to = ii + (action === 'exam-move-item-up' ? -1 : 1);
    if (to < 0 || to >= items.length) return;
    items.splice(to, 0, items.splice(ii, 1)[0]);
    examCommit();
  } else if (action === 'exam-add-task') {
    it.tasks = it.tasks || [];
    if (it.tasks.length >= EXAM_LIMITS.tasks) return;
    it.tasks.push('');
    examCommit();
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll(`#q-card-${sIdx}-${ii} [data-action="exam-task"]`);
      inputs[inputs.length - 1]?.focus();
    });
  } else if (action === 'exam-del-task') {
    it.tasks.splice(parseInt(target.dataset.taskIdx, 10), 1);
    examCommit();
  } else if (action === 'exam-q-add-option') {
    if (it.options.length >= EXAM_LIMITS.options) return;
    it.options.push('');
    examCommit();
    requestAnimationFrame(() => {
      const inputs = document.querySelectorAll(`#q-card-${sIdx}-${ii} [data-action="exam-q-option"]`);
      inputs[inputs.length - 1]?.focus();
    });
  } else if (action === 'exam-q-del-option') {
    const oi = parseInt(target.dataset.optIdx, 10);
    if (it.options.length <= 2) return;
    it.options.splice(oi, 1);
    if (it.type === 'multiple') it.correct = it.correct.filter(i => i !== oi).map(i => (i > oi ? i - 1 : i));
    else if (it.correct === oi) it.correct = 0;
    else if (it.correct > oi) it.correct -= 1;
    examCommit();
  }
}

function examHandleInput(action, target, sIdx) {
  const sec = templateData.content[sIdx];
  if (!sec) return;
  if (action === 'exam-sec-body') { sec.body = target.value; examCommit(false); return; }
  const ii = parseInt(target.dataset.itemIdx, 10);
  const it = sec.items?.[ii];
  if (!it) return;
  const optional = (key) => {
    if (target.value.trim()) it[key] = key === 'capture' ? target.value.trim() : target.value;
    else delete it[key];
  };
  if (action === 'exam-item-title') it.title = target.value;
  else if (action === 'exam-item-body') it.body = target.value;
  else if (action === 'exam-task') it.tasks[parseInt(target.dataset.taskIdx, 10)] = target.value;
  else if (action === 'exam-q-prompt') it.prompt = target.value;
  else if (action === 'exam-q-option') it.options[parseInt(target.dataset.optIdx, 10)] = target.value;
  else if (action === 'exam-q-accepted') { it.accepted = examSplitPipes(target.value); examRefreshShortNote(it, sIdx, ii); }
  else if (action === 'exam-q-pattern') { it.pattern = target.value; examRefreshShortNote(it, sIdx, ii); }
  else if (action === 'exam-q-placeholder') optional('placeholder');
  else if (action === 'exam-q-capture') optional('capture');
  else if (action === 'exam-q-points') {
    const n = Number(target.value);
    it.points = Number.isFinite(n) ? Math.min(Math.max(n, 0), EXAM_LIMITS.maxPoints) : 1;
  } else return;
  examRefreshItemPreview(it, sIdx, ii);
  examCommit(false);
}

function examHandleChange(action, target, sIdx) {
  const sec = templateData.content[sIdx];
  if (!sec) return;
  if (action === 'exam-sec-review') { sec.review = target.checked; examCommit(false); return; }
  const ii = parseInt(target.dataset.itemIdx, 10);
  const it = sec.items?.[ii];
  if (!it) return;
  if (action === 'exam-item-type') { sec.items[ii] = convertExamItem(it, target.value); examCommit(); }
  else if (action === 'exam-q-match') {
    if (target.value === 'pattern') Object.assign(it, { match: 'pattern', pattern: it.pattern || '', accepted: [] });
    else { delete it.match; delete it.pattern; }
    examCommit();
  } else if (action === 'exam-q-correct') {
    const oi = parseInt(target.dataset.optIdx, 10);
    if (it.type === 'multiple') {
      it.correct = target.checked ? [...new Set([...it.correct, oi])].sort((a, b) => a - b) : it.correct.filter(i => i !== oi);
    } else it.correct = oi;
    examCommit();
  } else if (action === 'exam-q-tf') { it.correct = target.value === 'true'; examCommit(false); }
}

// ---- Preview: the exam as a participant sees it, with a self-check ----
let examPreviewState = { answers: {}, checked: false, showKey: false };

function examPreviewSet(key, value, rerender) {
  examPreviewState.answers[key] = value;
  if (rerender) renderExamPreview();
  else if (value === true || value === false || typeof value === 'number' || Array.isArray(value)) examPreviewGateCheck(false);
}

/** The last section the preview opens: all of them, or as vLabs gates. */
function examPreviewUnlocked() {
  if (!previewState.progressiveGate) return Infinity;
  return examUnlockedSection(examNormalise(templateData).content, examPreviewState.answers);
}

/** Re-render when an answer opened or locked a section (or `force`). */
function examPreviewGateCheck(force) {
  if (force || examPreviewUnlocked() !== examPreviewState.unlocked) renderExamPreview();
}

/** Tick or untick option `oi` of a multiple-answer question. */
function examPreviewToggle(key, oi, checked, rerender) {
  const chosen = (examPreviewState.answers[key] || []).filter(i => i !== oi);
  examPreviewSet(key, checked ? [...chosen, oi].sort((a, b) => a - b) : chosen, rerender);
}

/** The preview seat's {{ PLACEHOLDER }} values, with answers saved so far. */
function examPreviewContext() {
  const seat = parseInt(document.getElementById('previewSeat')?.value || '7', 10) || 1;
  const firstName = document.getElementById('previewFirstName')?.value || 'Mary-Jane';
  const lastName = document.getElementById('previewLastName')?.value || "O'Neil";
  const exam = examNormalise(templateData);
  const byKey = new Map();
  exam.content.forEach((sec, si) => examSectionLayout(sec, si).forEach(at => { if (at.key) byKey.set(at.key, at.item); }));
  const saved = {};
  examCaptures(exam).forEach(c => {
    if (c.name in saved) return;
    const v = examCapturedValue(byKey.get(c.key), examPreviewState.answers[c.key]);
    saved[c.name] = v || `[answer to ${c.where}]`;
  });
  return { seat, firstName, lastName, ctx: buildEvaluatedContext(seat, firstName, lastName, saved) };
}

function renderExamPreview() {
  const container = document.getElementById('previewManualContainer');
  const bar = document.getElementById('previewVariablesBar');
  if (!container) return;
  const st = examPreviewState;
  const { seat, firstName, lastName, ctx } = examPreviewContext();
  const md = (text) => parseMarkdownSafe(resolveMarkdownImages(text || '', ctx));
  let number = 0;
  let score = 0;
  let auto = 0;
  let manual = 0;
  const verdictHtml = (v) => v === true
    ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">Correct</span>'
    : v === false
      ? '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-rose-100 text-rose-700 dark:bg-rose-500/15 dark:text-rose-300">Incorrect</span>'
      : '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-amber-100 text-amber-700 dark:bg-amber-500/15 dark:text-amber-300">Marked by hand</span>';

  const questionHtml = (raw, key) => {
    number += 1;
    // As this seat sees it: accepted answers may use {{ PLACEHOLDERS }}.
    const q = examNormaliseQuestion(raw);
    q.accepted = q.accepted.map(x => substitutePlaceholders(x, ctx)).filter(x => x.trim());
    const a = st.answers[key];
    const answered = !(a === undefined || a === null || a === '' || (Array.isArray(a) && !a.length));
    const g = examGrade(q, a);
    if (g === null) manual += Number(q.points) || 0;
    else { auto += Number(q.points) || 0; if (g) score += Number(q.points) || 0; }
    let input = '';
    if (q.type === 'single' || q.type === 'multiple') {
      input = q.options.map((o, oi) => {
        const chosen = q.type === 'multiple' ? Array.isArray(a) && a.includes(oi) : a === oi;
        const isKey = q.type === 'multiple' ? q.correct.includes(oi) : q.correct === oi;
        const next = q.type === 'multiple'
          ? `examPreviewToggle('${key}', ${oi}, this.checked, ${st.checked})`
          : `examPreviewSet('${key}', ${oi}, ${st.checked})`;
        return `
          <label class="flex items-center gap-2.5 px-3 py-2 rounded-lg border ${st.showKey && isKey ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/[0.08]' : 'border-slate-200 dark:border-white/[0.08]'} cursor-pointer text-xs text-slate-700 dark:text-slate-200">
            <input type="${q.type === 'multiple' ? 'checkbox' : 'radio'}" name="pv-${key}" ${chosen ? 'checked' : ''} data-on-change="${next}">
            <span class="font-mono text-[11px] text-slate-400">${examLetter(oi)}</span>
            <span class="prose-preview">${md(o)}</span>
          </label>`;
      }).join('');
    } else if (q.type === 'truefalse') {
      input = [true, false].map(v => `
        <label class="inline-flex items-center gap-2 px-3 py-2 rounded-lg border ${st.showKey && q.correct === v ? 'border-emerald-400 bg-emerald-50/60 dark:bg-emerald-500/[0.08]' : 'border-slate-200 dark:border-white/[0.08]'} cursor-pointer text-xs text-slate-700 dark:text-slate-200 mr-2">
          <input type="radio" name="pv-${key}" ${a === v ? 'checked' : ''} data-on-change="examPreviewSet('${key}', ${v}, ${st.checked})"> ${v ? 'True' : 'False'}
        </label>`).join('');
    } else if (q.type === 'short') {
      input = `<input type="text" value="${escapeHtml(a || '')}" data-on-input="examPreviewSet('${key}', this.value, false)" data-on-change="examPreviewGateCheck(${q.capture ? 'true' : 'false'})" placeholder="${escapeHtml(q.placeholder || 'Type your answer')}"
        class="w-full sm:w-80 text-xs bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500">`;
    } else {
      input = `<textarea rows="3" data-on-input="examPreviewSet('${key}', this.value, false)" data-on-change="examPreviewGateCheck(false)" placeholder="Your answer"
        class="w-full text-xs bg-white dark:bg-surface-850 border border-slate-200/80 dark:border-white/[0.08] rounded-md px-2.5 py-1.5 text-slate-800 dark:text-slate-200 focus:outline-none focus:border-brand-500">${escapeHtml(a || '')}</textarea>`;
    }
    const keyNote = !st.showKey ? ''
      : q.type === 'truefalse' ? `Answer: ${q.correct ? 'True' : 'False'}`
      : q.type === 'short' && q.match === 'pattern' ? `Pattern: ${q.pattern}${examMaskExample(q.pattern) ? ` (e.g. ${examMaskExample(q.pattern)})` : ''}`
      : q.type === 'short' ? (q.accepted.length ? `Accepted: ${q.accepted.join(' | ')}` : 'Marked by hand')
      : q.type === 'long' ? 'Marked by hand' : '';
    return `
      <div class="bg-white dark:bg-surface-900 border border-slate-200/80 dark:border-white/[0.07] rounded-xl p-4 space-y-3">
        <div class="flex items-center justify-between gap-2">
          <span class="text-[11px] font-mono font-semibold text-slate-500">Question ${number} · ${q.points} pt${q.points === 1 ? '' : 's'}</span>
          ${st.checked ? (answered ? verdictHtml(g) : '<span class="text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500 dark:bg-white/[0.06] dark:text-slate-400">Unanswered</span>') : ''}
        </div>
        <div class="prose-preview text-sm text-slate-800 dark:text-slate-100">${md(q.prompt)}</div>
        <div class="${q.type === 'single' || q.type === 'multiple' ? 'space-y-1.5' : ''}">${input}</div>
        ${keyNote ? `<p class="text-[11px] text-emerald-700 dark:text-emerald-400">${escapeHtml(keyNote)}</p>` : ''}
      </div>`;
  };

  const stepHtml = (step, tasks) => {
    const title = (step.title || '').trim();
    return `
      <div class="bg-white dark:bg-surface-900 border border-slate-200/80 dark:border-white/[0.07] rounded-xl p-4 space-y-3">
        ${title ? `<p class="text-sm font-semibold text-slate-800 dark:text-slate-100">${escapeHtml(substitutePlaceholders(title, ctx))}</p>` : ''}
        ${(step.body || '').trim() ? `<div class="prose-preview text-sm text-slate-800 dark:text-slate-100">${md(step.body)}</div>` : ''}
        ${tasks.length ? `<p class="text-[11px] font-semibold text-slate-500">Tick each item once it is done</p>` : ''}
        ${tasks.map(t => `
          <label class="flex items-center gap-2.5 px-3 py-2 rounded-lg border border-slate-200 dark:border-white/[0.08] cursor-pointer text-xs text-slate-700 dark:text-slate-200">
            <input type="checkbox" ${st.answers[t.key] ? 'checked' : ''} data-on-change="examPreviewSet('${t.key}', this.checked, false)">
            <span class="prose-preview">${md(t.text)}</span>
          </label>`).join('')}
        ${!title && !(step.body || '').trim() && !tasks.length ? '<p class="text-xs text-slate-400">No instructions yet.</p>' : ''}
      </div>`;
  };

  const unlocked = examPreviewUnlocked();
  st.unlocked = unlocked;
  const sectionsHtml = templateData.content.map((sec, sIdx) => {
    const submit = examIsSubmit(sec);
    if (sIdx > unlocked) {
      return `
        <div class="p-4 rounded-xl border border-dashed border-slate-300 dark:border-slate-800 bg-slate-50/50 dark:bg-surface-950/50 flex items-center justify-between gap-3 text-xs text-slate-400">
          <span class="font-semibold flex items-center gap-2"><i class="ph-fill ph-lock-key text-sm"></i> ${submit ? 'Review and submit' : `Section ${sIdx + 1} · ${escapeHtml(substitutePlaceholders(sec.title || '', ctx))}`}</span>
          <span class="text-[11px]">Locked: answer every question and tick every checklist item before it</span>
        </div>`;
    }
    let inner;
    if (submit) {
      inner = `
        <div class="bg-white dark:bg-surface-900 border border-dashed border-violet-300/80 dark:border-violet-500/30 rounded-xl p-4 space-y-3">
          ${(sec.body || '').trim() ? `<div class="prose-preview text-sm text-slate-800 dark:text-slate-100">${md(sec.body)}</div>` : ''}
          <p class="text-xs text-slate-500">${sec.review !== false ? 'Participants see how many questions they answered, with links to anything left, then:' : 'Participants see only:'}</p>
          <span class="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md bg-brand-600 text-white text-xs font-medium"><i class="ph ph-flag"></i> Submit</span>
        </div>`;
    } else {
      // Keys as in vLabs: questions count per part, ticks across the part.
      // Like vLabs, a section is one page with its items one below the other.
      inner = examSectionLayout(sec, sIdx).map(at =>
        'qi' in at ? questionHtml(at.item, at.key) : stepHtml(at.item, at.tasks.filter(t => String(t.text).trim()))
      ).join('') || '<p class="text-xs text-slate-400">No questions or steps yet.</p>';
    }
    return `
      <div class="space-y-3">
        <div class="flex items-center gap-2">
          <span class="text-[11px] font-mono px-1.5 py-0.5 rounded bg-slate-200/70 dark:bg-white/[0.07] text-slate-600 dark:text-slate-300">${submit ? '<i class="ph ph-flag"></i>' : sIdx + 1}</span>
          <h3 class="text-sm font-semibold text-slate-900 dark:text-white">${escapeHtml(substitutePlaceholders(sec.title || `Section ${sIdx + 1}`, ctx))}</h3>
          ${sec.minutes && !submit ? `<span class="text-[10px] font-mono text-slate-400"><i class="ph ph-timer"></i> ${formatSectionTime(sec.minutes)}</span>` : ''}
        </div>
        ${inner}
      </div>`;
  }).join('');

  if (bar) {
    bar.classList.remove('hidden');
    const pills = [['SEAT_ID', seat], ['FULL_NAME', `${firstName} ${lastName}`.trim()],
      ...(templateData.variables || []).filter(v => v.name).map(v => [v.name, ctx[v.name]]),
      ...examCaptures(templateData).map(c => [c.name, ctx[c.name], true])];
    bar.innerHTML = `
      <span class="w-full flex flex-wrap items-center gap-1.5 pb-1.5">
        <span class="text-[10px] font-bold uppercase text-slate-400 mr-1">Resolved for this seat:</span>
        ${pills.map(([k, v, saved]) => `
          <span class="px-2 py-0.5 rounded-md ${saved ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800' : 'bg-slate-100 dark:bg-surface-850 border-slate-200 dark:border-slate-700'} border font-mono" title="${saved ? 'Saved from a short answer' : ''}">
            <span class="${saved ? 'text-emerald-700 dark:text-emerald-300' : 'text-brand-600 dark:text-brand-400'} font-semibold">${escapeHtml(k)}</span>=${escapeHtml(String(v ?? ''))}
          </span>`).join('')}
      </span>
      <span class="text-slate-500">${examQuestionCount()} questions · ${examTotalPoints()} points</span>
      <span class="text-slate-400">· participants see one section at a time, each on one page; the next section unlocks once every question is answered and every checklist item ticked, and nothing is reviewable after submitting.</span>
      <span class="ml-auto flex items-center gap-1.5">
        <label class="inline-flex items-center gap-1.5 text-xs text-slate-600 dark:text-slate-300 cursor-pointer select-none bg-slate-50 dark:bg-surface-850 px-2.5 py-1 rounded-md border border-slate-200/80 dark:border-white/[0.07]">
          <input type="checkbox" ${st.showKey ? 'checked' : ''} data-on-change="examPreviewState.showKey = this.checked; renderExamPreview()"> Show answer key
        </label>
        <button data-on-click="examPreviewState.checked = true; renderExamPreview()" class="px-2.5 py-1 bg-brand-600 hover:bg-brand-500 text-white rounded-md text-xs font-medium transition">Check my answers</button>
        <button data-on-click="examPreviewState = { answers: {}, checked: false, showKey: examPreviewState.showKey }; renderExamPreview()" class="px-2.5 py-1 bg-slate-100 dark:bg-surface-850 hover:bg-slate-200/70 dark:hover:bg-surface-800 text-slate-600 dark:text-slate-300 rounded-md text-xs font-medium transition">Reset</button>
      </span>
      ${st.checked ? `<span class="w-full pt-1 text-xs font-semibold text-slate-700 dark:text-slate-200">Self-check: ${score} / ${auto} auto-graded points${manual ? ` · ${manual} point(s) marked by hand` : ''}</span>` : ''}`;
  }
  container.innerHTML = sectionsHtml;
}

// ---- Validation and images -------------------------------------------
/** "Section 2 · step 1" / "Section 2 · question 3" for an item's layout entry. */
const examWhere = (sIdx, at) => `Section ${sIdx + 1} · ${'qi' in at ? 'question' : 'step'} ${at.n}`;

function extractExamImageRefs() {
  const refs = [];
  const scan = (text, locLabel, sIdx, stIdx) => {
    const re = /!\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
    let m;
    while ((m = re.exec(String(text || ''))) !== null) {
      const rawPath = m[1];
      refs.push({ fileName: rawPath.split('/').pop(), rawPath, locLabel, sIdx, stIdx, isDynamic: false });
    }
  };
  templateData.content.forEach((sec, sIdx) => {
    scan(sec.body, `Section ${sIdx + 1}`, sIdx, 0);
    examSectionLayout(sec, sIdx).forEach(at => {
      const where = examWhere(sIdx, at);
      const it = at.item;
      if ('qi' in at) {
        scan(it.prompt, `${where} prompt`, sIdx, at.ii);
        (it.options || []).forEach((o, oi) => scan(o, `${where} option ${examLetter(oi)}`, sIdx, at.ii));
      } else {
        scan(it.body, where, sIdx, at.ii);
        (it.tasks || []).forEach((t, ti) => scan(t, `${where} checklist item ${ti + 1}`, sIdx, at.ii));
      }
    });
  });
  return refs;
}

/** Exam rules, in vLabs' own wording, as issues the validation view lists. */
function collectExamIssues(addError, addWarning) {
  const title = (templateData.title || '').trim();
  if (!title) addError('Front Matter', 'Title is required', { view: 'builder' });
  else if (title.length > EXAM_LIMITS.title) addError('Front Matter', `Title exceeds ${EXAM_LIMITS.title} characters`, { view: 'builder' });
  if ((templateData.description || '').length > EXAM_LIMITS.description) {
    addError('Front Matter', `Description exceeds ${EXAM_LIMITS.description} characters`, { view: 'builder' });
  }
  const declared = collectVariableIssues(addError);
  const secs = templateData.content || [];
  const parts = secs.filter(sec => !examIsSubmit(sec));
  if (!parts.length) addError('Structure', 'At least one section is required', { view: 'builder' });
  if (secs.length > EXAM_LIMITS.sections) addError('Structure', `Too many sections (${secs.length} / ${EXAM_LIMITS.sections} max)`, { view: 'builder' });
  if (secs.filter(examIsSubmit).length !== 1 || !examIsSubmit(secs[secs.length - 1])) {
    addWarning('Structure', 'The exam should end with exactly one submit section (it is added on export)', { view: 'builder' });
  }
  let questions = 0;
  let steps = 0;
  secs.forEach((sec, sIdx) => {
    const loc = `Section ${sIdx + 1}`;
    if (!(sec.title || '').trim()) addError(loc, `Section ${sIdx + 1} needs a title`, { sIdx, stIdx: 0 });
    if (sec.minutes !== null && sec.minutes !== undefined && sec.minutes !== '' && !validSectionMinutes(sec.minutes)) {
      addError(loc, `Section ${sIdx + 1} time allocated must be a whole number of minutes from 1 to 600 (or empty)`, { sIdx, stIdx: 0 });
    }
    if ((sec.body || '').length > EXAM_LIMITS.body) addError(loc, `Text exceeds ${EXAM_LIMITS.body} characters`, { sIdx, stIdx: 0 });
    if (examIsSubmit(sec)) return;
    const items = sec.items || [];
    if (!items.length) addError(loc, `Section ${sIdx + 1} has no questions or steps`, { sIdx, stIdx: 0 });
    if (items.length > EXAM_LIMITS.itemsPerSection) addError(loc, `Section ${sIdx + 1} has too many questions and steps (max ${EXAM_LIMITS.itemsPerSection})`, { sIdx, stIdx: 0 });
    examSectionLayout(sec, sIdx).forEach(at => {
      const where = examWhere(sIdx, at);
      const pos = { sIdx, stIdx: at.ii };
      const raw = at.item;
      if (!('qi' in at)) {
        steps += 1;
        const it = examNormaliseItem(raw);
        if ((raw.body || '').length > EXAM_LIMITS.body) addError(where, `Text exceeds ${EXAM_LIMITS.body} characters`, pos);
        examStepErrors(it, where).forEach(msg => addError(where, msg, pos));
        if (it.type === 'checklist') {
          if ((raw.tasks || []).length !== it.tasks.length) addWarning(where, `${where} has an empty checklist item (left out on export)`, pos);
          if ((raw.tasks || []).length > EXAM_LIMITS.tasks) addError(where, `${where} has too many checklist items (max ${EXAM_LIMITS.tasks})`, pos);
        }
        return;
      }
      questions += 1;
      if ((raw.prompt || '').length > EXAM_LIMITS.prompt) addError(where, `Prompt exceeds ${EXAM_LIMITS.prompt} characters`, pos);
      const q = examNormaliseQuestion(raw);
      examQuestionErrors(q, where).forEach(msg => addError(where, msg, pos));
      if (q.points === 0) addWarning(where, `${where} is worth 0 points`, pos);
      if (EXAM_HAS_OPTIONS(q.type)) {
        const seen = q.options.filter(Boolean).map(o => o.toLowerCase());
        if (new Set(seen).size !== seen.length) addWarning(where, `${where} has two identical options`, pos);
      }
    });
  });
  const lib = templateData.images || [];
  extractExamImageRefs().forEach(ref => {
    if (!lib.some(img => (img.name || '').toLowerCase() === ref.fileName.toLowerCase())) {
      addError(ref.locLabel, `Image "${ref.fileName}" referenced in ${ref.locLabel} is not in the image library — upload it first`, { sIdx: ref.sIdx, stIdx: ref.stIdx });
    }
  });
  // Placeholders: variables, built-ins and answers saved in earlier sections.
  const norm = examNormalise(templateData);
  const saveErrors = [];
  examCaptureErrors(norm, saveErrors);
  saveErrors.forEach(msg => addError(msg.split(':')[0], msg, { view: 'builder' }));
  examUnknownPlaceholders(norm).forEach(({ name, where, early }) => addError(where, early
    ? `{{ ${name} }} is used in ${where} before the question that saves it (saved answers are available from the following section onward)`
    : `Unknown placeholder {{ ${name} }} in ${where}`, { view: 'builder' }));
  return `Checked ${parts.length} section(s), ${questions} question(s), ${steps} step(s), ${declared.size} variable(s) and ${examCaptures(norm).length} saved answer(s): types, correct answers and patterns, checklists, points, time allocations, placeholders and image assets.`;
}

/** The exam as vLabs stores it (what its importer reads and its server saves). */
function generateExamCanonicalJson() {
  const exam = examNormalise(templateData);
  return JSON.stringify({
    kind: 'exam',
    title: (exam.title || 'Untitled').trim(),
    description: exam.description,
    variables: exam.variables.filter(v => v.name || v.expression),
    content: exam.content.map(({ minutes, ...sec }) => ({
      ...sec,
      title: sec.title.trim(),
      ...(minutes ? { minutes } : {}),
      ...('body' in sec ? { body: sec.body.trim() } : {}),
      ...(sec.items ? { items: sec.items.map(it => ('prompt' in it ? { ...it, prompt: it.prompt.trim() } : { ...it, body: it.body.trim() })) } : {})
    }))
  }, null, 2);
}
