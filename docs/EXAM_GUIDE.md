# vLabs Exam Guide

Exams are a second template kind alongside labs. Participants join with a room
code exactly as they do for a lab, answer questions, and submit. **Correct
answers are never sent to participants and they never see a score.** The
instructor's session monitor grades automatically where it can, lets you mark
any answer by hand, and exports everything.

Exams have their **own** format (`shared/exam-schema.js`,
`shared/exam-format.js`). The lab format and its parser are not involved.

Applies to vLabs **1.5.0**.

---

## 1. Creating an exam

**Templates → New exam** opens the exam editor: sections ("parts"), each with
questions. For every question choose a type, write the prompt (Markdown, with
images by library file name, e.g. `![topology](topology.png)`), set the
points, and give the correct answer. **Import** / **.md** / **.json** read and
write the format below; **Sample .md** downloads a ready-made example. A
sample exam is also created on a fresh install.

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

## 3. Markdown format

```markdown
---
title: Network Fundamentals — Unit Test
description: 20 minutes, closed book
---

# Part 1 · Addressing

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
```

- `# ` starts a section, `## [type]` a question. Text after the type and the
  lines below it are the prompt (Markdown). Fenced code blocks are verbatim.
- Type aliases: `mcq` `choice` `radio` → single; `multi` `checkbox` →
  multiple; `tf` `true-false` → truefalse; `text` `short-answer` → short;
  `essay` `long-answer` → long.
- `- [ ]` / `- [x]` lines are options for single/multiple (`x` = correct).
- `> points: N`, `> answer: true|false`, `> accept: a | b` (write `\|` for a
  literal pipe).
- Export → import round-trips losslessly.

## 4. During the exam

- Every question is available at once, one section per page, plus a
  **Review & submit** page that lists unanswered questions.
- Answers **save automatically** (choices immediately, typed answers after a
  short pause or when the field loses focus) and can be changed until the
  exam is submitted. Leaving and rejoining with the same name resumes.
- **Submit** locks the exam; the participant sees a confirmation, never a
  score or the correct answers. When the session ends or expires, saved
  answers are kept.

## 5. Grading

The exam monitor shows:

- **Questions** — answered count, correct rate (over graded responses), and
  how many still need marking. Click a question to see every participant's
  response to it and mark them in one place.
- **Participants** — answered, score (`*` = provisional while answers still
  need marking), status. Click a row for their whole exam: each question with
  the options (correct and chosen highlighted), their response, the expected
  answer, the verdict, the history of changes to that answer, and
  **Correct / Incorrect / Clear** buttons.

A manual mark overrides the automatic verdict for that response; **Clear**
returns to it. Marks can be given during or after the session and record who
marked and when.

## 6. Exports

From the monitor:

- **Results CSV** — one row per participant: score, submission time, and for
  every question the response, result (correct / incorrect / needs marking /
  unanswered), points and who marked it.
- **Answer key** — every question with options and expected answer.
- **Answer log** — every answer change across the class, in time order.
- **JSON** — all of the above in one document.

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
