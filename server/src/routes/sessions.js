import { Router } from 'express';
import crypto from 'node:crypto';
import db from '../db/index.js';
import { requireInstructor } from '../middleware/auth.js';
import { asyncHandler, httpError } from '../middleware/errorHandler.js';
import { isoInMinutes, nowIso, secondsBetween, parseUtc } from '../lib/time.js';
import {
  isSectionCleared,
  stepHasCheckpoint,
  checkpointMode,
  checkpointKey,
  checkpointAnswer,
  computeUnlockedSection,
  isStepReachable,
  matchCheckpoint,
  resolveVariables,
  injectImages,
} from '../../../shared/templating.js';
import { imageUrlMap } from '../lib/images.js';
import { labProgress } from '../lib/labProgress.js';
import {
  breaksOf,
  currentBreak,
  totalBreakSeconds,
  activeSecondsBetween,
  sectionSecondsView,
  sectionAverages,
  timeStatus,
  allocatedSeconds,
} from '../lib/sectionTiming.js';
import {
  examParticipantView,
  examParticipantDetail,
  examQuestionStats,
  examQuestionResponses,
  gradeParticipant,
  parseObject,
  parseArray,
  sessionAnswerLog,
} from '../lib/examGrading.js';
import {
  listQuestions,
  totalPoints,
  describeExpected,
  sectionItems,
  isQuestion,
  isSubmitSection,
  isValidMarkPoints,
} from '../../../shared/exam-schema.js';
import { isOptionalSection } from '../../../shared/lab-progress.js';
import {
  sweepExpiredSessions,
  snapshotTemplateIntoSession,
  collectExamSubmissions,
} from '../lib/sessionLifecycle.js';
import { sectionTimeDetail, labStepStats } from '../lib/sectionDetail.js';
import {
  MAX_SEAT_NUMBER,
  checkSeatSource,
  labSeatMap,
  seatHolder,
  seatSourceSummary,
} from '../lib/seatSource.js';
import { log } from '../lib/logger.js';

const router = Router();
router.use(requireInstructor);

/** Session length when the launcher sends none, in minutes. */
export const DEFAULT_SESSION_MINUTES = Object.freeze({ lab: 8 * 60, exam: 60 });

