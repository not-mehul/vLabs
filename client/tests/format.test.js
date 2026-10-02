/** CSV export builders (node:test, no DOM needed). */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { participantsToCsv, attemptsToCsv } from '../src/lib/format.js';

const doc = {
  sections: [
    { number: 1, title: 'Bench Preparation' },
    { number: 2, title: 'Network Configuration' },
  ],
  checkpoints: [
    { key: '0.3', step_title: 'Serial' },
    { key: '1.1', step_title: 'Verify' },
  ],
  participants: [
    {
      number: 1,
      name: 'Ada Lovelace',
      first_name: 'Ada',
      last_name: 'Lovelace',
      current_section: 2,
      sections_completed: 2,
      total_sections: 2,
      progress_pct: 100,
      checkpoints_cleared: 2,
      wrong_attempts: 1,
      hints_taken: 1,
      solutions_revealed: 0,
      complete: true,
      completed_at: '2026-10-02T09:40:12.000Z',
      finished: false,
      finished_at: null,
      total_seconds: 1234,
      joined_at: '2026-10-02T09:00:00.000Z',
      last_seen_at: '2026-10-02T09:41:00.000Z',
      captured: { SERIAL: 'ABCD.1234.WXYZ' },
      section_seconds: [600, 634],
      checkpoints: [
        {
          key: '0.3',
          cleared: true,
          accepted_answer: 'abcd1234wxyz',
          attempt_count: 2,
          wrong_attempts: [{ answer: '=ABCD.1234', at: '2026-10-02T09:10:00.000Z' }],
        },
        { key: '1.1', cleared: true, accepted_answer: '10.0.0.101/24', attempt_count: 1, wrong_attempts: [] },
      ],
      hints_opened: [{ section_number: 2, step_number: 2, step_title: 'Verify', hint_index: 1, label: 'How?' }],
      solutions_revealed_list: [],
    },
    {
      number: 2,
      name: 'Grace Hopper',
      first_name: 'Grace',
      last_name: 'Hopper',
      current_section: 1,
      sections_completed: 0,
      total_sections: 2,
      progress_pct: 0,
      checkpoints_cleared: 0,
      wrong_attempts: 0,
      hints_taken: 0,
      solutions_revealed: 0,
      complete: false,
      completed_at: null,
      finished: false,
      finished_at: null,
      total_seconds: 90,
      joined_at: '2026-10-02T09:30:00.000Z',
      last_seen_at: '2026-10-02T09:31:30.000Z',
      captured: { SERIAL: '' },
      section_seconds: [90, 0],
      checkpoints: [
        { key: '0.3', cleared: false, accepted_answer: null, attempt_count: 0, wrong_attempts: [] },
        { key: '1.1', cleared: false, accepted_answer: null, attempt_count: 0, wrong_attempts: [] },
      ],
      hints_opened: [],
      solutions_revealed_list: [],
    },
  ],
  attempts: [
    { at: '2026-10-02T09:10:00.000Z', number: 1, name: 'Ada Lovelace', checkpoint: '0.3', section_number: 1, step_number: 4, step_title: 'Serial', answer: '=ABCD.1234', correct: false },
    { at: '2026-10-02T09:12:00.000Z', number: 1, name: 'Ada Lovelace', checkpoint: '0.3', section_number: 1, step_number: 4, step_title: 'Serial', answer: 'abcd1234wxyz', correct: true },
  ],
};

test('participants CSV has uniform per-section and per-checkpoint columns', () => {
  const csv = participantsToCsv(doc);
  const [header, ada, grace] = csv.trim().split('\n');
  const cols = header.split(',');
  assert.ok(cols.includes('time_s1_bench_preparation'));
  assert.ok(cols.includes('time_s2_network_configuration'));
  for (const k of ['0.3', '1.1']) {
    for (const suffix of ['cleared', 'answer', 'attempts', 'wrong']) {
      assert.ok(cols.includes(`cp_${k}_${suffix}`), `cp_${k}_${suffix}`);
    }
  }
  assert.ok(cols.includes('captured_SERIAL'));
  assert.equal(cols.at(-2), 'hints_opened');
  assert.equal(cols.at(-1), 'solutions_revealed_list');
  // Same number of cells on every row.
  assert.equal(ada.split(',').length >= cols.length, true);
  const cell = (line, name) => {
    // naive split is fine here: the only quoted cell contains no comma
    const values = line.split(',');
    return values[cols.indexOf(name)];
  };
  assert.equal(cell(ada, 'status'), 'complete');
  assert.equal(cell(grace, 'status'), 'in progress');
  assert.equal(cell(ada, 'time_s1_bench_preparation'), '600');
  assert.equal(cell(ada, 'cp_0.3_cleared'), 'yes');
  assert.equal(cell(ada, 'cp_0.3_answer'), 'abcd1234wxyz');
  assert.equal(cell(ada, 'cp_0.3_attempts'), '2');
  // Formula injection neutralised on the wrong attempt that starts with "=".
  assert.equal(cell(ada, 'cp_0.3_wrong'), "'=ABCD.1234");
  assert.equal(cell(grace, 'cp_1.1_cleared'), 'no');
  assert.match(ada, /2\.2 Verify — How\?/);
});

test('attempts CSV is one row per submission with correct flag', () => {
  const csv = attemptsToCsv(doc);
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 3);
  assert.equal(lines[0], 'at,number,name,checkpoint,section_number,step_number,step_title,answer,correct');
  assert.match(lines[1], /'=ABCD\.1234,no$/);
  assert.match(lines[2], /abcd1234wxyz,yes$/);
  assert.equal(attemptsToCsv({}).trim().split('\n').length, 1, 'header only when empty');
});

test('legacy call with a plain rows array still works', () => {
  const csv = participantsToCsv(doc.participants);
  assert.match(csv.split('\n')[0], /^number,name/);
});
