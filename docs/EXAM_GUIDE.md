# vLabs Exam Guide

Exams are a second template kind alongside labs. Participants join with a room
code exactly as they do for a lab, answer questions, and submit. **Correct
answers are never sent to participants and they never see a score.** The
instructor's session monitor grades automatically where it can, lets you mark
any answer by hand, and exports everything.

Exams have their **own** format (`shared/exam-schema.js`,
`shared/exam-format.js`). The lab format and its parser are not involved.

Applies to vLabs **1.9.0**.

---

## 1. Creating an exam

Exams can be written in two places:

- **vLabs Template Studio** (`docs/vlabs_template_studio.html`): **New → New
  Exam**, or **Examples → E. Network Fundamentals Quiz**. It has the same
  parts (questions, instructions & checklist, submit), question types, time
  allocations, image library and validation as below,
  plus a **Participant Preview** where you can answer the exam yourself,
  **Check my answers** (graded exactly as vLabs grades) and **Show answer
  key**. **Export** writes a `.zip` package (exam + images), `.md` or `.json`.
  Import it in the portal under **Templates → Import**: vLabs sees that it is
  an exam, uploads the package's images and opens it in the exam editor, so
  you only need to press **Save exam**.
- The portal's own editor, below.

**Templates → New exam** opens the exam editor: sections ("parts") of three
kinds (§2a). For every question choose a type, write the prompt (Markdown,
with images by library file name, e.g. `![topology](topology.png)`), set the
points, and give the correct answer. The **Time** boxes (hours and minutes)
beside each section title set the time allocated to that section (§4.1).
**Add a section before the submit step** adds a questions section or an
instructions-and-checklist section; the submit section always stays last. **Import** (a Studio
`.zip`, `.md` or `.json`) / **.md** / **.json** read and write the format
below; **Sample .md** downloads a ready-made example. A sample exam is also
created on a fresh install.

Launch it from **Sessions** like a lab (exams are grouped under *Exams* in the
template picker). The session takes a frozen copy, as labs do.

## 2. Question types

| Type        | Participant sees                  | Correct answer                         | Graded                                                        |
| ----------- | --------------------------------- | -------------------------------------- | ------------------------------------------------------------- |
| `single`    | options, choose one               | one option                             | automatically                                                 |
| `multiple`  | options, choose all that apply    | one or more options (exact set needed) | automatically, all or nothing                                 |
| `truefalse` | True / False                      | true or false                          | automatically                                                 |
| `short`     | one-line text box                 | list of accepted answers (optional)    | automatically when accepted answers are given (case and spacing ignored), otherwise by hand |
| `long`      | multi-line text box               | —                                      | by hand                                                       |

Points default to 1 (0–100, halves allowed). An unanswered auto-graded
question scores 0; unanswered hand-marked questions are simply not awarded.

## 2a. Section types

Every exam is a list of sections. There are three kinds:

| Kind                         | Markdown heading     | Participant sees                                                   | Moves on when                       |
| ---------------------------- | -------------------- | ------------------------------------------------------------------ | ----------------------------------- |
| **Questions** (the default)  | `# Title`            | the questions                                                      | every question has an answer        |
| **Instructions & checklist** | `# [info] Title`     | your instructions (Markdown, images) and a checklist to tick off   | every checklist item is ticked      |
| **Submit**                   | `# [submit] Title`   | optional text, a review of what is answered, and **Submit exam**   | (the last step)                     |

**Instructions & checklist** sections are for practical work the participant
completes before continuing, e.g. "Cable the switch to the router, then call
your instructor over to check it", with checklist items such as *Switch is
cabled* and *My instructor has checked my bench*. The participant ticks each
item themselves and the next section unlocks. **Nobody approves it in vLabs**:
if the instructor checks the work, they do it at the bench and record it on
your own grading sheet (linking that sheet to vLabs is future work). Ticks are
saved like answers, appear in the **Answer log** export with their time, and
are never graded. A checklist section has no questions; give it instructions,
a checklist, or both (up to 30 items).

