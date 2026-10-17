import { formatDateTime } from '../../lib/datetime.js';
import Icon from '../Icon.jsx';

/* --------------------------- Change history ----------------------------- */

const stepsOf = (content) =>
  (content || []).reduce((n, s) => n + (s.items || s.steps || s.questions || []).length, 0);

/** Human-readable summary of what changed between two snapshots. */
function describeChanges(prev, curr) {
  if (!prev) return ['Initial version'];
  const changes = [];
  if (prev.title !== curr.title) changes.push(`Title changed to “${curr.title}”`);
  if (prev.description !== curr.description) changes.push('Description edited');
  if (JSON.stringify(prev.variables) !== JSON.stringify(curr.variables)) {
    changes.push(
      `Variables updated (${(prev.variables || []).length} → ${(curr.variables || []).length})`,
    );
  }
  const ps = prev.content || [];
  const cs = curr.content || [];
  if (ps.length !== cs.length) changes.push(`Sections ${ps.length} → ${cs.length}`);
  if (stepsOf(ps) !== stepsOf(cs)) changes.push(`Items ${stepsOf(ps)} → ${stepsOf(cs)}`);
  const n = Math.min(ps.length, cs.length);
  for (let i = 0; i < n; i += 1) {
    if (ps[i].title !== cs[i].title) changes.push(`Section ${i + 1} renamed to “${cs[i].title}”`);
    else if (JSON.stringify(ps[i]) !== JSON.stringify(cs[i]))
      changes.push(`Section ${i + 1} edited`);
  }
  return changes.length ? changes : ['No content changes'];
}

const LIFECYCLE_LABEL = {
  archived: 'Template archived',
  restored: 'Template restored',
  deleted: 'Template deleted',
};

export default function ChangeHistory({ audit, onRevert }) {
  // Only content versions ("created"/"updated") participate in diffing.
  const versions = audit.filter(
    (a) => a.snapshot && (a.action === 'created' || a.action === 'updated'),
  );
  return (
    <ul className="audit__list">
      {audit.map((a) => {
        let changes;
        if (LIFECYCLE_LABEL[a.action]) {
          changes = [LIFECYCLE_LABEL[a.action]];
        } else {
          const idx = versions.indexOf(a);
          const prev = idx >= 0 ? versions[idx + 1]?.snapshot : null; // the older version
          changes = describeChanges(prev, a.snapshot || {});
        }
        return (
          <li className="audit__item" key={a.id}>
            <div className="audit__row">
              <span className={`audit__action audit__action--${a.action}`}>{a.action}</span>
              {a.version != null && <span className="audit__ver">v{a.version}</span>}
              <span className="audit__who">{a.instructor_username}</span>
              <span className="audit__when muted">{formatDateTime(a.at)}</span>
              {onRevert && a.snapshot && a.action !== 'deleted' && (
                <button
                  className="btn btn--xs btn--ghost audit__revert"
                  onClick={() => onRevert(a)}
                >
                  <Icon name="undo" size={13} /> Revert
                </button>
              )}
            </div>
            <ul className="audit__changes">
              {changes.map((c, ci) => (
                <li key={ci}>{c}</li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
