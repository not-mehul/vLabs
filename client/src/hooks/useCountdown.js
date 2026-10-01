import { useEffect, useState } from 'react';

/**
 * Live countdown label to an expiry timestamp, ticking once a second.
 * Shared by the participant Lab header and the instructor Session Monitor
 * (they previously had two diverging copies).
 *
 * @param {string|null|undefined} expiresAt ISO timestamp; falsy disables the timer.
 * @param {{ hours?: boolean }} [opts] `hours: true` renders "1h 05m" above an hour,
 *   otherwise minutes:seconds throughout.
 * @returns {string} label ('' when disabled, 'expired' when past)
 */
export function useCountdown(expiresAt, { hours = false } = {}) {
  const [label, setLabel] = useState('');
  useEffect(() => {
    if (!expiresAt) {
      setLabel('');
      return undefined;
    }
    const tick = () => {
      const ms = new Date(expiresAt).getTime() - Date.now();
      if (Number.isNaN(ms)) return setLabel('');
      if (ms <= 0) return setLabel('expired');
      const total = Math.floor(ms / 1000);
      const h = Math.floor(total / 3600);
      const m = Math.floor((total % 3600) / 60);
      const s = total % 60;
      if (hours && h > 0) return setLabel(`${h}h ${String(m).padStart(2, '0')}m`);
      return setLabel(`${h * 60 + m}:${String(s).padStart(2, '0')}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [expiresAt, hours]);
  return label;
}

/** Seconds remaining (or 0), for threshold logic such as a low-time warning. */
export function secondsUntil(expiresAt) {
  if (!expiresAt) return 0;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return Number.isNaN(ms) ? 0 : Math.max(0, Math.floor(ms / 1000));
}
