import { LIMITS } from '../../../../shared/template-schema.js';

const part = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * A length of time typed as hours and minutes, stored as whole minutes.
 * Minutes past 59 carry into the hours. With `allowEmpty` (section time
 * allocations) clearing both boxes gives null ("none"); otherwise the value
 * is always a number. Used for section allocations (labs and exams) and for
 * the session length on the launcher.
 */
export default function DurationField({
  value,
  onChange,
  label = 'Time allocated',
  max = LIMITS.sectionMinutes,
  allowEmpty = true,
  compact = true,
}) {
  const set = value !== null && value !== undefined && value !== '';
  const total = set ? Number(value) || 0 : 0;
  const hours = set ? Math.floor(total / 60) : '';
  const minutes = set ? total % 60 : '';

  const update = (h, m) => {
    if (allowEmpty && h === '' && m === '') return onChange(null);
    const next = Math.min(part(h) * 60 + part(m), max);
    onChange(allowEmpty && next === 0 ? null : next);
  };

  return (
    <div
      className={`field ${compact ? 'field--compact' : ''} field--duration`}
      role="group"
      aria-label={label}
    >
      <span className="field__label">{label}</span>
      <span className="duration">
        <input
          className="field__input duration__input"
          type="number"
          min={0}
          max={Math.floor(max / 60)}
          step={1}
          inputMode="numeric"
          placeholder={allowEmpty ? '–' : '0'}
          value={hours}
          aria-label={`${label}: hours`}
          onChange={(e) => update(e.target.value.trim(), set ? String(minutes) : '')}
        />
        <span className="duration__unit">h</span>
        <input
          className="field__input duration__input"
          type="number"
          min={0}
          max={59}
          step={1}
          inputMode="numeric"
          placeholder={allowEmpty ? '–' : '0'}
          value={minutes}
          aria-label={`${label}: minutes`}
          onChange={(e) => update(set ? String(hours) : '', e.target.value.trim())}
        />
        <span className="duration__unit">min</span>
      </span>
    </div>
  );
}
