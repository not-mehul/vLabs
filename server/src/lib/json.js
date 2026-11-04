/**
 * JSON columns, read defensively. A missing, malformed or wrongly shaped
 * value reads as empty instead of failing the request: one corrupt row must
 * not break a whole monitor or a participant's page. Already-parsed values
 * of the right shape are returned as they are.
 */

function parse(value) {
  if (typeof value !== 'string' || !value) return undefined;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);

/** A JSON object column (`{}` when absent or not an object). */
export function jsonObject(value) {
  if (isPlainObject(value)) return value;
  const v = parse(value);
  return isPlainObject(v) ? v : {};
}

/** A JSON array column (`[]` when absent or not an array). */
export function jsonArray(value) {
  if (Array.isArray(value)) return value;
  const v = parse(value);
  return Array.isArray(v) ? v : [];
}
