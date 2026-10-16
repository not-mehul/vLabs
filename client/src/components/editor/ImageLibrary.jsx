import { useRef, useState } from 'react';
import { api } from '../../api.js';
import { useInstructorApi } from '../../hooks/useInstructorApi.js';
import { LIMITS } from '../../../../shared/template-schema.js';
import Icon from '../Icon.jsx';

/* ----------------------------- Image library ---------------------------- */

const fmtBytes = (n) =>
  n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.round(n / 1024)} kB`;

/**
 * Instance-wide image library. Markdown references an image by file name:
 * `![caption](rack.png)`. Uploads go straight to /api/images; an existing
 * name asks before being replaced. `missing` lists names the current draft
 * references that are not in the library yet (typically after a .md import).
 */
export default function ImageLibrary({ images, missing, onChange }) {
  const { call } = useInstructorApi();
  const fileRef = useRef(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState('');
  const [copied, setCopied] = useState('');

  async function uploadFiles(files) {
    if (!files.length) return;
    setBusy(true);
    const notes = [];
    for (const file of files) {
      try {
        try {
          const r = await call((tok) => api.uploadImage(tok, file));
          notes.push(`Uploaded ${r.name}`);
        } catch (err) {
          if (err.code === 'IMAGE_EXISTS') {
            if (
              window.confirm(
                `"${err.existing?.name || file.name}" already exists. Replace it everywhere it is used?`,
              )
            ) {
              const r = await call((tok) => api.uploadImage(tok, file, { replace: true }));
              notes.push(`Replaced ${r.name}`);
            } else {
              notes.push(`Skipped ${file.name}`);
            }
          } else {
            throw err;
          }
        }
      } catch (err) {
        notes.push(`${file.name}: ${err.message}`);
      }
    }
    setMsg(notes.join(' · '));
    setBusy(false);
    onChange();
    setTimeout(() => setMsg(''), 6000);
  }

  async function remove(img) {
    try {
      const refs = await call((tok) => api.imageReferences(tok, img.id));
      const used = [
        ...refs.templates.map((t) => `template "${t.title}"`),
        ...refs.sessions.map((x) => `active session "${x.title}"`),
      ];
      if (used.length) {
        window.alert(
          `"${img.name}" is still used by ${used.join(', ')}. Remove the references first.`,
        );
        return;
      }
      if (!window.confirm(`Delete "${img.name}" from the library?`)) return;
      await call((tok) => api.deleteImage(tok, img.id));
      onChange();
    } catch (err) {
      setMsg(err.message);
    }
  }

  async function copySnippet(img) {
    const snippet = `![${img.name.replace(/\.[^.]+$/, '')}](${img.name})`;
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(img.id);
      setTimeout(() => setCopied(''), 1500);
    } catch {
      window.prompt('Copy this Markdown:', snippet);
    }
  }

  return (
    <section
      className="editor-section"
      onDragOver={(e) => {
        e.preventDefault();
      }}
      onDrop={(e) => {
        e.preventDefault();
        uploadFiles([...e.dataTransfer.files].filter((f) => f.type.startsWith('image/')));
      }}
    >
      <div className="editor-section__head">
        <h3>
          <Icon name="image" size={16} /> Images
        </h3>
        <button
          type="button"
          className="btn btn--sm btn--ghost"
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <Icon name="upload" size={15} /> {busy ? 'Uploading…' : 'Upload images'}
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/png,image/jpeg,image/gif,image/webp"
          multiple
          hidden
          onChange={(e) => {
            uploadFiles([...e.target.files]);
            e.target.value = '';
          }}
        />
      </div>
      <p className="muted small">
        PNG, JPEG, GIF or WebP up to {fmtBytes(LIMITS.imageBytes)} each. Reference an image by its
        file name in any step body, hint or solution: <code>{'![caption](rack.png)'}</code>. The
        library is shared by every template on this instance; replacing a file updates it
        everywhere. Drag files anywhere onto this panel to upload.
      </p>
      {missing.length > 0 && (
        <div className="banner banner--warn" role="status">
          <span>
            <strong>
              {missing.length} referenced image{missing.length > 1 ? 's are' : ' is'} not in the
              library:
            </strong>{' '}
            {missing.map((m, i) => (
              <span key={m.name}>
                <code>{m.name}</code> <span className="muted">({m.where})</span>
                {i < missing.length - 1 ? ', ' : ''}
              </span>
            ))}
            . Upload files with exactly these names (folders are ignored) — saving is refused until
            every referenced image exists.
          </span>
          <button
            type="button"
            className="btn btn--sm btn--primary"
            onClick={() => fileRef.current?.click()}
          >
            <Icon name="upload" size={15} /> Upload missing
          </button>
        </div>
      )}
      {msg && <p className="muted small io-bar__msg">{msg}</p>}
      {images.length === 0 ? (
        <p className="muted small">No images uploaded yet.</p>
      ) : (
        <ul className="imglib">
          {images.map((img) => (
            <li className="imglib__item" key={img.id}>
              <a href={img.url} target="_blank" rel="noreferrer" className="imglib__thumb">
                <img src={img.url} alt={img.name} loading="lazy" />
              </a>
              <div className="imglib__meta">
                <code className="imglib__name" title={img.name}>
                  {img.name}
                </code>
                <span className="muted small">
                  {fmtBytes(img.size)}
                  {img.width && img.height ? ` · ${img.width}×${img.height}` : ''}
                </span>
              </div>
              <div className="imglib__actions">
                <button
                  type="button"
                  className="btn btn--xs btn--ghost"
                  onClick={() => copySnippet(img)}
                  title="Copy Markdown snippet"
                >
                  <Icon name={copied === img.id ? 'check' : 'copy'} size={13} />{' '}
                  {copied === img.id ? 'Copied' : 'Markdown'}
                </button>
                <button
                  type="button"
                  className="btn btn--xs btn--icon btn--danger-ghost"
                  onClick={() => remove(img)}
                  aria-label={`Delete ${img.name}`}
                >
                  <Icon name="trash" size={13} />
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

