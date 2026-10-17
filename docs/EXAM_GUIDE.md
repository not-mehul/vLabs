# vLabs Exam Guide

Exams are a second template kind alongside labs. Participants join with a room
code exactly as they do for a lab, answer questions, and submit. **Correct
answers are never sent to participants and they never see a score.** The
instructor's session monitor grades automatically where it can, lets you mark
any answer by hand, and exports everything.

Exams have their **own** format (`shared/exam-schema.js`,
`shared/exam-format.js`). The lab format and its parser are not involved.

Applies to vLabs **1.14.0**.

---

## 1. Creating an exam

Exams can be written in two places:

- **vLabs Template Studio** (`docs/vlabs_template_studio.html`): **New → New
  Exam**, or **Examples → E. Network Fundamentals Quiz**. It has the same
  parts, item types (steps and questions), answer matching, time
  allocations, image library and validation as below,
  plus a **Participant Preview** where you can answer the exam yourself,
  **Check my answers** (graded exactly as vLabs grades) and **Show answer
  key**. **Export** writes a `.zip` package (exam + images), `.md` or `.json`.
  Import it in the portal under **Templates → Import**: vLabs sees that it is
  an exam, uploads the package's images and opens it in the exam editor, so
  you only need to press **Save exam**.
- The portal's own editor, below.

**Templates → New exam** opens the exam editor: a list of sections ("parts"),
each a list of **questions and steps** (§2). **Add:** under a section adds an
item of any of the seven types, and the type menu on an item changes it
(text, options and points carry over where they fit). For a question write
the prompt (Markdown, with images by library file name, e.g.
`![topology](topology.png)`), set the points, and give the correct answer;
for a step write its instructions and, for a checklist, the items to tick.
**Minutes** beside each section title sets the time allocated to that
section (§4.1). **Add section** adds one before the submit step, which
always stays last. **Import** (a Studio
`.zip`, `.md` or `.json`) / **.md** / **.json** read and write the format
below; **Sample .md** downloads a ready-made example. A sample exam is also
created on a fresh install.

Launch it from **Sessions** like a lab (exams are grouped under *Exams* in the
template picker). The session takes a frozen copy, as labs do.

## 2. Sections, steps and questions

An exam is a list of **sections**, then the **submit** section (§2c). Each
section is a list of **items**, in any order and any mix, and every item
declares its own type:

| Type          | Markdown        | Participant sees                                  | Correct answer                         | Graded                                                     |
| ------------- | --------------- | ------------------------------------------------- | -------------------------------------- | ---------------------------------------------------------- |
| Informational | `[info]`        | a title and instructions (Markdown, images)       | —                                      | not graded                                                 |
| Checklist     | `[checklist]`   | instructions plus items they tick off             | —                                      | not graded; every item must be ticked to move on           |
| Multiple choice | `[single]`    | options, choose one                               | one option                             | automatically                                              |
| Select all that apply | `[multiple]` | options, choose all that apply              | one or more options (exact set needed) | automatically, all or nothing                              |
| True / false  | `[truefalse]`   | True / False                                      | true or false                          | automatically                                              |
| Short answer  | `[short]`       | one-line text box                                 | exact answers or a pattern (§2a)       | automatically, or by hand when it has neither              |
| Long answer   | `[long]`        | multi-line text box                               | —                                      | by hand                                                    |

Informational and Checklist items are **steps**; the rest are **questions**.
Points default to 1 (0–100, halves allowed). An unanswered auto-graded
question scores 0; unanswered hand-marked questions are simply not awarded.
A section holds up to 200 items, a checklist up to 30 items.

**Pages.** Each section is one page: its steps and questions are shown one
below the other, in the order written, so a step's instructions stay on
screen above the questions that follow it. **Next** moves to the next
section. E.g. *Read the scenario* (Informational) + 3 questions, then *Cable
the bench* (Checklist) + *Read the serial number* (Short answer), then
*Instructor check* (Checklist) all appear on the section's one page.

