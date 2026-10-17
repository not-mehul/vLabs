# vLabs Exam Guide

Exams are a second template kind alongside labs. Participants join with a room
code exactly as they do for a lab, answer questions, and submit. **Correct
answers are never sent to participants and they never see a score.** The
instructor's session monitor grades automatically where it can, lets you mark
any answer by hand, and exports everything.

Exams have their **own** format (`shared/exam-schema.js`,
`shared/exam-format.js`). The lab format and its parser are not involved.

Applies to vLabs **1.10.0**.

---

## 1. Creating an exam

Exams can be written in two places:

- **vLabs Template Studio** (`docs/vlabs_template_studio.html`): **New → New
  Exam**, or **Examples → E. Network Fundamentals Quiz**. It has the same
  parts (informational, questions, submit), question types, time
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
points, and give the correct answer. **Minutes** beside each section title
sets the time allocated to that section (§4.1).
**Add a section before the submit step** adds an informational section or a
questions section; the submit section always stays last. **Import** (a Studio
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

| Kind                        | Markdown heading   | Participant sees                                                       | Moves on when                    |
| --------------------------- | ------------------ | ---------------------------------------------------------------------- | -------------------------------- |
| **Informational**           | `# [info] Title`   | one or more steps of instructions (Markdown, images), each with a checklist | every checklist item is ticked   |
| **Questions** (the default) | `# Title`          | the questions                                                          | every question has an answer     |
| **Submit**                  | `# [submit] Title` | optional text, a review of what is answered, and **Submit**            | (the last step)                  |

**Informational** sections are for practical work the participant completes
before continuing. Like a lab section, one can hold several **steps**, shown
one at a time: e.g. *Cable the bench* (items *Switch is cabled*, *Link light
is green*), then *Instructor check* ("Call your instructor over", item *My
instructor has checked my bench*). The participant ticks each item themselves;
**Next step** opens once every item of the step is ticked, and the next
section once every item of the section is. **Nobody approves it in vLabs**: if
the instructor checks the work, they do it at the bench and record it on your
own grading sheet (linking that sheet to vLabs is future work). Ticks are
saved like answers, appear in the **Answer log** export with their time, and
are never graded. An informational section has no questions; give each step
instructions, a checklist, or both (up to 20 steps, 30 items per step).
Unticking an item locks every section after it again until it is ticked once
more.

**Submit** is always the last section, exactly once. Every new exam has one,
called *Review and submit*. Rename it, add text above the button (e.g. "Hand
your bench card to your instructor before you submit"), and choose whether it
shows the review: with **Show a review first** ticked, participants see how
many questions they answered, with links to any unanswered question or
unfinished checklist; unticked, they see only the text and the **Submit**
button. Nothing else is added: the page shows only what the template says. An exam imported without a submit section gets the default one, and
one placed anywhere else is moved to the end.

## 2b. Per-seat variables and saved answers

Exams use the same **tokens** as labs ([TEMPLATE_GUIDE.md](TEMPLATE_GUIDE.md)
§4): write `{{ NAME }}` in any section title, step title, instructions,
checklist item, question prompt, option or accepted answer, and each
participant sees their own value.

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
  literal pipe), `> capture: NAME` (short answers: save the answer as
  `{{ NAME }}` for later sections, §2b).
- `variables:` in the front matter, then one indented `NAME = formula` line
  per variable (§2b). In JSON: `"variables": [{ "name", "expression" }]` at
  the top level and `"capture": "NAME"` on a short question.
- `> minutes: N` directly under a `#` section heading allocates N minutes to
  that section: whole minutes, 1–600, optional (§4.1). In JSON it is
  `"minutes": N` on the section.
- `# [info] Title` starts an informational section (aliases
  `[informational]`, `[checklist]`, `[tasks]`). Each `## Step title` line
  starts a step (`## [step] Title` is the same; text before the first one is
  an untitled first step). A step's text is its instructions and its `- [ ]`
  lines its checklist (a `- [x]` is read the same way: participants always
  start unticked). Questions cannot go in it. Use `###` or smaller headings
  inside a step's instructions: `##` starts a new step and `#` a new section.
- `# [submit] Title` is the submit section (alias `[review]`). Its text is
  shown above the button; `> review: false` leaves out the review. Exports
  always write it.
- In JSON a section has `"type": "questions" | "info" | "submit"` (default
  questions); info sections carry `"steps": [{ "title", "body", "tasks":
  ["…"] }]`, the submit section `"body"` and `"review": true | false`.
  Sections saved by 1.9.0 (`"body"` and `"tasks"` on the section) are read
  as one step.
- Export → import round-trips losslessly.

## 4. During the exam

- **Sections unlock like a lab's.** One section per page. A participant
  starts with only the first section. The next one unlocks once **every
  question** in the current section has an answer, or **every checklist
  item** is ticked in an informational section; **Next** stays disabled
  until then. Locked sections are never sent to the browser and
  cannot be answered, so nobody can read ahead.
- **Free navigation, up to the furthest section reached.** Before
  submitting, participants can go back to any unlocked section and change
  answers. Progress stays at the furthest section they reached: clearing an
  earlier answer does not lock later sections again. Unticking a checklist
  item does: every section after it locks until it is ticked again. The
  **submit section**
  opens as soon as the last questions section does, so a participant can
  hand in with questions left blank; a checklist right before it must be
  ticked first. With the review on, it lists any unanswered questions and
  unfinished checklists.
- Answers **save automatically**: choices immediately, typed answers after a
  short pause or when the field loses focus. The header shows one save
  indicator for the whole exam (a cloud: *Saving…*, *Saved*, or *Not saved,
  retrying*). There is no mark beside each question, so "saved" is never
  mistaken for "correct". Leaving and rejoining with the same name resumes.
- **Informational** sections show one step at a time (*Step 1 of 3*), with
  its instructions and checklist; ticking an item saves it at once. A
  section always opens on its first step (also from the stepper); **Previous**
  from the section after it returns to its last step.
  **Next step** opens once every item of the step is ticked, and on the
  last step **Next** opens the following section.
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
  including checklist ticks (question `2.t0` = section 3, item 1, counting
  across its steps: *Ticked* / *Unticked*).
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
