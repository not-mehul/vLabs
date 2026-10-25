import { formatDateTime } from '../../lib/datetime.js';
import Icon from '../Icon.jsx';

/* --------------------------- Change history ----------------------------- */

/**
 * The template's history, newest first. Each entry says what it changed
 * (worked out on the server, shared/template-history.js); revert loads that
 * version's snapshot.
 */
export default function ChangeHistory({ audit, onRevert }) {
  return (
    <ul className="audit__list">
      {audit.map((a) => (
        <li className="audit__item" key={a.id}>
          <div className="audit__row">
            <span className={`audit__action audit__action--${a.action}`}>{a.action}</span>
            {a.version != null && <span className="audit__ver">v{a.version}</span>}
            <span className="audit__who">{a.instructor_username}</span>
            <span className="audit__when muted">{formatDateTime(a.at)}</span>
            {onRevert && a.has_snapshot && a.action !== 'deleted' && (
              <button className="btn btn--xs btn--ghost audit__revert" onClick={() => onRevert(a)}>
                <Icon name="undo" size={13} /> Revert
              </button>
            )}
          </div>
          <ul className="audit__changes">
            {(a.changes || []).map((c, ci) => (
              <li key={ci}>{c}</li>
            ))}
          </ul>
        </li>
      ))}
    </ul>
  );
}