**Checklists** are for practical work the participant completes before
continuing: e.g. *Cable the bench* (items *Switch is cabled*, *Link light is
green*), then *Instructor check* ("Call your instructor over", item *My
instructor has checked my bench*). The participant ticks each item
themselves. **Nobody approves it in vLabs**: if the instructor checks the
work, they do it at the bench and record it on your own grading sheet. Ticks
are saved like answers, appear in the **Answer log** export with their time,
and are never graded. Unticking an item locks every section after it again
until it is ticked once more. An Informational item needs instructions; a
Checklist needs at least one item (its instructions are optional).

## 2a. Short answers: exact or pattern

A short answer is checked one of two ways, exactly like a lab checkpoint
([TEMPLATE_GUIDE.md](TEMPLATE_GUIDE.md) §9):

- **Exact answers** (the default): a list of accepted answers. Case and
  extra spaces are ignored, so ` TCP/443 ` matches `tcp/443`. With no
  accepted answers the question is marked by hand.
- **Pattern** (format only): a **mask** for answers you cannot know in
  advance, such as a serial number or a MAC address. `9` is a digit, `A` a
  letter, `X` a letter or digit (`a` / `x` the same, stored lower-case), `?`
  any visible character and `*` anything. Other letters and digits must match
  as written (`SN-9999` must start with *SN*), and punctuation is a separator
  participants may leave out: `XXXX.XXXX.XXXX` accepts both `ABCD.1234.EFGH`
  and `abcd1234efgh`. Write `\.` to make a separator required. A mask needs
  at least one wildcard. Any answer that fits is correct (up to 200
  characters, as in labs); the editor shows an example as you type.

Either kind can have a **placeholder**, the grey example shown in the empty
box (`e.g. ABCD.1234.EFGH`), and can **save the answer** as a variable for
later sections (§2b). A pattern answer is saved in the mask's canonical form
(`abcd1234efgh` is saved as `ABCD.1234.EFGH`). The accepted answers and the
mask are never sent to participants; the placeholder is.

## 2b. Per-seat variables and saved answers

Exams use the same **tokens** as labs ([TEMPLATE_GUIDE.md](TEMPLATE_GUIDE.md)
§4): write `{{ NAME }}` in any section title, step title, instructions,
checklist item, question prompt, option or accepted answer, and each
participant sees their own value. (Patterns and placeholders are not
resolved: they are written as is.)

- **Built-ins**, always available: `{{ SEAT_ID }}`, `{{ FIRST_NAME }}`,
  `{{ LAST_NAME }}`, `{{ FULL_NAME }}`.
- **Variables**: per-seat formulas declared once for the exam, exactly as in
  a lab (`STORE = 100 + seat`, `SUBNET = '10.' + seat + '.0.0'`, with the
  same helper functions). Add them under **Variables** in the exam editor or
  the Template Studio, or in the Markdown front matter.
- **Saved answers**: a short-answer question can save the participant's
  answer as a variable (**Save the answer as a variable**, or
  `> capture: NAME` in Markdown). Every **later** section can then show it
  (`Ping {{ ROUTER_IP }} from your laptop`) or accept it as an answer
  (`> accept: {{ ROUTER_IP }}`), like a lab checkpoint's captured value.
  It can't be used in its own section or any section before it, since the
  participant has not answered it yet there. If they go back and change the
  answer, later sections show the new one. Captured text is trimmed, and an
  answer cleared after moving on resolves to nothing.

Accepted answers are resolved per seat before grading, so
`> accept: {{ STORE }}` accepts *104* from seat 4 and *107* from seat 7, and
the monitor shows each participant the expected answer they were given.
Unknown names are rejected when the exam is saved (*Unknown placeholder
{{ XYZ }} in Section 1 · step 1*), as is a saved answer used too early. The
exam editor's preview resolves any seat you choose, and the Studio's
participant preview takes a seat and name.

## 2c. The submit section

