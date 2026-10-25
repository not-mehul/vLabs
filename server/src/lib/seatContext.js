import { resolveVariables } from '../../../shared/templating.js';
import { log } from './logger.js';

/**
 * Placeholder values for one participant, never failing the seat on a
 * formula. Saving a template evaluates its formulas for seats 1–100
 * (shared/validate-template.js), but a seat changed by hand can go up to 999
 * and a formula may still fail there (`10 / (seat - 200)`). Such a variable
 * reads as ⟨error:NAME⟩ wherever it is used and is logged once, instead of
 * the participant's whole page failing.
 */

const reported = new Set();

function report(seat, name, err) {
  const key = `${seat}|${err.message}`;
  if (reported.has(key) || reported.size >= 1000) return;
  reported.add(key);
  log.warn('formula.failed', { seat, variable: name, error: err.message });
}

/**
 * @param {Array} variables the template's formulas
 * @param {number} seat
 * @param {object} [who] as resolveVariables: firstName, lastName, captured, images
 */
export function seatContext(variables, seat, who = {}) {
  return resolveVariables(variables || [], seat, {
    ...who,
    onError: (name, err) => report(seat, name, err),
  });
}
