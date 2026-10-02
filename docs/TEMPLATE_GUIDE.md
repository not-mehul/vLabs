# vLabs Template Authoring Guide

This is the one document you need to write a lab template for any course and
know it will import, validate and behave the way you expect. It covers the
template model, the authoring Markdown format, every rule the server enforces,
the formula and pattern languages, how delivery and gating work for
participants, and complete example templates for different kinds of courses.

Applies to vLabs **1.4.0**.

---

## Contents

1. [How a template becomes a class](#1-how-a-template-becomes-a-class)
2. [The template model](#2-the-template-model)
3. [Authoring in Markdown](#3-authoring-in-markdown)
4. [Variables and formulas](#4-variables-and-formulas)
5. [Placeholders](#5-placeholders)
6. [Steps](#6-steps)
7. [Hints and solutions](#7-hints-and-solutions)
8. [Checkpoints](#8-checkpoints)
9. [Pattern checkpoints: the mask language](#9-pattern-checkpoints-the-mask-language)
10. [Captured values](#10-captured-values)
11. [How participants experience the lab](#11-how-participants-experience-the-lab)
12. [Writing good step bodies (Markdown that renders)](#12-writing-good-step-bodies)
    - [Links](#links)
    - [Images](#images)
13. [Limits](#13-limits)
14. [Validation errors and what they mean](#14-validation-errors-and-what-they-mean)
15. [Live classes: versions, pushing, reordering](#15-live-classes-versions-pushing-reordering)
16. [Authoring checklist](#16-authoring-checklist)
17. [Example templates](#17-example-templates)
    - [A. Network bench (IP addressing, seat-derived values)](#a-network-bench)
    - [B. Device provisioning (serials, MACs, captured values)](#b-device-provisioning)
    - [C. Software onboarding (name-derived accounts, info-heavy)](#c-software-onboarding)
    - [D. Minimal skeleton to copy](#d-minimal-skeleton)
18. [JSON format](#18-json-format)

---

## 1. How a template becomes a class

1. You write a **template**: a title, optional description, a list of
   **variables** (formulas), and ordered **sections** of ordered **steps**.
2. You create it in the instructor portal (**Templates → New**), either by
   typing in the editor or by **importing** a `.md` or `.json` file. The
   editor shows a live warning for unknown placeholders, has a **Preview**
   that renders the manual for any seat number, and keeps a change history
   with revert.
3. **Saving validates** the whole template. If any rule in this guide is
   broken the save is refused and every problem is listed with its location
   ("Section 2 · step 3 checkpoint answer"). Nothing partial is stored.
4. You **launch a session** from the template. The session takes a frozen
   **copy**; participants join with a 6-digit room code and their name, get a
   **seat number** (1, 2, 3… in join order) and see the manual rendered for
   their seat and name.
5. Editing the template later never changes a running class until you press
   **Push latest version** on the session monitor (see §15).

Everything the server personalises comes from three sources: the **seat
number**, the participant's **registered name**, and **values they entered at
checkpoints** (captures). Design your variables around those.

---

## 2. The template model

```
Template
├── title            required, ≤ 200 chars
├── description      optional, ≤ 1000 chars (shown in the template list)
├── variables[]      { name, expression }   formulas evaluated per participant
└── content[]        Sections, in order
    ├── title        required (may contain placeholders)
    └── steps[]      in order
        ├── type         desk | computer | info
        ├── title        optional (defaults to "Step N")
        ├── body         required Markdown, may contain {{ PLACEHOLDERS }}
        ├── hints[]      { label, text }        (not on info steps)
        ├── solution     Markdown                (not on info steps)
        └── checkpoint   null or {              (not on info steps)
              prompt, placeholder,
              mode: exact | pattern,
              answer, answers[]   (exact)
              pattern             (pattern)
              capture             optional variable name
            }
```

Order matters everywhere: sections gate one another, steps reveal in order,
variables can reference earlier variables, and captured values are available
only to later steps.

---

## 3. Authoring in Markdown

The Markdown format is the recommended way to write templates: it is
readable, diff-able, and round-trips losslessly through the editor's
**Export → Markdown**. Import it with **Templates → New → Import** (or the
Import button inside any editor to replace the current draft).

### 3.1 Anatomy

```markdown
---
title: Switch Bench Lab
description: One-line summary shown in the template list
variables:
  PORT_NUM = seat
  HOST_IP = '10.0.0.' + (100 + seat)
---

# Section 1 · Bench preparation

## [info] About this lab
Context the participant should read. Nothing to do here.

## [desk] Prepare your bench
Body of the step. **Markdown** works. You are on port {{ PORT_NUM }}.

> hint: Where is the patch panel? :: The grey unit above your desk.
> Continuation lines of the same hint, until a blank line.

> solution:
> A multi-line walkthrough, revealed once every hint is opened.
> - bullets work

> checkpoint: Enter your host IP :: {{ HOST_IP }} | {{ HOST_IP }}/24
> placeholder: e.g. 10.0.0.1XX

## [computer] Read the serial
Find the label on the device.

> checkpoint: Enter the serial number
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
> placeholder: e.g. ABCD.1234.WXYZ

# Section 2 · Use it

## [desk] Label the device
Write **{{ SERIAL }}** on the label and attach it.
```

### 3.2 Syntax reference

| Element | Syntax | Notes |
| --- | --- | --- |
| Front matter | `---` … `---` at the very top | Keys: `title`, `description`, `variables`. Optional but strongly recommended (a template without a title cannot be saved). |
| Title / description | `title: …`, `description: …` | Single line each. The value runs to the end of the line, colons inside are fine. |
| Variables block | `variables:` then **indented** `NAME = expression` lines | One per line. The block ends at the first non-indented line. |
| Section | `# Title` | Required before steps; a step before any `#` gets an implicit "Section 1". Text directly under `#` (before the first `##`) is **discarded**. |
| Step | `## [type] Title` | `[desk]`, `[computer]` or `[info]`; omitted → `desk`. Title is everything after the bracket. |
| Body | Plain lines under `##` | Everything that is not a directive. Markdown. Fenced code (``` or ~~~) is copied verbatim — `#` and `>` inside a fence are not interpreted. |
| Hint | `> hint: Label :: Text` | Further `> …` lines continue the text until a blank line or another directive. Label defaults to "Hint" if empty. |
| Solution | `> solution:` then `> …` lines | Text after the colon on the same line is allowed as the first line. Ends at a blank line or non-quoted line. |
| Exact checkpoint | `> checkpoint: Prompt :: answer \| alt1 \| alt2` | `::` separates prompt from answers, `\|` separates alternatives. |
| Pattern checkpoint | `> checkpoint: Prompt` **then** `> pattern: MASK` | No `::` part. `> pattern:` switches the checkpoint to pattern mode even if an answer was given (the answer is dropped). |
| Capture | `> capture: NAME` | On either kind of checkpoint. Must follow the `> checkpoint:` line. |
| Input placeholder | `> placeholder: text` | Grey example text in the answer box. Must follow the `> checkpoint:` line (ignored otherwise). |
| Link | `[text](https://…)` | Opens in a new tab. Placeholders allowed in the URL. See §12. |
| Image | `![alt](file-name.png "title")` | File name of a library image (upload in Settings → Images). See §12. |
| Literal `::` | `\::` | In hint labels/text, prompts and answers. |
| Literal `\|` | `\|` | In answers. |

### 3.3 Ordering rules inside a step

- Put the **body first**, then hints, then solution, then the checkpoint.
  Body lines that appear after a directive are still appended to the body,
  but it reads badly and is easy to get wrong.
- **Leave a blank line after a hint or solution block.** A `> quoted` body
  line directly after a hint is treated as part of the hint.
- Blank lines between a directive and the next thing are layout, not content;
  the importer drops them so export → import does not grow gaps.
- One checkpoint per step. A second `> checkpoint:` line replaces the first.

### 3.4 Round-trip guarantee

Export → Markdown → Import produces an identical template (this is tested).
So you can author in the editor, export, keep the `.md` in version control,
and re-import into another instance.

---

## 4. Variables and formulas

Variables are **formulas evaluated per participant** when content is
rendered. Declare them in the front matter (or Settings tab). Each has a
**name** and an **expression**.

### 4.1 Names

- Letters, digits and underscore; must not start with a digit
  (`[A-Za-z_][A-Za-z0-9_]*`). Convention: `UPPER_SNAKE_CASE`.
- Unique within the template.
- **Reserved** (cannot be used as a variable or capture name): `SEAT_ID`,
  `FIRST_NAME`, `LAST_NAME`, `FULL_NAME`, `seat`, `first_name`, `last_name`,
  and every helper function name (`pad`, `hex`, `floor`, `ceil`, `round`,
  `abs`, `mod`, `min`, `max`, `upper`, `lower`, `str`, `slug`, `initials`).

### 4.2 What goes into an expression

| Element | Example | Notes |
| --- | --- | --- |
| Numbers | `100`, `3.5`, `.5` | Decimal only. `1.` (trailing dot) is invalid. |
| Strings | `'10.0.0.'`, `"O'Brien"` | Single or double quotes. No escape sequences: a string containing `'` must use double quotes and vice-versa. |
| Built-ins | `seat`, `first_name`, `last_name` | `seat` is a number (1, 2, 3…); the names are strings exactly as the participant typed them (trimmed). |
| Earlier variables | `HOST_IP + '/24'` | Only variables declared **above** the current one. |
| Arithmetic | `+ - * / %`, parentheses, unary minus | Standard precedence. `/` produces decimals (`7 / 2` → `3.5`); use `floor()`. Division or modulo by zero is an error. |
| Concatenation | `'S' + seat` → `S7` | `+` concatenates when **either** side is a string; otherwise it adds. `'1' + 2` → `12`, `1 + 2` → `3`. |
| Helpers | `pad(seat, 2)` | Whitelisted pure functions only (below). Nothing else is callable. |

Max expression length 500 characters, nesting depth 32. Anything outside this
grammar — unknown identifiers, `constructor`, semicolons, assignment, `=`,
comparisons, `if` — is rejected at save time.

### 4.3 Helper functions

| Function | Result | Example (seat 7, Mary-Jane O'Neil) |
| --- | --- | --- |
| `pad(value, width [, char])` | Left-pad to `width` with `char` (default `0`) | `pad(seat, 3)` → `007`; `pad(seat, 2, ' ')` → ` 7` |
| `hex(n)` | Lower-case hexadecimal of an integer | `hex(seat + 15)` → `16`; `pad(hex(seat), 2)` → `07` |
| `floor(n)`, `ceil(n)`, `round(n)`, `abs(n)` | Usual maths | `floor(seat / 2)` → `3` |
| `mod(a, b)` | Mathematical modulo (never negative for b > 0) | `mod(seat, 4)` → `3` |
| `min(a, b, …)`, `max(a, b, …)` | Up to 16 arguments | `min(seat, 24)` → `7` |
| `upper(s)`, `lower(s)` | Case | `upper(first_name)` → `MARY-JANE` |
| `str(v)` | Force a value to be a string (so `+` concatenates) | `str(seat) + str(seat)` → `77` |
| `slug(s)` | Lower-case letters and digits only — everything else removed | `slug(first_name)` → `maryjane`; `slug(last_name)` → `oneil` |
| `initials(s)` | First letter of each whitespace-separated word, upper-case | `initials(first_name + ' ' + last_name)` → `MO` |

### 4.4 Recipes

```
# Addressing from the seat number
HOST_IP     = '10.0.0.' + (100 + seat)
GATEWAY_IP  = '192.168.1.' + (100 + seat)
HOST_CIDR   = HOST_IP + '/24'
VLAN        = 10 + seat
MGMT_PORT   = 8000 + seat

# Grouping seats into benches / pods of 4
POD         = ceil(seat / 4)
POD_MEMBER  = mod(seat - 1, 4) + 1
POD_SUBNET  = '172.16.' + POD + '.0/24'

# Labels and identifiers
SEAT_TAG    = 'S' + pad(seat, 2)
MAC_SUFFIX  = pad(hex(seat), 2)
DEVICE_NAME = 'cam-' + slug(last_name) + '-' + pad(seat, 2)

# Accounts derived from the participant's name
USERNAME    = slug(first_name) + '.' + slug(last_name)
EMAIL       = USERNAME + '@lab.example'
INITIALS    = initials(first_name + ' ' + last_name)
DISPLAY     = first_name + ' (' + SEAT_TAG + ')'

# Alternating roles
ROLE        = mod(seat, 2)              # 1 = odd seats, 0 = even seats
PARTNER     = seat + 1 - 2 * mod(seat + 1, 2)   # pairs 1↔2, 3↔4 …
```

Formulas are checked at save time by evaluating them for **seat 1, "Sample
Participant"** — so a formula must at least work for that input. There is no
conditional logic; if you need different text for different seats, derive a
value (`ROLE`) and write the body so it reads correctly either way, or split
the cohort into two templates/sessions.

Numbers render as JavaScript prints them (`3.5`, `0.30000000000000004`).
Use `round`/`floor` or `pad` when a value is displayed.

---

## 5. Placeholders

Write `{{ NAME }}` (spaces optional: `{{NAME}}`) anywhere text is shown or
compared:

- section titles, step titles, step bodies
- hint labels and hint text
- solutions
- checkpoint prompts, input placeholders, exact answers and alternatives

A placeholder may be:

| Placeholder | Value |
| --- | --- |
| `{{ SEAT_ID }}` | the seat number |
| `{{ FIRST_NAME }}`, `{{ LAST_NAME }}` | as registered (trimmed, original casing) |
| `{{ FULL_NAME }}` | `First Last` |
| `{{ ANY_VARIABLE }}` | a declared formula |
| `{{ ANY_CAPTURE }}` | a value captured by an earlier checkpoint (§10) |

Rules:

- **Every placeholder must resolve.** Saving is refused for an unknown name,
  with the exact location. The editor underlines the same problems live.
- A **capture** is only known from the step **after** its checkpoint. Using it
  earlier (including in the body of the capturing step itself) is an error
  ("used before the checkpoint that captures it").
- Placeholders are substituted as plain text, then the body is rendered as
  Markdown. So `**{{ HOST_IP }}**` is bold, and a value inside a code fence
  stays literal text.
- Placeholders inside fenced code blocks **are** substituted (handy for
  per-seat commands).

---

## 6. Steps

Three step types. The type changes the card's look and what the step may
contain:

| Type | Card label | Colour | May contain | Use for |
| --- | --- | --- | --- | --- |
| `desk` | **Hands-On** | orange | hints, solution, checkpoint | physical work at the bench: cabling, mounting, reading labels |
| `computer` | **Workstation** | blue | hints, solution, checkpoint | work on a machine or in a UI: configure, run commands, verify |
| `info` | **Read** | neutral, dashed edge | body only | context, background, safety notes, "what you will do" |

- `info` steps are **context only**. Hints, solution and checkpoint written
  on an info step are silently removed on save and the card shows only the
  body. They never block progress.
- A step **body is required** (non-empty). Titles are optional; an empty
  title renders as "Step N".
- Steps number within their section (`2 / 5`) on the participant's card.
- Up to 100 steps per section, 100 sections.

---

## 7. Hints and solutions

**Hints** are collapsible panels under the body. Each has a short **label**
(the clickable prompt — phrase it as the question a stuck participant would
ask: "Which cable is mine?") and Markdown **text**. Opening a hint is
recorded: the monitor shows hints-taken per participant, and hint opens gate
the solution.

**Solution** is an optional Markdown walkthrough for the step. A participant
can reveal it **only after opening every hint on that step**; until then it
never leaves the server. Design consequence: a step with a solution and
**no hints** makes the solution available immediately. If you want friction,
give the step at least one hint. Revealed solutions are counted on the
monitor (`· 1 sol` next to hints).

Neither hints nor solutions are available on `info` steps. Up to 20 hints per
step; hint text ≤ 4000 chars, solution ≤ 4000 chars.

---

## 8. Checkpoints

A checkpoint is an answer box at the bottom of a step. Clearing it is what
**unlocks** the next content (see §11). Any `desk` or `computer` step may have
one; at most one per step.

Common fields:

| Field | Required | Notes |
| --- | --- | --- |
| `prompt` | no | The question above the box. Defaults to "Enter the value to continue". May use placeholders. ≤ 300 chars. |
| `placeholder` | no | Grey example text inside the box. Use it to show the expected format. ≤ 120 chars. |
| `mode` | — | `exact` (default) or `pattern`. |
| `capture` | no | Save the accepted value as a variable (§10). |

### 8.1 Exact checkpoints

The participant's entry must equal the **answer** or one of the
**alternatives** after both sides are normalised: trimmed, runs of
whitespace collapsed, lower-cased. Answers may contain placeholders and are
resolved per participant, so `{{ HOST_IP }}` is a different expected value
on every seat.

```markdown
> checkpoint: Enter your assigned host IP :: {{ HOST_IP }} | {{ HOST_IP }}/24
> placeholder: e.g. 10.0.0.1XX
```

- Up to 10 alternatives; duplicates and copies of the primary are dropped.
- Each answer ≤ 200 chars; a participant may type up to 500.
- The expected answers are **never sent to the browser**. The server
  compares and answers `correct: true/false`. Wrong answers are rate-limited
  (30 per minute per seat) to blunt guessing.
- Good exact answers are things the participant must **discover or
  produce** — a value shown by a command, a count of LEDs, the string a
  device displays — not something printed earlier in the manual.

### 8.2 Pattern checkpoints

For values **you cannot know in advance** but whose **format** you know:
serial numbers, MAC addresses, ticket IDs, asset tags, a timestamp they
read off a screen. Instead of an answer you give a **mask**; any entry that
fits passes.

```markdown
> checkpoint: Enter the serial number on the underside label
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
> placeholder: e.g. ABCD.1234.WXYZ
```

The mask is not sent to the browser either; the participant sees the prompt
and your placeholder. If their entry does not fit, the error message says
"That doesn't look like the expected format (e.g. ABCD.1234.WXYZ)" using the
placeholder, so always provide one for pattern checkpoints.

A pattern checkpoint proves the participant **found a value of the right
shape**, not that it is the right value. Pair it with a capture and reuse the
value later (e.g. ask them to enter the same serial in a web UI, then check
the UI shows it), or have the instructor verify on the monitor.

---

## 9. Pattern checkpoints: the mask language

A mask is a string where each character means:

| Char | Matches | Stored as |
| --- | --- | --- |
| `9` | one digit `0-9` | as typed |
| `A` | one letter | **UPPER** case |
| `a` | one letter | **lower** case |
| `X` | one letter or digit | **UPPER** case |
| `x` | one letter or digit | **lower** case |
| `?` | any one visible character (not a space) | as typed |
| `*` | one or more characters, anything | as typed (at most three `*` per mask) |
| `\c` | the literal character `c`, **required** — escape a wildcard letter to match it literally (`\A`), or a separator to make it mandatory (`99\.99`) | the literal |
| any other **letter or digit** | that character, required (case-insensitive) | as written in the mask |
| **punctuation or space** | an optional separator — the participant may type it or leave it out | always inserted, as in the mask |

Matching is **case-insensitive** throughout; the stored ("canonical") value
applies the casing the mask asks for and restores the separators. Leading and
trailing whitespace of the entry is ignored; internal spaces are only allowed
where the mask has a space.

Examples:

| Mask | Accepts | Rejects | Stored |
| --- | --- | --- | --- |
| `XXXX.XXXX.XXXX` | `ABCD.1234.WXYZ`, `abcd1234wxyz`, `abcd.1234.wxyz` | `abcd-1234-wxyz` (wrong separator), `ABCD.1234.WXY` (short) | `ABCD.1234.WXYZ` |
| `XX:XX:XX:XX:XX:XX` | `a1:b2:c3:d4:e5:f6`, `A1B2C3D4E5F6` | `a1-b2-c3-d4-e5-f6` | `A1:B2:C3:D4:E5:F6` |
| `SN-99999999` | `sn12345678`, `SN-12345678` | `12345678` (missing literal SN), `SN-1234` | `SN-12345678` |
| `INC9999999` | `inc0012345` | `INC12345` | `INC0012345` |
| `99:99` | `0730`, `07:30` | `7:30` (needs 4 digits) | `07:30` |
| `AAA-999` | `abc-123`, `ABC123` | `ab-123` | `ABC-123` |
| `aaaa` | `MARY` | `Mar1` | `mary` |
| `v9.9.9` | `V1.2.3`, `v123` | `1.2.3` (needs the v) | `v1.2.3` |
| `*@*` | `mary@example.com` | `mary` | as typed |
| `??-9` | `a#-1`, `@!1` | `a -1` | as typed |
| `\A\A9` | `AA7` | `BB7` | `AA7` |
| `99\.99` | `12.34` | `1234` (escaped dot is required) | `12.34` |

Rules:

- A mask must contain at least one wildcard (`9 A a X x ? *`); a mask that
  would accept only one string is rejected ("use an exact answer instead").
- Masks are ≤ 120 characters. There is no regular-expression mode on
  purpose — masks are predictable and cannot be made to hang the server.
- The editor shows a generated example beside the mask as you type
  (`AB12.CD34.EFAB` for `XXXX.XXXX.XXXX`); copy it into the placeholder.
- Separators you want to be **required** must be escaped (`99\.99` requires
  the dot; `99.99` accepts `1234` too). Letters/digits used as literals are
  always required.
- Because matching is lenient (`abcd1234wxyz` passes), state the format in
  the body so participants also learn the real notation.

---

## 10. Captured values

Any checkpoint can save the accepted entry as a **variable** for the rest of
the lab:

```markdown
> checkpoint: Enter the serial number
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
```

From the **next step onward** (including all later sections) `{{ SERIAL }}`
works everywhere a placeholder works: bodies, titles, hints, solutions,
prompts, placeholders — and in the **exact answers of later checkpoints**, so
you can ask them to re-enter the same value ("Type the serial you registered
to confirm") and the server checks it matches their own earlier entry.

What is stored:

- Pattern checkpoint → the **canonical** value (mask casing, separators
  restored): `abcd1234wxyz` becomes `ABCD.1234.WXYZ`.
- Exact checkpoint → the **authored answer that matched**, with placeholders
  resolved and its original casing (so capturing `{{ HOST_IP }}` stores
  `10.0.0.107`, not whatever spacing the participant used).

Rules:

- Capture names follow variable-name rules, are not reserved, are not already
  a declared variable, and are unique across the template.
- Captures are **placeholders only** — formulas cannot use them (formulas are
  checked at save time, when no participant has typed anything yet). If you
  need a derived value, ask for it directly or show both.
- Until a participant reaches the capturing checkpoint the value does not
  exist; that is why references before it are refused at save time.
- Captured values show on the **session monitor** (one column per capture)
  and in **CSV/JSON exports** — useful for records ("which serial did seat 12
  install?").
- If the instructor pushes a template version that renames a capture, values
  stored under the old name are kept but no longer referenced.

---

## 11. How participants experience the lab

Understanding delivery helps you place checkpoints well.

- A participant only ever receives **the sections they have unlocked**.
  Section *n* unlocks once **every checkpoint in sections 0 … n−1** is
  cleared. A section with no checkpoint is cleared immediately.
- Within the furthest unlocked section, steps are revealed **up to and
  including the first step whose checkpoint is still open**. Clearing it
  reveals the rest of the section (up to the next open checkpoint).
- A participant counts as **complete** the moment every section is cleared
  (and the last section has been opened) — their clock stops and the monitor
  shows *Complete* even if they keep reviewing. **Finish** then shows the
  completion screen; it is not required.
- Participants can always navigate **back** to earlier sections to review;
  the stepper shows locked sections greyed out.
- Hints, solutions, checkpoints and progress reports all go through the same
  reachability gate: a participant cannot act on a step they cannot see.
- Rejoining with the same name (any case) resumes the same seat, progress and
  captured values, so a closed tab is not a disaster.

Design patterns:

| Goal | Do this |
| --- | --- |
| Gate the next section | Put a checkpoint on the **last** step of the section. |
| Hide the rest of a section until something is done | Put a checkpoint on a **middle** step; later steps in that section stay hidden. |
| A free-reading section (briefing, safety) | No checkpoint; use `info` steps. Participants can walk straight through. |
| Make sure something was *done* rather than *read* | Ask for a value that only exists after doing it (a serial, the output of a command, an LED count). |
| Confirm a value against the participant's own earlier input | Capture it, then an exact checkpoint whose answer is `{{ THAT_CAPTURE }}`. |
| Prevent peeking ahead | The server never sends locked content; nothing to do — but avoid printing later answers in earlier hints. |

Time: the session has an expiry (set at launch, extendable with **+30**).
The participant sees a countdown; when the session ends or expires every
request is rejected and the lab closes.

---

## 12. Writing good step bodies

Bodies are rendered with GitHub-flavoured Markdown and sanitised.

- **Line breaks are literal**: a single newline becomes a line break. Write
  paragraphs as continuous lines, or accept the break.
- Headings inside a body (`###` and smaller) are fine; `#` and `##` at the
  start of a line start a new section/step — put such text in a code fence
  if you really need a literal leading `#`.
- Code fences (``` or ~~~) render as code blocks and are safe from the
  importer; placeholders inside them are still substituted:

  ````markdown
  ```
  sudo ip addr add {{ HOST_IP }}/24 dev eth0
  sudo ip route add default via {{ GATEWAY_IP }}
  ```
  ````

- Tables, bold, italics, inline code, numbered and bulleted lists, block
  quotes (`>` lines — but see §3.3 about placing them after hints) all work.
- Raw HTML, `style` attributes, forms and buttons are stripped. Links and
  images have their own rules — see below.
- Keep bodies short and imperative. One action per step, the thing to verify
  stated explicitly ("the link light turns solid green"). Put the "why" in an
  `info` step or a hint.
- Speak to the participant by name sparingly: `{{ FIRST_NAME }}` in a
  welcome and a wrap-up is warm; in every step it is noise.

### Links

Standard Markdown links work in bodies, hints and solutions:

```markdown
Open the [claim console](https://console.example/claim) and sign in.
Download the [bench checklist](https://intranet.example/labs/checklist.pdf).
Reference: <https://docs.example/switch-cli>
```

- `[text](url)` renders a link; a bare `<https://…>` is auto-linked. Plain
  `https://…` text without brackets is **not** turned into a link.
- Every link opens in a **new tab** (`target="_blank"`, `rel="noopener"`),
  so the participant never loses their place in the lab. There is no way to
  open a link in the same tab.
- Placeholders work inside URLs: `[your device](https://console.example/devices/{{ SERIAL }})`
  or `[bench {{ SEAT_ID }} camera](http://10.0.0.{{ SEAT_ID }}/)`. Write the
  placeholder where the value goes; it is substituted before rendering. If a
  value could contain spaces or `&`, build it with `slug()` first.
- Reachability is the participant's network, not the Pi's: on an isolated
  classroom LAN, internet URLs will not load. Prefer LAN addresses or say
  "ask the instructor for the handout".
- Links in `info` steps are the natural home for background reading;
  links in a task step should be the thing to click to do the task.
- `mailto:` and `tel:` links render but are rarely useful on shared kiosks.
  `javascript:` URLs are removed by the sanitiser.

### Images

Images come from the instance's **image library** (Settings → Images in the
editor, or drag files onto that panel). Reference a library image by its
**file name** with standard Markdown image syntax:

```markdown
![Patch panel, front view](patch-panel-front.png)

Connect the cable as shown:

![Cable routing](images/cable-route.jpg "Route under the desk lip")
```

- Supported: **PNG, JPEG, GIF, WebP**, up to **3 MB** each. Not supported:
  SVG (script risk), PDF, video. The server checks the real bytes, not the
  extension.
- The reference is the **file name only**. A folder prefix such as
  `images/` is ignored (so a `.md` written alongside an `images/` folder
  imports unchanged), matching is **case-insensitive**, and spaces or other
  odd characters in a name are turned into `-` on upload (`Rack Diagram
  (v2).PNG` → `Rack-Diagram-v2.PNG`). The editor's **Markdown** button on
  each library image copies a ready-made snippet.
- The alt text in `[…]` is read by screen readers and shown if the image
  can't load — make it describe the picture ("Rear of switch with console
  port circled"), not "image".
- An optional `"title"` after the name becomes the hover tooltip.
- **Saving is refused while a referenced image is missing** from the library
  (`Image "x.png" referenced in Section 2 · step 1 body is not in the image
  library`). After a `.md` import the editor lists the missing names and
  offers **Upload missing**; drop the files in and save.
- The library is **shared across all templates** on an instance. Prefix names
  by course (`net-lab-rack.png`, `cam-unbox-label.jpg`) to avoid collisions.
  Uploading a file under an existing name asks before **replacing** it — a
  replacement updates every template that uses that name.
- An image can be deleted only when no template and no active session still
  references it.
- **Per-seat images:** a placeholder in the name picks a different file per
  participant, e.g. `![Your bench](bench-{{ SEAT_ID }}.png)` with
  `bench-1.png … bench-24.png` in the library, or `![Pod map](pod-{{ POD }}.png)`.
  Dynamic names cannot be checked at save time, so make sure every possible
  value has a file; a missing one shows as "(unavailable)".
- Images are sized to the card width and keep their aspect ratio; portrait
  photos will be tall — crop before uploading. Keep files small (a 1200 px
  wide JPEG is plenty; the Pi serves 100 seats).
- Images are served from the app (`/api/images/<random-id>/<name>`) under an
  unguessable id, so they load on an offline LAN and the file name never
  appears in a URL. External `https://…` images are **not** rendered (the
  page's security policy blocks them; they show as "(unavailable)"), and a
  `data:` URI inline is allowed but counts against the 20 000-character body
  limit — use the library instead.
- Moving a template to another instance: export the `.md` (or JSON), copy the
  image files, upload them there under the same names.

---

## 13. Limits

| Item | Limit |
| --- | --- |
| Variables | 100 |
| Sections | 100 |
| Steps per section | 100 |
| Hints per step | 20 |
| Alternative answers per checkpoint | 10 |
| Title / section title / step title | 200 chars |
| Description | 1000 chars |
| Step body | 20 000 chars |
| Hint label / hint text | 120 / 4000 chars |
| Solution | 4000 chars |
| Checkpoint prompt / placeholder / answer | 300 / 120 / 200 chars |
| Mask | 120 chars, ≤ 3 `*` |
| Image file | 3 MB; PNG/JPEG/GIF/WebP; name ≤ 80 chars |
| Capture name | 40 chars |
| Expression | 500 chars, nesting 32 |
| Whole template (JSON) | 900 kB |
| Participants per session | 100 |
| Participant answer input | 500 chars |

Text beyond a per-field limit is truncated on import; counts beyond a
structural limit are reported as errors.

---

## 14. Validation errors and what they mean

Saving (and importing a draft into Preview) runs every rule and returns all
problems at once. Locations read `Section N · step M <field>`.

| Message | Cause → fix |
| --- | --- |
| `Title is required` | Empty front-matter `title`. |
| `At least one section is required` / `Section N has no steps` | Add `#` / `##` headings. |
| `Section N needs a title` | `#` with nothing after it. |
| `Section N · step M has an empty body` | Every step needs body text (info steps too). |
| `Variable #N is missing a name` / `has an invalid name` | Fix the `NAME = expr` line; names are `[A-Za-z_][A-Za-z0-9_]*`. |
| `Variable "X" is reserved` | Rename; see §4.1. |
| `Variable "X" is declared more than once` | Remove the duplicate. |
| `Variable "X" has no formula` | Right-hand side empty. |
| `Error in variable "X": …` | The formula failed for seat 1 — unknown identifier (declared below it? typo?), unknown function, division by zero, bad token. |
| `Unknown placeholder {{ X }} in …` | Declare the variable, fix the spelling, or (if it is a capture) move the reference after the capturing step. |
| `{{ X }} is used in … before the checkpoint that captures it` | Captures exist from the following step onward. |
| `… checkpoint pattern: Pattern has no wildcards …` | Use an exact answer, or add `9/A/X/?/*`. |
| `… checkpoint pattern: Pattern is empty / too long / ends with a dangling backslash / may use * at most three times` | Fix the mask. |
| `… checkpoint: "X" is not a valid variable name` | Capture names follow variable rules. |
| `… checkpoint: variable name "X" is reserved` | Built-in or helper name. |
| `… checkpoint: "X" is already a declared variable` / `already captured by Section …` | Pick another name. |
| `Image "x.png" referenced in … is not in the image library — upload it first` | Upload the file (same name, folders ignored) in Settings → Images, or fix the reference. |
| `Too many variables / sections / steps / hints / alternative answers` | Over a structural limit (§13). |
| `Template is too large` | Over 900 kB — usually an embedded image. |

A checkpoint whose answer (exact) or mask (pattern) is empty is not an
error: it is treated as **no checkpoint** and dropped. Watch for this when a
`> checkpoint:` line is missing its `::` part and no `> pattern:` follows.

---

## 15. Live classes: versions, pushing, reordering

- Saving a template bumps its **version**. Running sessions keep the version
  they were launched with; the monitor shows "v N available".
- **Push latest version** copies the new version into the live session.
  Participants reload within ~15 s. Cleared checkpoints are keyed by
  position (`section.step`), so they are re-evaluated against the new
  structure: **inserting or reordering steps before a cleared checkpoint can
  move participants forwards or backwards**. Text-only fixes are safe to
  push mid-class; structural changes are better left for the next session.
- Captured values are keyed by name, so renaming a capture orphans the
  stored value (participants would have to re-clear the checkpoint).
- Archiving a template hides it from the launcher without affecting sessions;
  permanent deletion is refused while sessions from it are active.

---

## 16. Authoring checklist

Before you save or hand a template to someone else:

- [ ] Front matter has a `title`; `description` says who the lab is for.
- [ ] Every variable works for seat 1 and makes sense for seat 100 (`100 +
      seat` → `.200`; does your subnet allow it? Pods of 4 → 25 pods?).
- [ ] Every `{{ PLACEHOLDER }}` is declared, built-in, or a capture used
      *after* its checkpoint (the editor banner is empty).
- [ ] Each section that should gate the next ends with a checkpoint; sections
      meant to be read freely have none.
- [ ] Exact answers are discoverable, not printed earlier; alternatives cover
      obvious equivalent forms (`/24`, with/without unit, trailing dot).
- [ ] Pattern checkpoints have a placeholder showing the format, and the
      body states the real notation.
- [ ] Steps with a solution have at least one hint (or you accept instant
      reveal).
- [ ] Every `![…](name)` image is in the library (the editor's Images panel
      shows no "missing" banner); dynamic names have a file for every value.
- [ ] Links point at addresses participants can actually reach from the
      classroom network.
- [ ] `info` steps carry no directives (they would be dropped anyway).
- [ ] Preview as seat 1, 7 and 100; check padding, wrapping of long values
      and that nothing says `⟨missing:…⟩`.
- [ ] Export to Markdown and keep it with the course materials.

---

## 17. Example templates

All four import and validate as-is (this is checked). Copy one and adapt.

### A. Network bench

Seat-derived addressing, hints, a solution, exact checkpoints with
alternatives, an info briefing.

````markdown
---
title: Switch & Host Addressing — Bench Lab
description: Cable a bench, assign a static IP, verify connectivity. 60 min, 24 seats.
variables:
  PORT_NUM    = seat
  SEAT_TAG    = 'S' + pad(seat, 2)
  VLAN        = 10 + seat
  HOST_IP     = '10.0.0.' + (100 + seat)
  HOST_CIDR   = HOST_IP + '/24'
  GATEWAY_IP  = '192.168.1.' + (100 + seat)
  SUBNET      = '255.255.255.0'
  POD         = ceil(seat / 4)
  POD_MEMBER  = mod(seat - 1, 4) + 1
---

# Section 1 · Briefing

## [info] Welcome
Welcome, {{ FIRST_NAME }} — you are **seat {{ SEAT_ID }}**, bench pod {{ POD }} (member {{ POD_MEMBER }} of 4).

In this lab you will cable your workstation to switch port {{ PORT_NUM }}, assign a static address and prove the link works. Values in **bold** are specific to your seat; your neighbour's will differ.

## [info] Safety
- Power down before touching the patch panel.
- Route cables under the desk lip, never across the aisle.

# Section 2 · Cabling

## [desk] Find your port
Locate **port {{ PORT_NUM }}** on the patch panel. It is labelled with your seat tag **{{ SEAT_TAG }}**.

> hint: Where is the patch panel? :: The grey 24-port unit at eye level above your desk.

## [desk] Connect the patch cable
Connect the cable tagged **{{ SEAT_TAG }}** from port {{ PORT_NUM }} to your workstation NIC. Push until the clip *clicks*.

Count the link LEDs lit on the patch panel for your pod (ports {{ POD }}1–{{ POD }}4 area) and enter the number of **amber** LEDs you see on **your** port to continue.

> hint: No LED at all? :: Reseat both ends; an unlit port means no electrical link yet.
> A solid amber LED means 100 Mb/s, green means 1 Gb/s.

> checkpoint: How many amber LEDs are lit on your port? :: 0 | 1
> placeholder: 0 or 1

# Section 3 · Configuration

## [computer] Assign a static IP
Apply this configuration to your workstation:

| Setting | Value |
| --- | --- |
| IP address | `{{ HOST_IP }}` |
| Subnet mask | `{{ SUBNET }}` |
| Default gateway | `{{ GATEWAY_IP }}` |
| VLAN | `{{ VLAN }}` |

> hint: Command line (Linux) :: ```
> sudo ip addr add {{ HOST_CIDR }} dev eth0
> sudo ip route add default via {{ GATEWAY_IP }}
> ```

## [computer] Verify connectivity
Ping the gateway and confirm replies with TTL 64:

```
ping -c 4 {{ GATEWAY_IP }}
```

Then read your own address back and enter it below.

> hint: How do I read my IP? :: `ip addr show eth0` (Linux) or `ipconfig` (Windows); copy the IPv4 address.

> solution:
> Your host address is built from your seat number: `10.0.0.` + (100 + {{ SEAT_ID }}) = **{{ HOST_IP }}**.
> If ping fails, check the gateway is `{{ GATEWAY_IP }}` and the mask is `{{ SUBNET }}`.

> checkpoint: Enter the IPv4 address shown on your workstation :: {{ HOST_IP }} | {{ HOST_CIDR }}
> placeholder: e.g. 10.0.0.1XX

# Section 4 · Wrap up

## [info] Done
Nice work, {{ FULL_NAME }}. Leave the cable connected to port {{ PORT_NUM }} and raise your hand for a bench check. Your host was **{{ HOST_IP }}** on VLAN {{ VLAN }}.
````

### B. Device provisioning

Pattern checkpoints for serial and MAC, captures reused in later steps and
in a confirming exact checkpoint, name-derived device naming.

```markdown
---
title: Camera Provisioning — Unbox to Online
description: Unbox a camera, record its identifiers, claim it in the console, verify it streams. 45 min.
variables:
  BENCH        = 'B' + pad(seat, 2)
  DEVICE_NAME  = 'cam-' + slug(last_name) + '-' + pad(seat, 2)
  SITE         = 'Training Floor ' + ceil(seat / 10)
  CLAIM_URL    = 'https://console.example/claim'
---

# Section 1 · Identify the device

## [info] What you will do
{{ FIRST_NAME }}, you are at bench **{{ BENCH }}**. You will unbox one camera, record its serial number and MAC address, claim it under the name **{{ DEVICE_NAME }}** and confirm it comes online.

## [desk] Record the serial number
Unbox the camera. The serial is on the white label on the back, four groups separated by dots. Enter it below (dots optional).

> hint: Which label? :: The one with the QR code. The serial starts after "S/N".

> checkpoint: Enter the serial number printed on the label
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
> placeholder: e.g. ABCD.1234.WXYZ

## [desk] Record the MAC address
On the same label, below the serial, is the MAC address: six pairs separated by colons.

> checkpoint: Enter the MAC address
> pattern: XX:XX:XX:XX:XX:XX
> capture: MAC
> placeholder: e.g. A1:B2:C3:D4:E5:F6

# Section 2 · Claim and name

## [computer] Claim the camera
Open {{ CLAIM_URL }} and claim serial **{{ SERIAL }}**. When prompted:

| Field | Value |
| --- | --- |
| Name | `{{ DEVICE_NAME }}` |
| Site | `{{ SITE }}` |

The console shows the MAC it discovered. It must read **{{ MAC }}** — if it does not, you claimed the wrong unit; unclaim and retry.

> hint: Claim fails with "already claimed" :: The camera was used in a previous class. Ask the instructor to release serial {{ SERIAL }}.

> checkpoint: Type the device name exactly as you entered it in the console :: {{ DEVICE_NAME }}
> placeholder: cam-…

## [computer] Confirm the identity
To prove you are looking at your own device, re-enter the serial the console shows on the device page.

> checkpoint: Serial shown on the console device page :: {{ SERIAL }}
> placeholder: the serial you recorded earlier

# Section 3 · Verify

## [desk] Power and link
Connect the camera to the PoE port on bench {{ BENCH }}. Within 90 s the status LED turns solid blue.

> hint: LED stays amber :: Amber = booting or no network. Wait 2 minutes, then reseat the cable.

## [computer] Confirm it streams
In the console, open **{{ DEVICE_NAME }}** → Live. Note the firmware version shown in the Info panel and enter it (format `v` major.minor.patch).

> checkpoint: Firmware version shown
> pattern: v99.9.9
> capture: FIRMWARE
> placeholder: e.g. v12.3.4

# Section 4 · Wrap up

## [info] Record
Done. For the records: bench {{ BENCH }}, serial **{{ SERIAL }}**, MAC **{{ MAC }}**, named **{{ DEVICE_NAME }}**, firmware {{ FIRMWARE }}. Leave the camera powered; the instructor will release it after class.
```

### C. Software onboarding

Info-heavy with name-derived accounts, a `*` wildcard pattern, and an exact
checkpoint on a value the participant must look up.

````markdown
---
title: Developer Onboarding — First Pull Request
description: Create your account, clone the repo, open a PR. Self-paced, 90 min.
variables:
  USERNAME   = slug(first_name) + '.' + slug(last_name)
  EMAIL      = USERNAME + '@lab.example'
  INITIALS   = initials(first_name + ' ' + last_name)
  BRANCH     = 'onboarding/' + slug(last_name) + '-' + pad(seat, 2)
  TICKET     = 'ONB-' + pad(seat, 4)
---

# Section 1 · Accounts

## [info] Your identity in this lab
Hi {{ FIRST_NAME }}. Everything you create today uses these values — keep this page open:

| Item | Value |
| --- | --- |
| Username | `{{ USERNAME }}` |
| Email | `{{ EMAIL }}` |
| Initials | `{{ INITIALS }}` |
| Branch | `{{ BRANCH }}` |
| Ticket | `{{ TICKET }}` |

## [computer] Create your account
Sign up at the lab portal with username `{{ USERNAME }}` and email `{{ EMAIL }}`. The welcome email contains a one-time code of six digits.

> hint: No email after 2 minutes :: Check the spam folder, then ask the instructor to resend for {{ EMAIL }}.

> checkpoint: Enter the six-digit code from the welcome email
> pattern: 999999
> capture: WELCOME_CODE
> placeholder: e.g. 482913

# Section 2 · The repository

## [computer] Clone and branch
```
git clone https://git.lab.example/training/hello.git
cd hello
git checkout -b {{ BRANCH }}
```

## [computer] Make the change
Add a file `contributors/{{ USERNAME }}.md` containing your initials `{{ INITIALS }}` and commit it with the message `{{ TICKET }}: add {{ USERNAME }}`.

Run `git log --oneline -1` and enter the short commit hash (7 hex characters).

> hint: What is a short hash? :: The first 7 characters of the commit id, e.g. `a1b2c3d`.

> checkpoint: Short commit hash of your commit
> pattern: xxxxxxx
> capture: COMMIT
> placeholder: e.g. a1b2c3d

# Section 3 · The pull request

## [computer] Open the PR
Push `{{ BRANCH }}` and open a pull request titled `{{ TICKET }}: add {{ USERNAME }}`. The PR page URL ends in `/pull/<number>`.

> checkpoint: Paste the PR URL
> pattern: *\/pull\/*
> capture: PR_URL
> placeholder: https://git.lab.example/training/hello/pull/42

## [computer] Confirm the commit is in the PR
Open the PR's **Commits** tab. The hash listed must be the one you recorded. Enter it again to confirm.

> checkpoint: Short hash shown in the PR's Commits tab :: {{ COMMIT }}

# Section 4 · Done

## [info] Summary
{{ FULL_NAME }} ({{ USERNAME }}) opened {{ PR_URL }} from branch `{{ BRANCH }}` with commit `{{ COMMIT }}`. A reviewer will pick it up; you are done.
````

### D. Minimal skeleton

The smallest template that exercises every feature. It validates as-is;
replace the wording and keep the structure.

```markdown
---
title: Course Name — Lab Name
description: Who it is for, how long it takes, how many seats.
variables:
  SEAT_TAG = 'S' + pad(seat, 2)
---

# Section 1 · Briefing

## [info] What you will do
{{ FIRST_NAME }}, you are seat {{ SEAT_ID }} (tag {{ SEAT_TAG }}). Read this, then start.

# Section 2 · First task

## [desk] Do the thing
Imperative instructions for one action. State what success looks like.

> hint: The question a stuck person asks :: The nudge that gets them moving.

> checkpoint: What value proves it was done? :: {{ SEAT_TAG }} | S{{ SEAT_ID }}
> placeholder: e.g. S07

# Section 3 · Second task

## [computer] Record something you cannot predict
Where to find it and in what notation.

> checkpoint: Enter the asset tag
> pattern: AAA-9999
> capture: ASSET
> placeholder: e.g. ABC-1234

## [computer] Use it
Attach the label **{{ ASSET }}** and re-enter the tag to confirm.

> checkpoint: Confirm the asset tag :: {{ ASSET }}

# Section 4 · Wrap up

## [info] Done
What to leave as-is and what to hand in. Your tag was {{ ASSET }}.
```

---

## 18. JSON format

JSON is the canonical, lossless form (**Export → JSON**). It is the same
shape the editor and the API use, so it is also what you would generate from
another tool. Keys not listed are ignored on import; missing ones default.

```json
{
  "title": "Camera Provisioning — Unbox to Online",
  "description": "Unbox a camera, record its identifiers, claim it, verify it streams.",
  "variables": [
    { "name": "BENCH", "expression": "'B' + pad(seat, 2)" },
    { "name": "DEVICE_NAME", "expression": "'cam-' + slug(last_name) + '-' + pad(seat, 2)" }
  ],
  "content": [
    {
      "title": "Section 1 · Identify the device",
      "steps": [
        {
          "type": "info",
          "title": "What you will do",
          "body": "{{ FIRST_NAME }}, you are at bench **{{ BENCH }}**.",
          "hints": [],
          "solution": "",
          "checkpoint": null
        },
        {
          "type": "desk",
          "title": "Record the serial number",
          "body": "The serial is on the white label on the back.",
          "hints": [{ "label": "Which label?", "text": "The one with the QR code." }],
          "solution": "",
          "checkpoint": {
            "prompt": "Enter the serial number printed on the label",
            "placeholder": "e.g. ABCD.1234.WXYZ",
            "mode": "pattern",
            "answer": "",
            "answers": [],
            "pattern": "XXXX.XXXX.XXXX",
            "capture": "SERIAL"
          }
        },
        {
          "type": "computer",
          "title": "Confirm the identity",
          "body": "Re-enter the serial the console shows.",
          "hints": [],
          "solution": "",
          "checkpoint": {
            "prompt": "Serial shown on the console device page",
            "placeholder": "",
            "mode": "exact",
            "answer": "{{ SERIAL }}",
            "answers": [],
            "pattern": "",
            "capture": ""
          }
        }
      ]
    }
  ]
}
```

- `mode` may be omitted: a checkpoint with an `answer` is exact, one with
  only a `pattern` is pattern.
- `hints`, `solution`, `answers`, `pattern`, `capture` may be omitted.
- On an `info` step, `hints`/`solution`/`checkpoint` are ignored.