**Submit** is always the last section, exactly once. Every new exam has one,
called *Review and submit*. Rename it, add text above the button (e.g. "Hand
your bench card to your instructor before you submit"), and choose whether it
shows the review: with **Show a review first** ticked, participants see how
many questions they answered, with links to any unanswered question or
unfinished checklist; unticked, they see only the text and the **Submit**
button. Nothing else is added: the page shows only what the template says.
An exam imported without a submit section gets the default one, and one
placed anywhere else is moved to the end.

## 3. Markdown format

```markdown
---
kind: exam
title: Network Fundamentals — Unit Test
description: 20 minutes, closed book
variables:
  SUBNET = '10.' + seat + '.0.0/24'
---

# Part 1 · Addressing
> minutes: 10

## [info] Your bench
You are on seat {{ SEAT_ID }}. Your subnet is **{{ SUBNET }}**.

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

# Part 2 · Bench check
> minutes: 15

## [checklist] Cable the bench
Cable your switch to the router as shown on the bench card.
- [ ] Switch port Gi0/1 is cabled to the router
- [ ] The link light is green on both ends

## [short] Read the serial number off the back of your switch.
> pattern: XXXX.XXXX.XXXX
> placeholder: e.g. ABCD.1234.EFGH
> capture: SERIAL

## [checklist] Instructor check
Raise your hand so your instructor can check your bench.
- [ ] My instructor has checked my bench

# Part 3 · Short answers

## [short] What TCP port does HTTPS use by default?
> accept: 443 | tcp/443

## [short] Type the serial number of your switch again.
> accept: {{ SERIAL }}

## [long]
In two or three sentences, explain why networks are split into VLANs.
> points: 5

# [submit] Review and submit
> review: true

Check every part before you hand in. You cannot change your answers after.
```

- `kind: exam` in the front matter marks the file as an exam. Exports always
  write it; on import it is optional (a file with a `## [type]` heading of a
  question type or `[checklist]`, or a tagged `# [submit]` or `# [info]`
  section, is recognised as an exam anyway; a `## [info]` item alone is not,
  since labs use it too).
- `# Title` starts a section and `## [type]` an item of it, of any type
  (§2). Text after the type is a step's title or the start of a question's
  prompt; the lines below are the step's instructions or the rest of the
  prompt (Markdown). Fenced code blocks are verbatim. A `##` heading with no
  type is a multiple-choice question. Text between a section heading and its
  first item becomes an untitled Informational item. Use `###` or smaller
  headings inside instructions and prompts: `##` starts a new item and `#` a
  new section.
- Step tags: `[info]` (aliases `[informational]`, `[step]`) and `[checklist]`
  (alias `[tasks]`). A step's `- [ ]` lines are its checklist (a `- [x]` is
  read the same way: participants always start unticked), so an `[info]`
  item with `- [ ]` lines is a Checklist.
- Question type aliases: `mcq` `choice` `radio` → single; `multi` `checkbox`
  `checkboxes` → multiple; `tf` `true-false` → truefalse; `text`
  `short-answer` → short; `essay` `long-answer` → long. In a question,
  `- [ ]` / `- [x]` lines are the options for single/multiple (`x` =
  correct).
- Question settings: `> points: N`, `> answer: true|false`, and for short
  answers `> accept: a | b` (exact answers; write `\|` for a literal pipe),
  `> pattern: MASK` (grade by a pattern instead, §2a), `> placeholder: text`
  and `> capture: NAME` (save the answer as `{{ NAME }}` for later sections,
  §2b).
- `variables:` in the front matter, then one indented `NAME = formula` line
  per variable (§2b).
- `> minutes: N` under a `#` section heading (before its first question)
  allocates N minutes to that section: whole minutes, 1–600, optional
  (§4.1).
- `# [submit] Title` is the submit section (alias `[review]`). Its text is
  shown above the button; `> review: false` leaves out the review. It cannot
  hold questions or steps. Exports always write it.
- Export → import round-trips losslessly.

**JSON.** A section is `{ "title", "minutes", "items": [ … ] }` and each
item has a `"type"`: `{ "type": "info", "title", "body" }`, `{ "type":
"checklist", "title", "body", "tasks": ["…"] }` or a question `{ "type",
"prompt", "points", "options", "correct", "accepted" }`, where a short answer
may add `"match": "pattern", "pattern": "MASK"`, `"placeholder"` and
`"capture"`. The submit section is `{ "type": "submit", "title", "body",
"review" }`, and `"variables": [{ "name", "expression" }]` sits at the top
level.

