import test from 'node:test';
import assert from 'node:assert/strict';
import { parseUtc, secondsBetween } from '../src/lib/time.js';

test('parseUtc reads SQLite UTC timestamps as UTC', () => {
  // "YYYY-MM-DD HH:MM:SS" (no zone) is SQLite's UTC format.
  assert.equal(parseUtc('2026-01-02 03:04:05'), Date.UTC(2026, 0, 2, 3, 4, 5));
});

test('parseUtc treats a zone-less ISO timestamp as UTC, not local', () => {
  // The bug this guards: new Date('2026-01-02T03:04:05') is LOCAL time.
  assert.equal(parseUtc('2026-01-02T03:04:05'), Date.UTC(2026, 0, 2, 3, 4, 5));
});

test('parseUtc respects an explicit zone (Z or offset)', () => {
  assert.equal(parseUtc('2026-01-02T03:04:05Z'), Date.UTC(2026, 0, 2, 3, 4, 5));
  assert.equal(parseUtc('2026-01-02T03:04:05+00:00'), Date.UTC(2026, 0, 2, 3, 4, 5));
  // +02:00 means the instant is two hours earlier in UTC.
  assert.equal(parseUtc('2026-01-02T05:04:05+02:00'), Date.UTC(2026, 0, 2, 3, 4, 5));
});

test('parseUtc returns NaN for empty input', () => {
  assert.ok(Number.isNaN(parseUtc('')));
  assert.ok(Number.isNaN(parseUtc(null)));
});

test('secondsBetween is non-negative and mixes formats safely', () => {
  const a = '2026-01-02 03:04:05'; // SQLite UTC
  const b = '2026-01-02T03:04:15Z'; // ISO UTC, 10s later
  assert.equal(secondsBetween(a, b), 10);
  assert.equal(secondsBetween(b, a), 0); // clamped at 0, never negative
});