**Submit** is always the last section, exactly once. Every new exam has one,
called *Review and submit*. Rename it, add text above the button (e.g. "Hand
your bench card to your instructor before you submit"), and choose whether it
shows the review: with **Show a review first** ticked, participants see how
many questions they answered, with links to any unanswered question or
unfinished checklist; unticked, they see only the text and the **Submit exam**
button. An exam imported without a submit section gets the default one, and
one placed anywhere else is moved to the end.

## 3. Markdown format

```markdown
---
kind: exam
title: Network Fundamentals — Unit Test
description: 20 minutes, closed book
---

# Part 1 · Addressing
> minutes: 10

## [single] Which address is a valid private IPv4 address?
- [ ] 8.8.8.8
- [x] 192.168.1.20
- [ ] 172.32.0.1
> points: 2

## [multiple] Select every protocol that normally runs over UDP.
- [x] DNS
- [ ] SSH
- [x] DHCP

## [truefalse] A /24 network has 254 usable host addresses.
> answer: true

## [short] What TCP port does HTTPS use by default?
> accept: 443 | tcp/443

## [long]
In two or three sentences, explain why networks are split into VLANs.
> points: 5

# [info] Part 2 · Bench check
> minutes: 15

Cable your switch to the router as shown on the bench card, then raise your
hand so your instructor can check it.

- [ ] Switch port Gi0/1 is cabled to the router
- [ ] My instructor has checked my bench

# [submit] Review and submit
> review: true

Check every part before you hand in. You cannot change your answers after.
```

- `kind: exam` in the front matter marks the file as an exam. Exports always
  write it; on import it is optional (a file whose `## [type]` headings use
  exam question types is recognised as an exam anyway).
- `# ` starts a section, `## [type]` a question. Text after the type and the
  lines below it are the prompt (Markdown). Fenced code blocks are verbatim.
- Type aliases: `mcq` `choice` `radio` → single; `multi` `checkbox` →
  multiple; `tf` `true-false` → truefalse; `text` `short-answer` → short;
  `essay` `long-answer` → long.
- `- [ ]` / `- [x]` lines are options for single/multiple (`x` = correct).
- `> points: N`, `> answer: true|false`, `> accept: a | b` (write `\|` for a
  literal pipe).
- `> minutes: N` directly under a `#` section heading allocates N minutes to
  that section: whole minutes, 1–600, optional (§4.1). In JSON it is
  `"minutes": N` on the section. (The editors take hours and minutes.)
- `# [info] Title` starts an instructions-and-checklist section (aliases
  `[checklist]`, `[tasks]`). Its text is the instructions; `- [ ]` lines are
  the checklist (a `- [x]` is read the same way: participants always start
  unticked). Questions cannot go in it. Use `##` or smaller headings inside
  the instructions: a `#` line starts a new section.
- `# [submit] Title` is the submit section (alias `[review]`). Its text is
  shown above the button; `> review: false` leaves out the review. Exports
  always write it.
- In JSON a section has `"type": "questions" | "info" | "submit"` (default
  questions); info sections carry `"body"` and `"tasks": ["…"]`, the submit
  section `"body"` and `"review": true | false`.
- Export → import round-trips losslessly.

## 4. During the exam

- **Sections unlock like a lab's.** One section per page. A participant
  starts with only the first section. The next one unlocks once **every
  question** in the current section has an answer, or **every checklist
  item** is ticked in an instructions-and-checklist section; **Next** stays
  disabled until then. Locked sections are never sent to the browser and
  cannot be answered, so nobody can read ahead.
- **Free navigation, up to the furthest section reached.** Before
  submitting, participants can go back to any unlocked section and change
  answers. Progress stays at the furthest section they reached: clearing an
  earlier answer does not lock later sections again. The **submit section**
  opens as soon as the last questions section does, so a participant can
  hand in with questions left blank; a checklist right before it must be
  ticked first. With the review on, it lists any unanswered questions and
  unfinished checklists.
- Answers **save automatically**: choices immediately, typed answers after a
  short pause or when the field loses focus. The header shows one save
  indicator for the whole exam (a cloud: *Saving…*, *Saved*, or *Not saved,
  retrying*). There is no mark beside each question, so "saved" is never
  mistaken for "correct". Leaving and rejoining with the same name resumes.
- **Instructions & checklist** sections show the instructions and the
  checklist; ticking an item saves it at once. When every item is ticked
  the next section unlocks.
- Each exam seat is **bound to the device that joined it**. Rejoining with
  the same name on that device resumes. On any other device it is refused
  ("already taking the exam on another device"), so nobody can open a
  classmate's exam by typing their name. If a device dies, the instructor uses
  **Move to another device** in the monitor. The student then joins again on
  any device and gets their answers back (the old device is signed out).
- A typed answer still waiting to autosave is sent when the tab is hidden or
  closed.
- **Submit is final.** After submitting, the participant sees only *Exam
  completed: your exam is complete and your answers have been recorded*.
  They **cannot go back
  to review the questions or see their answers**: the server no longer sends
  either, even after a reload or rejoin. They never see a score or the
  correct answers. When the session ends or expires, saved answers are kept.
  To let someone continue, use **Reopen exam** (§5).

### 4.1 Time allocated per section and breaks

Section time works exactly as in labs (TEMPLATE_GUIDE.md §11.1):

- Set the allocation with `> minutes: N` (Markdown), `"minutes": N` (JSON) or
  the **Time** boxes (hours and minutes) beside the section title in the exam
  editor or the Studio. Leave them empty for none. The submit section has no
  allocation.
- The monitor compares each participant's time on their furthest section
  with its allocation. Rows turn amber from 80 % of the allocation and red
  once it is exceeded. Without an allocation the fixed thresholds apply:
  amber from 8 minutes, red after 15.
- Time on a section adds up every visit to it, minus breaks. **Submitting
  stops the clock.**
- The **Sections** panel shows, per section, who is on it and how many have
  completed it. Click a section for its details: the allocation, the
  **average time** of those who completed it (marked final once everyone has
  moved past the section), median / fastest / slowest, who took longer than
  allocated, who is on it now, and the results of its questions.
- **Start break** / **End break** on the monitor pauses and resumes every
  participant's section timer at once. Participants see a "Break" banner and
  can keep working, but break time never counts. The session countdown is
  not paused; use **+30 min** if needed. An exam session runs for **1 hour**
  by default (labs: 8 hours); change **Runs for** (hours and minutes) when
  you launch it.
- Participants never see the allocation. Nothing locks when it runs out; it
  is a signal for the instructor, not a hard time limit.

## 5. Grading

The exam monitor shows:

- **Sections**: participants on each section and how many completed it.
  Click a section for its timing (§4.1), its participants and the results
  of its questions; click a question or a participant there to open it.
- **Questions** — answered count, correct rate (over graded responses), and
  how many still need marking. Click a question to see every participant's
  response to it and mark them in one place.
- **Participants** — answered, score (`*` = provisional while answers still
  need marking), the section they have reached, time on it against its
  allocation, and status. Click a row for their time per section and their
  whole exam: each question with
  the options (correct and chosen highlighted), their response, the expected
  answer, the verdict, the history of changes to that answer, and
  **Correct / Incorrect / Clear** buttons.

Seat actions in the participant panel: **Reopen exam** (undo a submission
while the session is live), **Move to another device** (above) and
**Remove** (deletes a mistaken registration and its answers). After a
reopen, the participant continues from the furthest section they reached,
with their answers, and the section clock starts again.

A manual mark overrides the automatic verdict for that response; **Clear**
returns to it. Marks can be given during or after the session and record who
marked and when.

## 6. Exports

From the monitor:

- **Results CSV** — one row per participant: score, submission time,
  furthest section, seconds per section (`time_s<N>_…`, breaks excluded),
  and for every question the response, result (correct / incorrect / needs marking /
  unanswered), points and who marked it.
- **Answer key** — every question with options and expected answer.
- **Answer log** — every answer change across the class, in time order,
  including checklist ticks (question `2.t0` = section 3, item 1: *Ticked* /
  *Unticked*).
- **JSON** — all of the above in one document, plus a `sections` index
  (allocated minutes, average seconds, completed count) and the session's
  total break time.

## 7. Adding a question type later

1. Add an entry to `QUESTION_TYPES` in `shared/exam-schema.js`: `label`,
   `hasOptions`, `normalise`, `validate`, `normaliseResponse` and `grade`
   (return `null` for "needs a human").
2. Render it for participants in `client/src/components/ExamQuestion.jsx` and
   add its fields to `client/src/pages/ExamEditor.jsx`.
3. Optionally give it a Markdown type name / alias in
   `shared/exam-format.js`.

Storage, the participant API, manual marking and exports work off that
interface unchanged.