**Older files.** Exams written before 1.12.0 keep working, in Markdown, in
JSON and in sessions already running: a `# [info] Title` section (aliases
`[informational]`, `[checklist]`, `[tasks]`) reads its `##` headings as
steps, and JSON sections with `"type": "questions"` (`"questions": […]`) or
`"type": "info"` (`"steps": [{ "title", "body", "tasks" }]`, or 1.9.0's
`"body"` and `"tasks"` on the section) are read as items: a step with
checklist items as a Checklist, one without as Informational. Answers,
ticks and exports keep their keys. Saving such an exam in the editor writes
the new shape.

## 4. During the exam

- **Sections unlock like a lab's.** One section at a time, each on its own
  page (§2). A participant starts with only the first section. The next one
  unlocks once **every question** in the current section has an answer and
  **every checklist item** is ticked; **Next** stays disabled until then.
  Locked sections are never sent to the browser and cannot be answered, so
  nobody can read ahead.
- **Free navigation, up to the furthest section reached.** Before
  submitting, participants can go back to any unlocked section and change
  answers. Progress stays at the furthest section they reached: clearing an
  earlier answer does not lock later sections again. Unticking a checklist
  item does: every section after it locks until it is ticked again. The
  **submit section** opens as soon as the last section does, so a
  participant can hand in with questions left blank, unless that section
  has a checklist, which must be ticked first. With the review on, it lists
  any unanswered questions and unfinished checklists.
- Answers **save automatically**: choices immediately, typed answers after a
  short pause or when the field loses focus. The header shows one save
  indicator for the whole exam (a cloud: *Saving…*, *Saved*, or *Not saved,
  retrying*). There is no mark beside each question, so "saved" is never
  mistaken for "correct". Leaving and rejoining with the same name resumes.
- Ticking a checklist item saves at once. **Next** opens the following
  section and **Previous** the one before it. Links in the review open the
  section and scroll to the question, or to the first box left to tick.
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
  **Minutes** beside the section title in the exam editor or the Studio.
  Leave it empty for none. The submit section has no
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

### 4.2 Seats from a lab

Per-seat values (§2b) come from the seat number. To give everyone the same
values in the exam as in the lab they just did, launch the exam with
**Seats from:** that lab session (the launcher lists your lab sessions,
running or ended).

- Someone who joins the exam under the **same name** as in the lab (case
  and extra spaces ignored) gets their **lab seat number**, whatever order
  people join in, and so the same values.
- Anyone not found in the lab gets the next number **above the lab's
  highest seat**, so they never take a seat a lab participant still needs.
- The monitor shows *Seats from …* above the participants, and tags anyone
  **not in lab** (or whose seat differs from their lab seat, *lab #N*).
- **Change seat** in the participant panel fixes the rest: a typo (*Jon* in
  the lab, *John* in the exam), or two students with the same name (one
  joins with, say, a middle initial and you give them their seat). It is
  refused when someone else has that number. The participant's exam and the
  marking switch to the new seat's values at once (their page reloads within
  about 15 seconds); answers already given stay as they are.
- Leaving **Seats from** on *Join order* numbers seats by join order, as
  before. **Change seat** works there too.
- Deleting the lab session unlinks it: seats already given stay, and later
  joiners are numbered in join order.

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

Seat actions in the participant panel: **Change seat** (§4.2), **Reopen
exam** (undo a submission while the session is live), **Move to another
device** (above) and
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
  including checklist ticks (question `2.t0` = section 3, its first
  checklist item, counting across all its checklists: *Ticked* /
  *Unticked*). Question keys (`2.1` = section 3, its second question) count
  only the questions of a section, so steps between them do not change
  them.
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
4. Mirror it in the Template Studio's `vlabs-exam-core` block
   (`docs/vlabs_template_studio.html`); `client/tests/studioExamParity.test.js`
   fails until the Studio reads, writes and grades it like vLabs.

Storage, the participant API, manual marking and exports work off that
interface unchanged.
