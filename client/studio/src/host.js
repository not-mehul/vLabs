// Host bridge: the Studio as vLabs' template editor.
//
// vLabs opens the Studio in a same-origin frame at /studio/index.html?host=vlabs
// and talks to it with postMessage. The app keeps everything that needs the
// server (loading, saving, versions, change history, the image library); the
// Studio edits. Opened on its own (the offline file), none of this runs and
// the Studio keeps its drafts in the browser as before.
//
// App → Studio
//   load    { kind, template, images, kindLocked, reason }  show this template (none: a new one)
//   images  { images, note? }                               the library changed
//   theme   { dark }                                        follow the app's theme
//   saved   { version }                                     the app saved it
//   open-import                                            show the Import dialog
//   flush-save                                             reply with `save` (Save button)
// Studio → App
//   ready                                                  listening; send `load`
//   loaded  { kind, template, reason }                      what the Studio now shows
//   change  { kind, template }                              the template changed
//   save    { kind, template }                              save this (Ctrl+S or flush-save)
//   upload-images { files }                                 add to the library
//   delete-image  { name }                                  remove from the library
/** A data: URL as a File (no fetch: the app's CSP does not allow data: there). */
function dataUrlToFile(url, name) {
  const comma = url.indexOf(',');
  const header = url.slice(5, comma);
  const type = header.split(';')[0] || 'application/octet-stream';
  const body = url.slice(comma + 1);
  let bytes;
  if (/;base64/i.test(header)) {
    const bin = atob(body);
    bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  } else {
    bytes = new TextEncoder().encode(decodeURIComponent(body));
  }
  return new File([bytes], name, { type });
}

const studioHost = (() => {
  const embedded =
    window.parent !== window && new URLSearchParams(window.location.search).get('host') === 'vlabs';
  let kindLocked = null;
  let loaded = false;
  let changeTimer = null;
  let lastSent = '';

  const post = (type, data = {}) =>
    window.parent.postMessage({ source: 'vlabs-studio', type, ...data }, window.location.origin);

  /** The template as vLabs stores it. */
  function snapshot() {
    return { kind: isExamMode() ? 'exam' : 'lab', template: JSON.parse(generateCanonicalJson()) };
  }

  function sendChange() {
    clearTimeout(changeTimer);
    const snap = snapshot();
    const key = JSON.stringify(snap);
    if (key !== lastSent) {
      lastSent = key;
      post('change', snap);
    }
    return snap;
  }

  /** Called wherever the Studio would save its local draft. */
  function notifyChange() {
    if (!embedded || !loaded) return;
    clearTimeout(changeTimer);
    changeTimer = setTimeout(sendChange, 250);
  }

  function setImages(images) {
    templateData.images = (images || []).map(i => ({ name: i.name, url: i.url }));
    renderImagesGrid();
    updateBadges();
    if (currentView === 'preview') renderParticipantPreview();
    runFullValidation(false);
  }

  function load({ kind, template, images, kindLocked: locked, reason }) {
    kindLocked = locked || null;
    templateData = { images: [] };
    // No template: a new one, started like the Studio's own New Lab / New Exam.
    if (!template) templateData = kind === 'exam' ? createBlankExam() : createBlankTemplate();
    else templateData = kind === 'exam' ? studioExamFromCanonical(template) : studioLabFromCanonical(template);
    templateData.images = (images || []).map(i => ({ name: i.name, url: i.url }));
    historyStack = [];
    historyIndex = -1;
    resetPreviewSimulation(false);
    pushHistorySnapshot(true);
    refreshAllActiveViews();
    runFullValidation(false);
    autoGrowAllTextareas();
    loaded = true;
    const snap = snapshot();
    lastSent = JSON.stringify(snap);
    post('loaded', { ...snap, reason });
    if (reason === 'revert') sendChange();
  }

  function onMessage(event) {
    if (event.source !== window.parent || event.origin !== window.location.origin) return;
    const msg = event.data;
    if (!msg || msg.source !== 'vlabs-app') return;
    if (msg.type === 'load') load(msg);
    else if (msg.type === 'images') {
      setImages(msg.images);
      if (msg.note) showToast(msg.note, msg.tone || 'info');
    } else if (msg.type === 'theme') {
      document.documentElement.classList.toggle('dark', Boolean(msg.dark));
    } else if (msg.type === 'saved') {
      // Saved once, its kind is fixed (vLabs keeps a template's kind).
      kindLocked = isExamMode() ? 'exam' : 'lab';
      showToast(`Saved as v${msg.version}`, 'success');
    } else if (msg.type === 'flush-save') {
      post('save', sendChange());
    } else if (msg.type === 'open-import') {
      openImportModal();
    }
  }

  function start() {
    document.documentElement.dataset.studioHost = 'vlabs';
    window.addEventListener('message', onMessage);
    post('ready');
  }

  /** False (with a message) when the open template cannot become this kind. */
  function allowsKind(kind) {
    if (!embedded || !kindLocked || kind === kindLocked) return true;
    showToast(
      `This template is ${kindLocked === 'exam' ? 'an exam' : 'a lab'}, so it cannot become ${kind === 'exam' ? 'an exam' : 'a lab'}. Start one from Templates instead.`,
      'error'
    );
    return false;
  }

  /** Library images arriving with an imported package: the app uploads them. */
  function uploadDataUrlImages(images) {
    post('upload-images', { files: images.map(img => dataUrlToFile(img.url, img.name)) });
  }

  return {
    embedded,
    start,
    notifyChange,
    allowsKind,
    requestSave: () => post('save', sendChange()),
    uploadImages: (files) => post('upload-images', { files }),
    uploadDataUrlImages,
    deleteImage: (name) => post('delete-image', { name }),
  };
})();
