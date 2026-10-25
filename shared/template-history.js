/**
 * Template change history: what each version changed, in words, for the
 * editor's History panel. Computed on the server from the audit snapshots
 * (routes/templates.js) so the panel does not need every full snapshot.
 */

const itemCount = (content) =>
  (content || []).reduce((n, s) => n + (s.items || s.steps || s.questions || []).length, 0);

/** Human-readable summary of what changed between two snapshots. */
export function describeChanges(prev, curr) {
  if (!prev) return ['Initial version'];
  const changes = [];
  if (prev.title !== curr.title) changes.push(`Title changed to “${curr.title}”`);
  if (prev.description !== curr.description) changes.push('Description edited');
  if (JSON.stringify(prev.variables) !== JSON.stringify(curr.variables)) {
    changes.push(
      `Variables updated (${(prev.variables || []).length} → ${(curr.variables || []).length})`,
    );
  }
  const ps = prev.content || [];
  const cs = curr.content || [];
  if (ps.length !== cs.length) changes.push(`Sections ${ps.length} → ${cs.length}`);
  if (itemCount(ps) !== itemCount(cs)) changes.push(`Items ${itemCount(ps)} → ${itemCount(cs)}`);
  const n = Math.min(ps.length, cs.length);
  for (let i = 0; i < n; i += 1) {
    if (ps[i].title !== cs[i].title) changes.push(`Section ${i + 1} renamed to “${cs[i].title}”`);
    else if (JSON.stringify(ps[i]) !== JSON.stringify(cs[i])) {
      changes.push(`Section ${i + 1} edited`);
    }
  }
  return changes.length ? changes : ['No content changes'];
}

const LIFECYCLE_LABEL = {
  archived: 'Template archived',
  restored: 'Template restored',
  deleted: 'Template deleted',
};

/**
 * The change summary of every audit entry, newest first like the entries.
 * Content versions ("created" / "updated") are compared with the next older
 * content version.
 *
 * @param {Array<{ action: string, snapshot: object|null }>} entries newest first
 * @returns {string[][]}
 */
export function historyChanges(entries) {
  const versions = entries.filter(
    (e) => e.snapshot && (e.action === 'created' || e.action === 'updated'),
  );
  return entries.map((e) => {
    if (LIFECYCLE_LABEL[e.action]) return [LIFECYCLE_LABEL[e.action]];
    const i = versions.indexOf(e);
    return describeChanges(i >= 0 ? versions[i + 1]?.snapshot : null, e.snapshot || {});
  });
}
