import { useEffect } from 'react';

/**
 * Best-effort client-side IP protection for the participant lab view.
 *
 * These measures raise the effort required to exfiltrate lab content and pair
 * with the real server-side guarantees (no file downloads, progressive
 * delivery, rate limiting). They are deterrents, not cryptographic controls —
 * the authoritative protection is that the browser never receives locked steps
 * or checkpoint answers.
 *
 * Enable only while the lab view is mounted; cleaned up on unmount so the rest
 * of the app behaves normally.
 */
export function useContentProtection(enabled = true) {
  useEffect(() => {
    if (!enabled) return undefined;

    const block = (e) => e.preventDefault();
    const blockKeys = (e) => {
      const k = e.key.toLowerCase();
      // Block Save, Print, Select-All, and the raw copy/cut shortcuts.
      if ((e.ctrlKey || e.metaKey) && ['s', 'p', 'a', 'c', 'u'].includes(k)) {
        e.preventDefault();
      }
    };

    document.addEventListener('contextmenu', block);
    document.addEventListener('copy', block);
    document.addEventListener('cut', block);
    document.addEventListener('dragstart', block);
    document.addEventListener('keydown', blockKeys);
    document.body.classList.add('no-select');

    return () => {
      document.removeEventListener('contextmenu', block);
      document.removeEventListener('copy', block);
      document.removeEventListener('cut', block);
      document.removeEventListener('dragstart', block);
      document.removeEventListener('keydown', blockKeys);
      document.body.classList.remove('no-select');
    };
  }, [enabled]);
}
