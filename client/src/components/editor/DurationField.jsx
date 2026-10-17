const part = (v) => {
  const n = parseInt(v, 10);
  return Number.isInteger(n) && n > 0 ? n : 0;
};

/**
 * A session's length typed as hours and minutes, stored as whole minutes
 * (the launcher). Minutes past 59 carry into the hours. Section time
 * allocations in templates are plain minutes (set in Template Studio).
 */
export default function DurationField({ value, onChange, label = 'Runs for', max }) {
  const total = Number(value) || 0;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const update = (h, m) => onChange(Math.min(part(h) * 60 + part(m), max));

  return (
    <div className="field field--duration" role="group" aria-label={label}>
      <span className="field__label">{label}</span>
      <span className="duration">
        <input
          className="field__input duration__input"
          type="number"
          min={0}
          max={Math.floor(max / 60)}
          step={1}
          inputMode="numeric"
          placeholder="0"
          value={hours}
          aria-label={`${label}: hours`}
          onChange={(e) => update(e.target.value.trim(), String(minutes))}
        />
        <span className="duration__unit">h</span>
        <input
          className="field__input duration__input"
          type="number"
          min={0}
          max={59}
          step={1}
          inputMode="numeric"
          placeholder="0"
          value={minutes}
          aria-label={`${label}: minutes`}
          onChange={(e) => update(String(hours), e.target.value.trim())}
        />
        <span className="duration__unit">min</span>
      </span>
    </div>
  );
}
