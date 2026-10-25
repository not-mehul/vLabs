import { useEffect } from 'react';

/**
 * Run `task` now and then every `intervalMs` (the monitors' live views). A
 * tick is skipped while the tab is hidden, and the task runs again as soon as
 * the tab is shown; a tick is also skipped while the previous run is still in
 * flight, so a slow server never has one tab's requests piling up.
 *
 * `task` gets `isCurrent()`, false once the component has unmounted or `task`
 * has changed: a late answer for an old view can be dropped. A new `task`
 * (new dependencies) starts over with an immediate run. The task reports its
 * own errors.
 *
 * @param {(isCurrent: () => boolean) => Promise<void>} task stable (useCallback)
 * @param {number} intervalMs
 */
export function usePolling(task, intervalMs) {
  useEffect(() => {
    let stopped = false;
    let running = false;
    const isCurrent = () => !stopped;
    const tick = async () => {
      if (stopped || running || document.visibilityState === 'hidden') return;
      running = true;
      try {
        await task(isCurrent);
      } catch {
        /* the task shows its own errors */
      } finally {
        running = false;
      }
    };
    const onVisibility = () => {
      if (document.visibilityState === 'visible') tick();
    };
    tick();
    const timer = setInterval(tick, intervalMs);
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      stopped = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [task, intervalMs]);
}
