// Documents: the offline Studio's own storage.
//
// Opened on its own (not inside vLabs), the Studio keeps every template you
// work on as a document in the browser's IndexedDB, images included, and
// lists them under Documents. Each New, example or import starts a new
// document; the one you were on stays in the list. Save to file (Ctrl+S)
// writes the open document as a vLabs package (.zip) on disk, back to the
// same file once picked where the browser allows it, and Open file reads
// one back in. If the browser will not store a document, the header says
// "Not saved" and a message says so: nothing is dropped silently.
const studioDocs = (() => {
  const DB_NAME = 'vlabs-studio';
  const STORE = 'documents';
  const CURRENT_KEY = 'vlabs_studio_current_doc';
  const LEGACY_DRAFT_KEY = 'vlabs_studio_persistent_draft';
  let db = null;
  let currentId = null;
  let fileHandle = null;
  let failing = false;

  const newId = () => `doc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  function openDb() {
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  function run(mode, fn) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const req = fn(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(req ? req.result : undefined);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('Storage refused the document'));
    });
  }

  function setIndicator(state) {
    const el = document.getElementById('saveStatusIndicator');
    if (!el) return;
    const [dot, text] = {
      saving: ['bg-amber-500 animate-pulse', 'Saving'],
      saved: ['bg-emerald-500', 'Saved'],
      failed: ['bg-rose-500', 'Not saved'],
    }[state];
    el.innerHTML = `<span class="w-1.5 h-1.5 rounded-full ${dot}"></span><span class="${state === 'failed' ? 'text-rose-600 dark:text-rose-400' : ''}">${text}</span>`;
    el.title =
      state === 'failed'
        ? 'This browser would not store the document. Use Save to file to keep your work.'
        : '';
  }

  function remember(id) {
    currentId = id;
    try {
      localStorage.setItem(CURRENT_KEY, id);
    } catch (_) {
      // Only which document was open is lost; the documents are in IndexedDB.
    }
  }

  /** Open storage; resolves to the document to show (or null for none). */
  async function init() {
    try {
      db = await openDb();
    } catch (_) {
      db = null;
      showToast(
        'This browser will not store documents here. Use Save to file to keep your work.',
        'error',
      );
      return null;
    }
    // Drafts kept by Studio 1.14 and earlier (one slot in localStorage).
    try {
      const legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
      if (legacy) {
        const data = JSON.parse(legacy);
        if (data && Array.isArray(data.content)) {
          const id = newId();
          await run('readwrite', (s) => s.put(record(id, data)));
          remember(id);
        }
        localStorage.removeItem(LEGACY_DRAFT_KEY);
      }
    } catch (_) {
      // A broken old draft is not worth blocking the Studio for.
    }
    let id = null;
    try {
      id = localStorage.getItem(CURRENT_KEY);
    } catch (_) {
      id = null;
    }
    let doc = id ? await run('readonly', (s) => s.get(id)) : null;
    if (!doc) doc = (await list())[0] || null;
    if (!doc) return null;
    remember(doc.id);
    return doc.data;
  }

  function record(id, data) {
    return {
      id,
      title: String(data.title || '').trim() || 'Untitled',
      kind: data.kind === 'exam' ? 'exam' : 'lab',
      updatedAt: Date.now(),
      data,
    };
  }

  /** Store the open template as the current document. */
  async function save(data) {
    if (!db) {
      setIndicator('failed');
      return;
    }
    if (!currentId) remember(newId());
    setIndicator('saving');
    try {
      await run('readwrite', (s) => s.put(record(currentId, JSON.parse(JSON.stringify(data)))));
      failing = false;
      setIndicator('saved');
    } catch (err) {
      setIndicator('failed');
      if (!failing) {
        showToast(
          `Not saved in this browser${/quota/i.test(String(err?.name || err)) ? ' (storage is full)' : ''}. Use Save to file to keep your work.`,
          'error',
        );
      }
      failing = true;
    }
  }

  /** The next change starts a new document; the current one stays listed. */
  function startNew() {
    remember(newId());
    fileHandle = null;
    historyStack = [];
    historyIndex = -1;
  }

  async function list() {
    if (!db) return [];
    const all = await run('readonly', (s) => s.getAll());
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  function showDoc(data) {
    templateData = data;
    resetPreviewSimulation(false);
    pushHistorySnapshot(true);
    refreshAllActiveViews();
  }

  async function openDoc(id) {
    closeMenu();
    if (id === currentId) return;
    const doc = await run('readonly', (s) => s.get(id));
    if (!doc) return showToast('That document is gone.', 'error');
    clearTimeout(autoSaveTimer);
    await save(templateData);
    startNew();
    remember(doc.id);
    showDoc(doc.data);
    showToast(`Opened ${doc.title}`, 'success');
  }

  function deleteDoc(id) {
    closeMenu();
    run('readonly', (s) => s.get(id)).then((doc) => {
      if (!doc) return;
      openConfirmModal({
        title: 'Delete this document?',
        message: `"${doc.title}" will be removed from this browser. Files you saved stay where they are.`,
        confirmText: 'Delete',
        onConfirm: async () => {
          await run('readwrite', (s) => s.delete(id));
          if (id === currentId) {
            const next = (await list())[0];
            startNew();
            if (next) remember(next.id);
            showDoc(next ? next.data : createBlankTemplate());
            if (!next) scheduleAutoSave(true);
          }
          showToast(`Deleted ${doc.title}`, 'info');
        },
      });
    });
  }

  function closeMenu() {
    document.getElementById('docsMenu')?.classList.add('hidden');
  }

  async function toggleMenu() {
    const menu = document.getElementById('docsMenu');
    if (!menu) return;
    if (!menu.classList.contains('hidden')) return closeMenu();
    const docs = await list();
    const when = (t) =>
      new Date(t).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
    const listEl = document.getElementById('docsMenuList');
    listEl.innerHTML =
      docs
        .map(
          (d) => `
        <div class="flex items-center gap-1 px-1.5">
          <button data-on-click="studioDocs.openDoc('${d.id}')" class="flex-1 min-w-0 text-left px-1.5 py-1.5 rounded-md hover:bg-slate-50 dark:hover:bg-white/[0.04] ${d.id === currentId ? 'bg-slate-50 dark:bg-white/[0.05]' : ''}">
            <span class="flex items-center gap-1.5 font-medium text-slate-800 dark:text-slate-200 truncate">
              <i class="ph ${d.kind === 'exam' ? 'ph-exam text-violet-500' : 'ph-flask text-sky-500'} text-sm shrink-0"></i>
              <span class="truncate">${escapeHtml(d.title)}</span>
              ${d.id === currentId ? '<span class="text-[10px] text-slate-400 shrink-0">open</span>' : ''}
            </span>
            <span class="block text-[10px] text-slate-400 pl-5">${escapeHtml(when(d.updatedAt))}</span>
          </button>
          <button data-on-click="studioDocs.deleteDoc('${d.id}')" class="p-1.5 text-slate-400 hover:text-rose-600 rounded-md" title="Delete from this browser"><i class="ph ph-trash text-xs"></i></button>
        </div>`,
        )
        .join('') || '<p class="px-3 py-2 text-slate-400">No documents yet.</p>';
    menu.classList.remove('hidden');
  }

  /** Write the open document to disk as a vLabs package (.zip). */
  async function saveToFile() {
    closeMenu();
    const blob = await buildZipPackage();
    const name = `${templateFileSlug()}.zip`;
    if (window.showSaveFilePicker) {
      try {
        if (!fileHandle) {
          fileHandle = await window.showSaveFilePicker({
            suggestedName: name,
            types: [{ description: 'vLabs package', accept: { 'application/zip': ['.zip'] } }],
          });
        }
        const out = await fileHandle.createWritable();
        await out.write(blob);
        await out.close();
        showToast(`Saved to ${fileHandle.name}`, 'success');
        return;
      } catch (err) {
        if (err?.name === 'AbortError') return;
        fileHandle = null;
        // Fall through to a download.
      }
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    URL.revokeObjectURL(a.href);
    showToast(`Downloaded ${name}`, 'success');
  }

  /** Read a .zip, .json or .md from disk into a new document. */
  async function openFile() {
    closeMenu();
    if (window.showOpenFilePicker) {
      try {
        const [handle] = await window.showOpenFilePicker({
          types: [
            {
              description: 'vLabs template',
              accept: {
                'application/zip': ['.zip'],
                'application/json': ['.json'],
                'text/markdown': ['.md', '.markdown', '.txt'],
              },
            },
          ],
        });
        await openPickedFile(await handle.getFile(), /\.zip$/i.test(handle.name) ? handle : null);
      } catch (err) {
        if (err?.name !== 'AbortError')
          showToast(`Could not open the file: ${err.message}`, 'error');
      }
      return;
    }
    const input = document.getElementById('docsFileInput');
    input.value = '';
    input.click();
  }

  async function openPickedFile(file, handle = null) {
    if (!file) return;
    loadedImportRawContent = '';
    loadedImportImages = [];
    await processImportedFile(file);
    if (!loadedImportRawContent) return;
    executeImport();
    // Save to file writes back to the package it came from.
    fileHandle = handle;
  }

  return {
    init,
    save,
    startNew,
    list,
    openDoc,
    deleteDoc,
    toggleMenu,
    closeMenu,
    saveToFile,
    openFile,
    openPickedFile,
  };
})();
