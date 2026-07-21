import { resolveVariables } from './templating.js';

/**
 * Validate & normalise instructor-authored template payloads before they hit
 * the database. Returns a clean { title, description, content, variables }
 * object or throws an Error with a helpful message.
 */
export function validateTemplatePayload(payload) {
  const errors = [];
  const title = String(payload?.title || '').trim();
  if (!title) errors.push('Title is required');
  if (title.length > 200) errors.push('Title is too long (max 200 chars)');

  const description = String(payload?.description || '').trim().slice(0, 1000);

  // ---- Variables ---------------------------------------------------------
  const variables = [];
  const rawVars = Array.isArray(payload?.variables) ? payload.variables : [];
  for (const [i, v] of rawVars.entries()) {
    const name = String(v?.name || '').trim();
    if (!name) {
      errors.push(`Variable #${i + 1} is missing a name`);
      continue;
    }
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      errors.push(`Variable "${name}" has an invalid name`);
      continue;
    }
    variables.push({ name, expression: String(v?.expression ?? '').trim() });
  }
  // Validate that every formula parses for a sample seat.
  if (errors.length === 0) {
    try {
      resolveVariables(variables, 1);
    } catch (err) {
      errors.push(err.message);
    }
  }

  // ---- Steps -------------------------------------------------------------
  const content = [];
  const rawSteps = Array.isArray(payload?.content) ? payload.content : [];
  if (rawSteps.length === 0) errors.push('At least one step is required');
  for (const [i, s] of rawSteps.entries()) {
    const step = {
      type: s?.type === 'computer' ? 'computer' : 'desk',
      title: String(s?.title || '').trim().slice(0, 200),
      body: String(s?.body || ''),
      hints: [],
    };
    if (!step.body.trim()) errors.push(`Step ${i + 1} has an empty body`);

    const rawHints = Array.isArray(s?.hints) ? s.hints : [];
    for (const h of rawHints) {
      step.hints.push({
        label: String(h?.label || 'Hint').trim().slice(0, 120),
        text: String(h?.text || ''),
      });
    }

    if (s?.checkpoint && String(s.checkpoint.answer || '').trim()) {
      step.checkpoint = {
        prompt: String(s.checkpoint.prompt || 'Enter the value to continue')
          .trim()
          .slice(0, 300),
        placeholder: String(s.checkpoint.placeholder || '').trim().slice(0, 120),
        answer: String(s.checkpoint.answer).trim(),
      };
    }
    content.push(step);
  }

  if (errors.length) {
    const err = new Error(errors.join('; '));
    err.status = 400;
    throw err;
  }
  return { title, description, content, variables };
}