const q = {
  codeClash: db.prepare('SELECT 1 FROM sessions WHERE room_code = ? AND is_active = 1'),
  template: db.prepare('SELECT * FROM templates WHERE id = ?'),
  insert: db.prepare(
    `INSERT INTO sessions
       (room_code, title, kind, template_id, instructor_id, template_version, template_title,
        content, variables, is_active, expires_at, seat_source_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
  ),
  byId: db.prepare('SELECT * FROM sessions WHERE id = ?'),
  // LEFT JOIN: the master template may have been archived or deleted since;
  // the session's own copy is authoritative for content and title.
  // Any instructor may READ any session (shared monitors, read-only); only
  // the instructor who launched it may change it (ownedOr404).
  detail: db.prepare(
    `SELECT s.*, t.version AS latest_template_version, t.archived_at AS template_archived_at,
            t.title AS latest_template_title, i.username AS owner_username
       FROM sessions s LEFT JOIN templates t ON t.id = s.template_id
       LEFT JOIN instructors i ON i.id = s.instructor_id
      WHERE s.id = ?`,
  ),
  list: db.prepare(
    `SELECT s.id, s.room_code, s.title, s.kind, s.template_id, s.template_title, s.template_version,
            s.is_active, s.expires_at, s.created_at, s.ended_at, s.instructor_id,
            t.version AS latest_template_version, i.username AS owner_username,
            (SELECT COUNT(*) FROM participants p WHERE p.session_id = s.id) AS participant_count
       FROM sessions s LEFT JOIN templates t ON t.id = s.template_id
       LEFT JOIN instructors i ON i.id = s.instructor_id
      WHERE (? = 1 OR s.instructor_id = ?)
      ORDER BY s.created_at DESC`,
  ),
  participants: db.prepare('SELECT * FROM participants WHERE session_id = ? ORDER BY seat_number'),
  participant: db.prepare('SELECT * FROM participants WHERE id = ? AND session_id = ?'),
  terminate: db.prepare('UPDATE sessions SET is_active = 0, ended_at = ? WHERE id = ?'),
  extend: db.prepare('UPDATE sessions SET expires_at = ? WHERE id = ?'),
  remove: db.prepare('DELETE FROM sessions WHERE id = ?'),
  setGrades: db.prepare('UPDATE participants SET grades = ? WHERE id = ?'),
  setBreaks: db.prepare('UPDATE sessions SET breaks = ? WHERE id = ?'),
  removeParticipant: db.prepare('DELETE FROM participants WHERE id = ? AND session_id = ?'),
  setSeat: db.prepare('UPDATE participants SET seat_number = ? WHERE id = ?'),
  setCheckpoints: db.prepare(
    `UPDATE participants SET completed_checkpoints = ?, captured_values = ?, checkpoint_log = ?
      WHERE id = ?`,
  ),
  complete: db.prepare(
    `UPDATE participants SET completed_at = ?, section_times = ?
      WHERE id = ? AND completed_at IS NULL`,
  ),
  // Unbinds the exam seat from its device and signs that device out; the next
  // join with the same name (on any device) takes the seat over.
  releaseSeat: db.prepare(
    'UPDATE participants SET resume_hash = NULL, token_version = token_version + 1 WHERE id = ?',
  ),
  // Reopening restarts the section clock now (time while submitted doesn't count).
  reopenExam: db.prepare(
    `UPDATE participants SET submitted_at = NULL, completed_at = NULL, finished_at = NULL,
            auto_submitted = 0, section_entered_at = ? WHERE id = ?`,
  ),
};

/** The participant :pid of an owned session, or 404. */
function participantOr404(req, row) {
  const pid = Number(req.params.pid);
  const p = Number.isInteger(pid) ? q.participant.get(pid, row.id) : null;
  if (!p) throw httpError(404, 'Participant not found');
  return p;
}

const isExam = (row) => row.kind === 'exam';

/** The seat this participant had in the linked lab: a number, null (not in it), or undefined (no link). */
const labSeatOf = (labSeats, p) => (labSeats ? (labSeats.get(p.name_key) ?? null) : undefined);

/** Resolve library image names in exam prompts/options for the instructor's view. */
function withImages(question) {
  const images = imageUrlMap();
  return {
    ...question,
    prompt: injectImages(question.prompt, images),
    options: (question.options || []).map((o) => injectImages(o, images)),
  };
}

/** Generate a 6-digit code not currently used by an active session. */
function generateRoomCode() {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0');
    if (!q.codeClash.get(code)) return code;
  }
  throw httpError(503, 'Unable to allocate a room code, please retry');
}

/** Live status derived from is_active + expiry. */
function sessionStatus(row) {
  if (!row.is_active) return 'ended';
  if (parseUtc(row.expires_at) < Date.now()) return 'expired';
  return 'active';
}

/** Parse and validate a numeric :id param. */
function idParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw httpError(404, 'Session not found');
  return id;
}

/** A session's per-seat variable formulas (exams resolve them per participant). */
const variablesOf = (row) => parseArray(row.variables);

/** Any session, for reading (every instructor can open any monitor), or 404. */
function viewableOr404(req) {
  const row = q.detail.get(idParam(req));
  if (!row) throw httpError(404, 'Session not found');
  return row;
}

/** A session the caller launched, for changing it; 403 for someone else's. */
function ownedOr404(req) {
  const row = viewableOr404(req);
  if (row.instructor_id !== req.instructor.id) {
    throw httpError(
      403,
      `Only ${row.owner_username || 'the instructor who launched it'} can change this session`,
      'NOT_SESSION_OWNER',
    );
  }
  return row;
}

/** Parse a JSON object column defensively. */
function safeObject(json) {
  try {
    const v = JSON.parse(json || '{}');
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

/** Names captured by pattern checkpoints, in template order. */
function captureNamesOf(sections) {
  const out = [];
  for (const s of sections) {
    for (const step of s.steps || []) {
      const c = step.checkpoint?.capture;
      if (c && !out.includes(c)) out.push(c);
    }
  }
  return out;
}

/**
 * Per-section flow for the monitor (labs and exams): seats whose furthest
 * section this is, seats that have completed it, the time allocated, and the
 * average time spent by those who completed it (`final` once everyone has).
 */
function sectionFlow(sections, views, extra = () => ({})) {
  const averages = sectionAverages(sections, views);
  return sections.map((sec, i) => ({
    index: i,
    title: sec.title || `Section ${i + 1}`,
    minutes: sec.minutes || null,
    // Seats whose furthest section is this one (finished seats are counted under `complete`).
    seats_here: views.filter((v) => !v.complete && v.furthest_section === i).length,
    // Seats that have completed this section. Finishing the lab or submitting
    // the exam does not complete a section the participant left undone (an
    // optional one, say).
    seats_past: views.filter((v) => v.sections_done[i]).length,
    ...averages[i],
    ...extra(sec, i),
  }));
}

/** Break state of a session for API responses. */
function breakView(row) {
  const breaks = breaksOf(row);
  const running = currentBreak(breaks);
  return {
    on_break: Boolean(running),
    break_started_at: running ? running.start : null,
    break_total_seconds: totalBreakSeconds(breaks),
  };
}

/**
 * Build the analytics view for one LAB participant.
 *
 * The monitor tracks each seat by its FURTHEST section (a monotonic high-water
 * mark): a participant who goes back to review an earlier section is still
 * shown where they got to, and sections they moved past stay completed. Their
 * exact current location (current_section / reviewing) is still reported, and
 * the participant drawer shows it. Optional / wrap-up sections are flagged and
 * excluded from progress (see lib/labProgress.js).
 */
function participantView(p, sections, breaks = []) {
  const now = nowIso();
  const completed = new Set(JSON.parse(p.completed_checkpoints));
  const sectionCount = sections.length;
  const progress = labProgress(sections, p, completed);
  // "Complete" is recorded server-side the moment the lab is cleared, so a
  // participant who keeps reviewing (never presses Finish) still counts and
  // their clock stays stopped. Rows from before migration 4 fall back to the
  // computed state.
  const complete = progress.complete;
  const completedAt = p.completed_at || (complete ? p.finished_at || null : null);
  const finished = Boolean(p.finished_at);
  const secondsSinceSeen = secondsBetween(p.last_seen_at, now);
  const clockEnd = completedAt || (complete ? now : null);
  // Time on sections excludes class breaks; once complete the clock is frozen.
  const sectionSeconds = sectionSecondsView(p, sectionCount, {
    now,
    breaks,
    frozen: Boolean(p.completed_at),
  });
  const onFurthest = complete ? 0 : sectionSeconds[progress.furthest] || 0;
  const allocated = allocatedSeconds(sections[progress.furthest]);
  return {
    id: p.id,
    seat_number: p.seat_number,
    first_name: p.first_name,
    last_name: p.last_name,
    name: `${p.first_name} ${p.last_name}`.trim(),
    // Where they got to (what the monitor shows)…
    furthest_section: progress.furthest,
    // …and exactly where they are right now (participant drawer only).
    current_section: p.current_section,
    reviewing: !complete && p.current_section < progress.furthest,
    max_section: p.max_section,
    completed_sections: progress.completedCounting,
    counting_sections: progress.countingTotal,
    sections_done: progress.done,
    completed_checkpoints: [...completed],
    captured: safeObject(p.captured_values),
    hints_taken: JSON.parse(p.hints_taken || '[]').length,
    solutions_revealed: JSON.parse(p.revealed_solutions || '[]').length,
    wrong_attempts: (safeArray(p.checkpoint_log) || []).filter((e) => !e.ok).length,
    complete,
    completed_at: completedAt,
    finished,
    finished_at: p.finished_at,
    status: complete ? 'finished' : secondsSinceSeen < 90 ? 'active' : 'idle',
    seconds_on_current_section: complete
      ? 0
      : activeSecondsBetween(p.section_entered_at, now, breaks),
    // Accumulated time on the furthest section (all visits, incl. the open one).
    seconds_on_furthest_section: onFurthest,
    // Judged against the section's allocated minutes (fallback thresholds when unset).
    allocated_seconds: allocated,
    time_status: complete ? 'ok' : timeStatus(onFurthest, allocated),
    total_seconds: activeSecondsBetween(p.joined_at, clockEnd || now, breaks),
    section_seconds: sectionSeconds,
    progress_pct: progress.progressPct,
    joined_at: p.joined_at,
    last_seen_at: p.last_seen_at,
    seconds_since_seen: secondsSinceSeen,
  };
}

function safeArray(json) {
  try {
    const v = JSON.parse(json || '[]');
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

/**
 * Everything the instructor's per-participant drawer needs, resolved against
 * the session's own copy of the manual so titles/labels are right even if the
 * master template changed since. Answers are shown as typed; the authored
 * expected answers are NOT included (they are per-seat secrets and the
 * instructor can open the template).
 */
function participantDetail(p, sections, breaks = []) {
  const view = participantView(p, sections, breaks);
  const stepTitle = (si, sti) => {
    const sec = sections[si];
    const step = sec?.steps?.[sti];
    return {
      section_index: si,
      step_index: sti,
      section_title: sec?.title || `Section ${si + 1}`,
      step_title: step?.title || `Step ${sti + 1}`,
    };
  };
  const parseKey = (k) =>
    String(k)
      .split('.')
      .map((n) => parseInt(n, 10));

  // Checkpoints in manual order with their attempts.
  const log = safeArray(p.checkpoint_log);
  const completedSet = new Set(view.completed_checkpoints);
  const checkpoints = [];
  sections.forEach((sec, si) => {
    (sec.steps || []).forEach((step, sti) => {
      if (!stepHasCheckpoint(step)) return;
      const key = `${si}.${sti}`;
      const attempts = log
        .filter((e) => e.k === key)
        .map((e) => ({ answer: e.a, correct: Boolean(e.ok), at: e.at, by: e.by || null }));
      const accepted = attempts.find((a) => a.correct);
      const cleared = view.completed_checkpoints.includes(key);
      checkpoints.push({
        key,
        ...stepTitle(si, sti),
        prompt: step.checkpoint.prompt || 'Enter the value to continue',
        mode: checkpointMode(step),
        capture: step.checkpoint.capture || null,
        cleared,
        cleared_at: accepted?.at || null,
        // Set when an instructor unlocked it for the participant.
        cleared_by: accepted?.by || null,
        // The checkpoint the participant can see but has not passed yet.
        can_unlock: !cleared && isStepReachable(sections, si, sti, completedSet),
        accepted_answer:
          accepted?.answer ??
          (step.checkpoint.capture ? (view.captured[step.checkpoint.capture] ?? null) : null),
        wrong_attempts: attempts.filter((a) => !a.correct),
        attempt_count: attempts.length,
      });
    });
  });

  const hints = safeArray(p.hints_taken).map((k) => {
    const [si, sti, hi] = parseKey(k);
    const label = sections[si]?.steps?.[sti]?.hints?.[hi]?.label || `Hint ${hi + 1}`;
    return { key: k, ...stepTitle(si, sti), hint_index: hi, label };
  });
  const solutions = safeArray(p.revealed_solutions).map((k) => {
    const [si, sti] = parseKey(k);
    return { key: k, ...stepTitle(si, sti) };
  });
  const sectionTimes = sections.map((sec, i) => ({
    index: i,
    title: sec.title || `Section ${i + 1}`,
    seconds: view.section_seconds[i] || 0,
    minutes: sec.minutes || null,
    // Exact location: the section on screen right now (even when reviewing).
    current: !view.complete && p.current_section === i,
    furthest: i === view.furthest_section,
    optional: isOptionalSection(sec),
    done: view.sections_done[i],
    cleared: isSectionCleared(sec, i, new Set(view.completed_checkpoints)),
  }));

  return { ...view, checkpoints, hints, solutions, section_times: sectionTimes };
}

/** Common session summary fields. */
function summarise(row, viewerId) {
  return {
    id: row.id,
    owner: row.owner_username ?? null,
    // False on a colleague's session: the monitor is read-only.
    can_manage: row.instructor_id === viewerId,
    room_code: row.room_code,
    title: row.title,
    kind: isExam(row) ? 'exam' : 'lab',
    template_id: row.template_id,
    template_title: row.template_title,
    template_version: row.template_version,
    latest_template_version: row.latest_template_version ?? null,
    update_available:
      row.latest_template_version != null && row.latest_template_version > row.template_version,
    status: sessionStatus(row),
    expires_at: row.expires_at,
    created_at: row.created_at,
    ended_at: row.ended_at,
    // Lets the monitor's countdown correct for the instructor device's clock.
    server_time: nowIso(),
  };
}

/**
 * POST /api/sessions — create a live class.
 * The template's current title/content/variables are COPIED into the session
 * (frozen at launch). Archived templates cannot be launched.
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    sweepExpiredSessions();
    const templateId = Number(req.body?.template_id);
    const title = String(req.body?.title || '')
      .trim()
      .slice(0, 200);

    const template = Number.isInteger(templateId) ? q.template.get(templateId) : null;
    if (!template) throw httpError(400, 'template_id does not reference a template');
    if (template.archived_at)
      throw httpError(409, 'This template is archived — restore it to launch a session');

    const exam = template.kind === 'exam';
    // Default length: a lab day (8 h) or an exam hour.
    const fallback = DEFAULT_SESSION_MINUTES[exam ? 'exam' : 'lab'];
    const durationMinutes = Math.min(
      Math.max(parseInt(req.body?.duration_minutes ?? fallback, 10) || fallback, 5),
      24 * 60,
    );

    // Optional: reuse the seat numbers of one of the instructor's labs (an exam
    // after a lab, or day two of a multi-day lab).
    const seatSource = checkSeatSource(req.body?.seat_source_session_id, req.instructor.id);

    const roomCode = generateRoomCode();
    const info = q.insert.run(
      roomCode,
      title || template.title,
      exam ? 'exam' : 'lab',
      template.id,
      req.instructor.id,
      template.version,
      template.title,
      template.content,
      template.variables,
      isoInMinutes(durationMinutes),
      seatSource,
    );

    const row = q.detail.get(info.lastInsertRowid);
    log.info('session.created', {
      session: row.id,
      template: template.id,
      instructor: req.instructor.id,
      seat_source: seatSource,
    });
    res.status(201).json(summarise(row, req.instructor.id));
  }),
);

/** GET /api/sessions — list this instructor's sessions with live counts. */
router.get('/', (req, res) => {
  sweepExpiredSessions();
  const all = req.query.scope === 'all' ? 1 : 0;
  const rows = q.list.all(all, req.instructor.id);
  res.json(
    rows.map((r) => ({
      ...summarise(r, req.instructor.id),
      participant_count: r.participant_count,
    })),
  );
});

/**
 * GET /api/sessions/:id/participants/:pid — one participant in depth:
 * checkpoints with accepted answer + wrong attempts, hints opened, solutions
 * revealed, time per section, captured values.
 */
router.get('/:id/participants/:pid', (req, res) => {
  const row = viewableOr404(req);
  const pid = Number(req.params.pid);
  const p = Number.isInteger(pid) ? q.participant.get(pid, row.id) : null;
  if (!p) throw httpError(404, 'Participant not found');
  const content = JSON.parse(row.content);
  if (!isExam(row)) {
    return res.json({
      ...participantDetail(p, content, breaksOf(row)),
      lab_seat: labSeatOf(labSeatMap(row), p),
    });
  }
  const detail = examParticipantDetail(p, content, breaksOf(row), variablesOf(row));
  res.json({
    ...detail,
    lab_seat: labSeatOf(labSeatMap(row), p),
    questions: detail.questions.map(withImages),
  });
});

/**
 * PUT /api/sessions/:id/participants/:pid/seat — body { seat_number }. Gives
 * the participant another seat number (a typo or a name clash kept them from
 * their lab seat). Refused when someone else holds that number. Their exam or
 * manual, its checks and the marking use the new seat's values at once,
 * because all are worked out from the seat whenever they are read; answers
 * and checkpoints already given are kept as they are.
 */
router.put('/:id/participants/:pid/seat', (req, res) => {
  const row = ownedOr404(req);
  const p = participantOr404(req, row);
  const seat = Number(req.body?.seat_number);
  if (!Number.isInteger(seat) || seat < 1 || seat > MAX_SEAT_NUMBER) {
    throw httpError(400, `Seat must be a whole number from 1 to ${MAX_SEAT_NUMBER}`);
  }
  if (seat !== p.seat_number) {
    const holder = seatHolder(row.id, seat);
    if (holder) {
      throw httpError(
        409,
        `Seat ${seat} is taken by ${`${holder.first_name} ${holder.last_name}`.trim()}`,
        'SEAT_IN_USE',
      );
    }
    q.setSeat.run(seat, p.id);
    log.info('participant.seat.changed', {
      session: row.id,
      participant: p.id,
      from: p.seat_number,
      to: seat,
      instructor: req.instructor.id,
    });
  }
  res.json({ seat_number: seat });
});

/**
 * POST /api/sessions/:id/participants/:pid/checkpoints/:key/unlock — LAB
 * sessions: clear a checkpoint for a participant who is stuck on it
 * (instructor only; participants can never skip a checkpoint). Only the
 * checkpoint the participant can currently see, while the session is live.
 * Body { value } is needed when the checkpoint saves a pattern answer as a
 * variable (later steps show it); an exact checkpoint saves the seat's own
 * expected answer. Logged as an accepted attempt marked with the instructor.
 */
router.post('/:id/participants/:pid/checkpoints/:key/unlock', (req, res) => {
  const row = ownedOr404(req);
  if (isExam(row)) throw httpError(409, 'Only lab checkpoints can be unlocked');
  if (sessionStatus(row) !== 'active') throw httpError(409, 'The session is not active');
  const p = participantOr404(req, row);
  const sections = JSON.parse(row.content);
  const [si, sti] = String(req.params.key)
    .split('.')
    .map((n) => (/^\d+$/.test(n) ? Number(n) : NaN));
  const step = sections[si]?.steps?.[sti];
  if (!step || !stepHasCheckpoint(step)) throw httpError(404, 'Checkpoint not found');
  const key = checkpointKey(si, sti);
  const completed = new Set(JSON.parse(p.completed_checkpoints || '[]'));
  if (completed.has(key)) return res.json({ ok: true, already: true });
  if (
    si > computeUnlockedSection(sections, completed) ||
    !isStepReachable(sections, si, sti, completed)
  ) {
    throw httpError(409, 'The participant has not reached this checkpoint yet');
  }

  const captured = safeObject(p.captured_values);
  const capture = step.checkpoint.capture || null;
  let value = null;
  if (capture) {
    const context = resolveVariables(variablesOf(row), p.seat_number, {
      firstName: p.first_name,
      lastName: p.last_name,
      captured,
    });
    if (checkpointMode(step) === 'pattern') {
      const typed = typeof req.body?.value === 'string' ? req.body.value : '';
      const match = matchCheckpoint(step, context, typed);
      if (!match.ok) {
        throw httpError(
          400,
          `This checkpoint saves the answer as {{ ${capture} }}: enter a value in the expected format`,
          'VALUE_REQUIRED',
        );
      }
      value = match.value;
    } else {
      value = checkpointAnswer(step, context);
    }
    if (value !== null) captured[capture] = value;
  }

  const now = nowIso();
  const entries = safeArray(p.checkpoint_log);
  entries.push({ k: key, a: value ?? '', ok: 1, at: now, by: req.instructor.username });
  completed.add(key);
  q.setCheckpoints.run(
    JSON.stringify([...completed]),
    JSON.stringify(captured),
    JSON.stringify(entries.slice(-200)),
    p.id,
  );
  // Clearing the last checkpoint completes the lab, as it would for the participant.
  if (!p.completed_at && labProgress(sections, p, completed).complete) {
    const times = safeObject(p.section_times);
    const k = String(p.current_section);
    times[k] =
      (Number(times[k]) || 0) + activeSecondsBetween(p.section_entered_at, now, breaksOf(row));
    q.complete.run(now, JSON.stringify(times), p.id);
  }
  log.info('checkpoint.unlocked', {
    session: row.id,
    participant: p.id,
    section: si,
    step: sti,
    instructor: req.instructor.id,
  });
  res.json({ ok: true });
});

/**
 * PUT /api/sessions/:id/participants/:pid/marks/:key — EXAM sessions only.
 * Body (any of): { correct: true | false | null, points: N | null,
 * comment: string | null }. `correct` marks the response correct or incorrect
 * by hand (overriding the automatic verdict); `points` gives part of the
 * question's points instead (0 … its points, halves allowed); null clears
 * either and falls back to the automatic verdict. `comment` is the marker's
 * note (empty or null removes it); participants never see it. Allowed during
 * and after the session.
 */
router.put('/:id/participants/:pid/marks/:key', (req, res) => {
  const row = ownedOr404(req);
  if (!isExam(row)) throw httpError(409, 'Marks only apply to exam sessions');
  const pid = Number(req.params.pid);
  const p = Number.isInteger(pid) ? q.participant.get(pid, row.id) : null;
  if (!p) throw httpError(404, 'Participant not found');
  const content = JSON.parse(row.content);
  const key = String(req.params.key);
  if (!listQuestions(content).some((x) => x.key === key)) throw httpError(404, 'Unknown question');
  const body = req.body || {};
  const has = (k) => Object.prototype.hasOwnProperty.call(body, k);
  if (!has('correct') && !has('points') && !has('comment')) {
    throw httpError(400, 'Give correct, points or comment');
  }
  const question = listQuestions(content).find((x) => x.key === key).q;
  const grades = parseObject(p.grades);
  const mark = { ...(grades[key] || {}) };
  if (has('correct')) {
    const verdict = body.correct;
    if (verdict !== true && verdict !== false && verdict !== null) {
      throw httpError(400, 'correct must be true, false or null');
    }
    delete mark.points;
    if (verdict === null) delete mark.correct;
    else mark.correct = verdict ? 1 : 0;
  }
  if (has('points')) {
    const points = body.points;
    if (points !== null && !isValidMarkPoints(points, question.points)) {
      throw httpError(
        400,
        `points must be from 0 to ${question.points}, in steps of 0.5 (or null)`,
      );
    }
    delete mark.correct;
    if (points === null) delete mark.points;
    else mark.points = points;
  }
  if (has('comment')) {
    if (body.comment !== null && typeof body.comment !== 'string') {
      throw httpError(400, 'comment must be text or null');
    }
    const comment = body.comment === null ? '' : body.comment.trim();
    if (comment.length > 1000) throw httpError(400, 'A comment can be at most 1000 characters');
    if (comment) mark.comment = comment;
    else delete mark.comment;
  }
  if ('correct' in mark || 'points' in mark || 'comment' in mark) {
    grades[key] = { ...mark, by: req.instructor.username, at: nowIso() };
  } else {
    delete grades[key];
  }
  q.setGrades.run(JSON.stringify(grades), p.id);
  log.info('exam.marked', {
    session: row.id,
    participant: p.id,
    question: key,
    correct: grades[key]?.correct ?? null,
    points: grades[key]?.points ?? null,
    instructor: req.instructor.id,
  });
  const fresh = q.participant.get(p.id, row.id);
  res.json(gradeParticipant(fresh, content, variablesOf(row)).find((g) => g.key === key));
});

/**
 * DELETE /api/sessions/:id/participants/:pid — remove a participant (e.g. a
 * duplicate or mistyped registration). Their device is signed out at its next
 * request (SEAT_REMOVED) and their data is deleted. Seat numbers are never
 * reused within a session.
 */
router.delete('/:id/participants/:pid', (req, res) => {
  const row = ownedOr404(req);
  const p = participantOr404(req, row);
  q.removeParticipant.run(p.id, row.id);
  log.warn('participant.removed', {
    session: row.id,
    participant: p.id,
    seat: p.seat_number,
    instructor: req.instructor.id,
  });
  res.status(204).end();
});

/**
 * POST /api/sessions/:id/participants/:pid/release — EXAM sessions: let this
 * seat be resumed on another device (a dead battery, a closed private tab).
 * Signs out the current device; answers are kept.
 */
router.post('/:id/participants/:pid/release', (req, res) => {
  const row = ownedOr404(req);
  if (!isExam(row)) throw httpError(409, 'Lab seats can always be resumed by name');
  const p = participantOr404(req, row);
  q.releaseSeat.run(p.id);
  log.info('participant.released', {
    session: row.id,
    participant: p.id,
    instructor: req.instructor.id,
  });
  res.json({ ok: true });
});

/**
 * POST /api/sessions/:id/participants/:pid/reopen — EXAM sessions: undo a
 * submission (e.g. submitted by mistake) so the participant can keep
 * answering. Only while the session is live.
 */
router.post('/:id/participants/:pid/reopen', (req, res) => {
  const row = ownedOr404(req);
  if (!isExam(row)) throw httpError(409, 'Only exam submissions can be reopened');
  if (sessionStatus(row) !== 'active') throw httpError(409, 'The session is no longer active');
  const p = participantOr404(req, row);
  q.reopenExam.run(nowIso(), p.id);
  log.info('exam.reopened', { session: row.id, participant: p.id, instructor: req.instructor.id });
  res.json({ ok: true });
});

/** GET /api/sessions/:id/questions/:key — EXAM sessions: every response to one question. */
router.get('/:id/questions/:key', (req, res) => {
  const row = viewableOr404(req);
  if (!isExam(row)) throw httpError(409, 'Only exam sessions have questions');
  const out = examQuestionResponses(
    q.participants.all(row.id),
    JSON.parse(row.content),
    String(req.params.key),
    variablesOf(row),
  );
  if (!out) throw httpError(404, 'Unknown question');
  res.json(withImages(out));
});

/**
 * GET /api/sessions/:id/sections/:index — the monitor's section drawer: who is
 * on the section, who completed it and how long it took against the time
 * allocated (breaks excluded), plus per-step activity (labs) or per-question
 * results (exams).
 */
router.get('/:id/sections/:index', (req, res) => {
  const row = viewableOr404(req);
  const index = Number(req.params.index);
  const content = JSON.parse(row.content);
  if (!Number.isInteger(index) || index < 0 || index >= content.length) {
    throw httpError(404, 'Unknown section');
  }
  const section = content[index];
  const rows = q.participants.all(row.id);
  const breaks = breaksOf(row);
  if (isExam(row)) {
    const views = rows.map((p) => examParticipantView(p, content, breaks, variablesOf(row)));
    return res.json({
      kind: 'exam',
      ...sectionTimeDetail(section, index, views),
      optional: !isSubmitSection(section) && isOptionalSection(section),
      question_count: sectionItems(section).filter(isQuestion).length,
      questions: examQuestionStats(rows, content, variablesOf(row)).filter(
        (x) => x.section_index === index,
      ),
    });
  }
  const views = rows.map((p) => participantView(p, content, breaks));
  res.json({
    kind: 'lab',
    ...sectionTimeDetail(section, index, views),
    optional: isOptionalSection(section),
    step_count: (section.steps || []).length,
    steps: labStepStats(section, index, rows),
  });
});

/** Monitor data for an EXAM session. */
function examSessionDetail(row, viewerId) {
  const content = JSON.parse(row.content);
  const rows = q.participants.all(row.id);
  const variables = variablesOf(row);
  const labSeats = labSeatMap(row);
  const participants = rows.map((p) => ({
    ...examParticipantView(p, content, breaksOf(row), variables),
    lab_seat: labSeatOf(labSeats, p),
  }));
  return {
    ...summarise(row, viewerId),
    ...breakView(row),
    seat_source: seatSourceSummary(row),
    template_exists: row.latest_template_version != null,
    template_archived: Boolean(row.template_archived_at),
    section_count: content.length,
    // Sections before the submit section (what the Section column counts).
    part_count: content.filter((sec) => !isSubmitSection(sec)).length,
    section_distribution: sectionFlow(content, participants, (sec) => ({
      optional: !isSubmitSection(sec) && isOptionalSection(sec),
      question_count: sectionItems(sec).filter(isQuestion).length,
    })),
    complete_count: participants.filter((p) => p.submitted).length,
    question_count: listQuestions(content).length,
    total_points: totalPoints(content),
    submitted_count: participants.filter((p) => p.submitted).length,
    pending_count: participants.reduce((n, p) => n + p.pending_count, 0),
    questions: examQuestionStats(rows, content, variables),
    participants,
  };
}

/** GET /api/sessions/:id — detail + live analytics dashboard data. */
router.get('/:id', (req, res) => {
  const row = viewableOr404(req);
  if (isExam(row)) return res.json(examSessionDetail(row, req.instructor.id));
  const sections = JSON.parse(row.content);
  const sectionCount = sections.length;
  const breaks = breaksOf(row);
  const labSeats = labSeatMap(row);
  const participants = q.participants.all(row.id).map((p) => ({
    ...participantView(p, sections, breaks),
    lab_seat: labSeatOf(labSeats, p),
  }));

  // Aggregate: how many seats have got to each section. Seats are placed by
  // their FURTHEST section, so reviewing an earlier one doesn't move them back.
  const sectionDistribution = sectionFlow(sections, participants, (s) => ({
    optional: isOptionalSection(s),
    step_count: (s.steps && s.steps.length) || 0,
    checkpoint_count: (s.steps || []).filter((step) => stepHasCheckpoint(step)).length,
    has_checkpoint: (s.steps || []).some((step) => stepHasCheckpoint(step)),
  }));
  const completeCount = participants.filter((p) => p.complete).length;

  res.json({
    ...summarise(row, req.instructor.id),
    ...breakView(row),
    capture_names: captureNamesOf(sections),
    seat_source: seatSourceSummary(row),
    complete_count: completeCount,
    template_exists: row.latest_template_version != null,
    template_archived: Boolean(row.template_archived_at),
    section_count: sectionCount,
    section_distribution: sectionDistribution,
    participants,
  });
});

/**
 * POST /api/sessions/:id/break — body { on: true | false }. Starts or ends a
 * class-wide break. Time inside a break is excluded from every participant's
 * section time and total time; when it ends the counters resume for everyone.
 * The session's expiry is NOT extended (use +30 min if needed).
 */
router.post('/:id/break', (req, res) => {
  const row = ownedOr404(req);
  if (sessionStatus(row) !== 'active') throw httpError(409, 'The session is not active');
  const on = req.body?.on;
  if (on !== true && on !== false) throw httpError(400, 'on must be true or false');
  const breaks = breaksOf(row);
  const running = currentBreak(breaks);
  const now = nowIso();
  if (on && !running) breaks.push({ start: now, end: null });
  if (!on && running) running.end = now;
  if (Boolean(on) !== Boolean(running)) {
    q.setBreaks.run(JSON.stringify(breaks.slice(-200)), row.id);
    log.info(on ? 'session.break.start' : 'session.break.end', {
      session: row.id,
      instructor: req.instructor.id,
    });
  }
  res.json({ id: row.id, ...breakView({ breaks: JSON.stringify(breaks) }) });
});

/**
 * POST /api/sessions/:id/terminate — end a session NOW.
 * Flips is_active to 0; the participant auth guard immediately rejects every
 * outstanding token (spec: "access tokens are invalidated immediately").
 */
router.post('/:id/terminate', (req, res) => {
  const row = ownedOr404(req);
  if (!row.is_active) {
    return res.json({ id: row.id, status: 'ended', already: true });
  }
  const now = nowIso();
  // A break still running when the class ends is closed at the end time.
  const breaks = breaksOf(row);
  const running = currentBreak(breaks);
  if (running) {
    running.end = now;
    q.setBreaks.run(JSON.stringify(breaks), row.id);
  }
  const collected = db.transaction(() => {
    q.terminate.run(now, row.id);
    return isExam(row)
      ? collectExamSubmissions({ ...row, breaks: JSON.stringify(breaks) }, now)
      : 0;
  })();
  log.info('session.terminated', { session: row.id, instructor: req.instructor.id });
  res.json({ id: row.id, status: 'ended', auto_submitted: collected });
});

/**
 * POST /api/sessions/:id/extend — ADD time to the current expiry.
 * The new expiry is computed from whichever is later — the existing expiry or
 * now — plus the requested minutes, so "+30" always grants 30 more minutes
 * rather than resetting the clock.
 */
router.post('/:id/extend', (req, res) => {
  const minutes = Math.min(Math.max(parseInt(req.body?.minutes ?? 30, 10) || 30, 5), 24 * 60);
  const row = ownedOr404(req);
  if (!row.is_active) throw httpError(409, 'Cannot extend an ended session');
  const base = Math.max(parseUtc(row.expires_at), Date.now());
  const expiresAt = new Date(base + minutes * 60_000).toISOString();
  q.extend.run(expiresAt, row.id);
  log.info('session.extended', { session: row.id, minutes, instructor: req.instructor.id });
  res.json({ id: row.id, expires_at: expiresAt });
});

/**
 * POST /api/sessions/:id/push-template — copy the template's LATEST version
 * into this live session. Participants pick it up on their next content load
 * (the status poll reports template_version so the client reloads promptly).
 * Checkpoints already cleared are re-evaluated against the new structure, so
 * a reordered manual can move participants forwards or backwards — the UI
 * warns before calling this.
 */
router.post('/:id/push-template', (req, res) => {
  const row = ownedOr404(req);
  if (!row.is_active) throw httpError(409, 'Cannot update an ended session');
  if (!row.template_id) throw httpError(409, 'The master template was deleted; nothing to push');
  const result = snapshotTemplateIntoSession(row.id, row.template_id);
  log.info('session.template.pushed', {
    session: row.id,
    version: result.version,
    instructor: req.instructor.id,
  });
  res.json({ id: row.id, template_version: result.version, section_count: result.section_count });
});

/** DELETE /api/sessions/:id — permanently delete a session and its data. */
router.delete('/:id', (req, res) => {
  const row = ownedOr404(req);
  // Participants cascade-delete via the FK. The room code (if it was active) is
  // freed for reuse.
  q.remove.run(row.id);
  log.warn('session.deleted', { session: row.id, instructor: req.instructor.id });
  res.status(204).end();
});

/**
 * GET /api/sessions/:id/export — full session data for archival/reporting.
 * Returns a JSON document (meta + per-participant analytics). Works for
 * sessions whose master template has since been archived or deleted, because
 * the session carries its own copy.
 */
router.get('/:id/export', (req, res) => {
  const row = viewableOr404(req);
  if (isExam(row)) return res.json(examExport(row));
  const sections = JSON.parse(row.content);
  const captureNames = captureNamesOf(sections);

  // Self-describing index of the manual so consumers (and the CSV builder)
  // can lay out uniform per-section / per-checkpoint columns without parsing
  // the template themselves.
  const breaks = breaksOf(row);
  const averages = sectionAverages(
    sections,
    q.participants.all(row.id).map((p) => participantView(p, sections, breaks)),
  );
  const sectionIndex = sections.map((sec, i) => ({
    index: i,
    number: i + 1,
    title: sec.title || `Section ${i + 1}`,
    step_count: (sec.steps || []).length,
    // Optional / wrap-up sections are excluded from sections_completed and progress_pct.
    optional: isOptionalSection(sec),
    // Time allocated (minutes) and the average time of those who completed it
    // (seconds, breaks excluded); `final` once every participant has moved on.
    minutes: sec.minutes || null,
    avg_seconds: averages[i].avg_seconds,
    completed_count: averages[i].completed_count,
    avg_final: averages[i].final,
  }));
  const checkpointIndex = [];
  sections.forEach((sec, si) => {
    (sec.steps || []).forEach((step, sti) => {
      if (!stepHasCheckpoint(step)) return;
      checkpointIndex.push({
        key: `${si}.${sti}`,
        section_number: si + 1,
        step_number: sti + 1,
        section_title: sec.title || `Section ${si + 1}`,
        step_title: step.title || `Step ${sti + 1}`,
        prompt: step.checkpoint.prompt || 'Enter the value to continue',
        mode: checkpointMode(step),
        capture: step.checkpoint.capture || null,
      });
    });
  });

  const participants = q.participants.all(row.id).map((p) => {
    const d = participantDetail(p, sections, breaksOf(row));
    return {
      number: d.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      name: d.name,
      // One key per captured variable (empty string until the seat gets there),
      // so every row has the same columns.
      captured: Object.fromEntries(captureNames.map((n) => [n, d.captured[n] ?? ''])),
      current_section: d.current_section + 1,
      furthest_section: d.furthest_section + 1,
      sections_completed: d.completed_sections,
      counting_sections: d.counting_sections,
      total_sections: sections.length,
      progress_pct: d.progress_pct,
      checkpoints_cleared: d.completed_checkpoints.length,
      hints_taken: d.hints.length,
      solutions_revealed: d.solutions.length,
      wrong_attempts: d.wrong_attempts,
      complete: d.complete,
      completed_at: d.completed_at,
      finished: d.finished,
      finished_at: p.finished_at,
      total_seconds: d.total_seconds,
      joined_at: p.joined_at,
      last_seen_at: p.last_seen_at,
      // Time spent per section, in manual order (seconds; the open visit of an
      // in-progress seat is included up to export time).
      section_seconds: d.section_seconds,
      section_times: d.section_times.map((t) => ({
        number: t.index + 1,
        title: t.title,
        seconds: t.seconds,
        cleared: t.cleared,
        done: t.done,
        optional: t.optional,
      })),
      // Every checkpoint in the manual with what this seat typed: the accepted
      // answer (as typed) and each incorrect attempt with its timestamp.
      checkpoints: d.checkpoints.map((c) => ({
        key: c.key,
        section_number: c.section_index + 1,
        step_number: c.step_index + 1,
        step_title: c.step_title,
        mode: c.mode,
        capture: c.capture,
        cleared: c.cleared,
        cleared_at: c.cleared_at,
        accepted_answer: c.accepted_answer,
        attempt_count: c.attempt_count,
        wrong_attempts: c.wrong_attempts.map((a) => ({ answer: a.answer, at: a.at })),
      })),
      hints_opened: d.hints.map((h) => ({
        section_number: h.section_index + 1,
        step_number: h.step_index + 1,
        step_title: h.step_title,
        hint_index: h.hint_index + 1,
        label: h.label,
      })),
      solutions_revealed_list: d.solutions.map((x) => ({
        section_number: x.section_index + 1,
        step_number: x.step_index + 1,
        step_title: x.step_title,
      })),
    };
  });

  // Flat chronological attempt log across the whole class — one row per
  // submission — for spreadsheet analysis ("which checkpoint tripped people up").
  const attempts = [];
  for (const pr of participants) {
    for (const c of pr.checkpoints) {
      for (const a of c.wrong_attempts) {
        attempts.push({
          at: a.at,
          number: pr.number,
          name: pr.name,
          checkpoint: c.key,
          section_number: c.section_number,
          step_number: c.step_number,
          step_title: c.step_title,
          answer: a.answer,
          correct: false,
        });
      }
      if (c.cleared && c.cleared_at) {
        attempts.push({
          at: c.cleared_at,
          number: pr.number,
          name: pr.name,
          checkpoint: c.key,
          section_number: c.section_number,
          step_number: c.step_number,
          step_title: c.step_title,
          answer: c.accepted_answer,
          correct: true,
        });
      }
    }
  }
  attempts.sort((a, b) => String(a.at).localeCompare(String(b.at)) || a.number - b.number);

  res.json({
    exported_at: nowIso(),
    session: {
      id: row.id,
      title: row.title,
      room_code: row.room_code,
      template_title: row.template_title,
      template_version: row.template_version,
      status: sessionStatus(row),
      break_total_seconds: totalBreakSeconds(breaksOf(row)),
      section_count: sections.length,
      capture_names: captureNames,
      created_at: row.created_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
    },
    sections: sectionIndex,
    checkpoints: checkpointIndex,
    participants,
    attempts,
  });
});

/**
 * Export document for an EXAM session: the question index (with expected
 * answers), one record per participant (score, every response with its
 * automatic verdict and manual mark), and a chronological log of every
 * answer change across the class.
 */
function examExport(row) {
  const content = JSON.parse(row.content);
  const rows = q.participants.all(row.id);
  const breaks = breaksOf(row);
  const variables = variablesOf(row);
  const views = rows.map((p) => examParticipantView(p, content, breaks, variables));
  const averages = sectionAverages(content, views);
  const sectionIndex = content.map((sec, i) => ({
    index: i,
    number: i + 1,
    title: sec.title || `Section ${i + 1}`,
    question_count: sectionItems(sec).filter(isQuestion).length,
    minutes: sec.minutes || null,
    avg_seconds: averages[i].avg_seconds,
    completed_count: averages[i].completed_count,
    avg_final: averages[i].final,
  }));
  const questions = listQuestions(content).map(({ key, si, qi, number, q: qq }) => ({
    key,
    number,
    section_number: si + 1,
    question_number: qi + 1,
    section_title: content[si]?.title || `Section ${si + 1}`,
    type: qq.type,
    prompt: qq.prompt,
    options: qq.options,
    points: qq.points,
    expected: describeExpected(qq),
  }));
  const participants = rows.map((p, pi) => {
    const v = views[pi];
    return {
      number: v.seat_number,
      first_name: p.first_name,
      last_name: p.last_name,
      name: v.name,
      submitted: v.submitted,
      submitted_at: v.submitted_at,
      auto_submitted: v.auto_submitted,
      answered: v.answered,
      question_count: v.question_count,
      score: v.score,
      max_score: v.max_score,
      score_pct: v.score_pct,
      pending_count: v.pending_count,
      fully_graded: v.fully_graded,
      total_seconds: v.total_seconds,
      furthest_section: v.furthest_section + 1,
      // Seconds per section in exam order (breaks excluded).
      section_seconds: v.section_seconds,
      joined_at: p.joined_at,
      last_seen_at: p.last_seen_at,
      responses: gradeParticipant(p, content, variables).map((g) => ({
        key: g.key,
        number: g.number,
        response: g.response,
        answered: g.answered,
        auto: g.auto,
        override: g.override,
        correct: g.correct,
        partial: g.partial,
        pending: g.pending,
        points_awarded: g.points_awarded,
        comment: g.comment,
        marked_by: g.marked_by,
        marked_at: g.marked_at,
      })),
    };
  });
  const answerLog = sessionAnswerLog(row.id);
  return {
    exported_at: nowIso(),
    session: {
      id: row.id,
      kind: 'exam',
      title: row.title,
      room_code: row.room_code,
      template_title: row.template_title,
      template_version: row.template_version,
      status: sessionStatus(row),
      break_total_seconds: totalBreakSeconds(breaksOf(row)),
      section_count: content.length,
      question_count: questions.length,
      total_points: totalPoints(content),
      created_at: row.created_at,
      expires_at: row.expires_at,
      ended_at: row.ended_at,
    },
    sections: sectionIndex,
    questions,
    participants,
    answer_log: answerLog,
  };
}

export { sessionStatus };
export default router;
