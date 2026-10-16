import { LIMITS } from '../../../../shared/template-schema.js';

/**
 * Minutes allocated to a section (empty = no allocation). Time on a section is
 * judged against it in the session monitor.
 */
export default function MinutesField({ value, onChange, label = 'Time allocated (minutes)' }) {
  return (
    <label className="field field--compact field--minutes">
      <span className="field__label">{label}</span>
      <input
        className="field__input"
        type="number"
        min={1}
        max={LIMITS.sectionMinutes}
        step={1}
        inputMode="numeric"
        placeholder="none"
        value={value ?? ''}
        onChange={(e) => {
          const v = e.target.value.trim();
          onChange(v === '' ? null : Math.round(Number(v)));
        }}
      />
    </label>
  );
}
