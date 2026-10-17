import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api.js';
import { useInstructorApi } from '../hooks/useInstructorApi.js';
import PortalShell from '../components/PortalShell.jsx';
import LabEditor from './LabEditor.jsx';
import ExamEditor from './ExamEditor.jsx';

/**
 * /instructor/templates/:id — loads the template and hands it to the editor
 * for its kind:
 *   new       → import a lab or exam from vLabs Template Studio
 *   new-lab   → build a new lab here
 *   new-exam  → author a new exam
 *   <id>      → LabEditor (typo fixes only) or ExamEditor
 */
export default function TemplateEditor() {
  const { id } = useParams();
  const { call } = useInstructorApi();
  const isNew = id === 'new' || id === 'new-lab' || id === 'new-exam';
  const [tpl, setTpl] = useState(null);
  const [error, setError] = useState('');

  useEffect(() => {
    if (isNew) return undefined;
    let cancelled = false;
    setTpl(null);
    call((t) => api.getTemplate(t, id))
      .then((t) => !cancelled && setTpl(t))
      .catch((err) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [call, id, isNew]);

  if (id === 'new') return <LabEditor key="new" id="new" />;
  if (id === 'new-lab') return <LabEditor key="new-lab" id="new-lab" />;
  if (id === 'new-exam') return <ExamEditor key="new-exam" id="new-exam" />;
  if (!tpl) {
    return (
      <PortalShell>
        {error ? <p className="form__error">{error}</p> : <p className="muted">Loading…</p>}
      </PortalShell>
    );
  }
  return tpl.kind === 'exam' ? (
    <ExamEditor key={tpl.id} id={id} initial={tpl} />
  ) : (
    <LabEditor key={tpl.id} id={id} initial={tpl} />
  );
}
