import bcrypt from 'bcryptjs';
import db from './index.js';
import config from '../config.js';
import { log } from '../lib/logger.js';

/**
 * Sample master template. Demonstrates every content feature:
 *   - Desk, Computer and Info (context-only) cards
 *   - mustache-style {{PLACEHOLDER}} variables resolved per participant,
 *     including the built-in {{ FIRST_NAME }}
 *   - a formula helper (pad) for zero-padded labels
 *   - collapsible hints (progressive disclosure) and a step-level solution
 *   - a pattern checkpoint (serial number of unknown value, known format) whose
 *     entry is captured as {{ SERIAL }} for later steps
 *   - an exact checkpoint that gates the following section
 */
const SAMPLE_VARIABLES = [
  { name: 'PORT_NUM', expression: 'seat' },
  { name: 'SEAT_TAG', expression: "'S' + pad(seat, 2)" },
  { name: 'GATEWAY_IP', expression: "'192.168.1.' + (100 + seat)" },
  { name: 'HOST_IP', expression: "'10.0.0.' + (100 + seat)" },
  { name: 'SUBNET', expression: "'255.255.255.0'" },
  { name: 'VLAN', expression: '10 + seat' },
];

const SAMPLE_CONTENT = [
  {
    title: 'Section 1 · Bench Preparation',
    steps: [
      {
        type: 'info',
        title: 'About This Lab',
        body:
          'Welcome, **{{ FIRST_NAME }}** — you are participant **#{{ SEAT_ID }}**.\n\n' +
          'This lab walks you through cabling a bench and configuring a static IP. ' +
          'Informational cards like this one are context only: there is nothing to do here.',
      },
      {
        type: 'desk',
        title: 'Prepare Your Bench',
        body:
          '1. Confirm your workstation is powered on.\n' +
          '2. Locate the patch panel above your desk.\n' +
          '3. You have been assigned **switch port {{ PORT_NUM }}**.\n\n' +
          '> Keep this manual open on your assigned iPad — it updates live for your seat.',
        hints: [
          {
            label: "Can't find the patch panel?",
            text: 'It is the horizontal grey unit at eye level, labelled with port numbers 1–24.',
          },
        ],
      },
      {
        type: 'desk',
        title: 'Physical Cabling',
        body:
          'Connect your physical patch cable to **Port {{ PORT_NUM }}** on the patch panel.\n\n' +
          'Route the cable neatly to your workstation NIC. Ensure the clip *clicks* into place.',
        hints: [
          {
            label: 'Which cable is mine?',
            text: 'Use the cable tagged **{{ SEAT_TAG }}** (your seat number, zero-padded).',
          },
        ],
      },
      {
        type: 'desk',
        title: 'Record the Switch Serial Number',
        body:
          'Find the label on the underside of your switch and enter its serial number. ' +
          'The format is four groups separated by dots, e.g. `ABCD.1234.WXYZ` — the dots ' +
          'are optional when typing.',
        hints: [],
        // Pattern checkpoint: the instructor cannot know each switch's serial,
        // only its format. The accepted value is normalised to the mask and
        // captured as {{ SERIAL }} for every later step.
        checkpoint: {
          prompt: 'Enter the serial number printed on the switch label',
          placeholder: 'e.g. ABCD.1234.WXYZ',
          mode: 'pattern',
          pattern: 'XXXX.XXXX.XXXX',
          capture: 'SERIAL',
        },
      },
    ],
  },
  {
    title: 'Section 2 · Network Configuration',
    steps: [
      {
        type: 'computer',
        title: 'Assign a Static IP',
        body:
          'On your workstation, open the network settings and apply this configuration:\n\n' +
          '| Setting | Value |\n' +
          '| --- | --- |\n' +
          '| IP Address | `{{ HOST_IP }}` |\n' +
          '| Subnet Mask | `{{ SUBNET }}` |\n' +
          '| Default Gateway | `{{ GATEWAY_IP }}` |\n' +
          '| VLAN | `{{ VLAN }}` |\n\n' +
          'Apply the settings and wait for the link light to turn solid green.',
        hints: [
          {
            label: 'Command-line alternative',
            text: 'Linux: `sudo ip addr add {{ HOST_IP }}/24 dev eth0 && sudo ip route add default via {{ GATEWAY_IP }}`',
          },
        ],
      },
      {
        type: 'computer',
        title: 'Verify Connectivity',
        body:
          'Ping the gateway to confirm your link is live:\n\n' +
          '```\nping {{ GATEWAY_IP }}\n```\n\n' +
          'You should see replies with a TTL of 64. Record your assigned Host IP ' +
          'below to complete this section.',
        hints: [
          {
            label: 'How do I read my IP?',
            text: 'Run `ip addr show eth0` (Linux) or `ipconfig` (Windows) and copy the IPv4 address.',
          },
        ],
        // Step-level markdown solution, revealed only after every hint is opened.
        solution:
          'Your Host IP is built from your seat number:\n\n' +
          '- Base network: `10.0.0.`\n' +
          '- Host octet: `100 + seat` → **{{ HOST_IP }}**\n\n' +
          'Read it live with `ip addr show eth0`.',
        checkpoint: {
          prompt: 'Enter your assigned Host IP address to complete this section',
          placeholder: 'e.g. 10.0.0.1XX',
          // Answers are computed per seat and never sent to the browser. The
          // CIDR form is accepted as an alternative.
          answer: '{{ HOST_IP }}',
          answers: ['{{ HOST_IP }}/24'],
        },
      },
    ],
  },
  {
    title: 'Section 3 · Wrap Up',
    steps: [
      {
        type: 'desk',
        title: 'Wrap Up',
        body:
          'Excellent work, {{ FULL_NAME }} (seat #{{ SEAT_ID }}).\n\n' +
          '- Label your cable and leave it connected to **Port {{ PORT_NUM }}**.\n' +
          '- Switch **{{ SERIAL }}** stays at this bench.\n' +
          '- Raise your hand for the instructor to validate your bench.\n\n' +
          'Your gateway was **{{ GATEWAY_IP }}** and your host was **{{ HOST_IP }}**.',
        hints: [],
      },
    ],
  },
];

const SAMPLE_TITLE = 'Network Bench Setup (Sample)';
const SAMPLE_DESCRIPTION =
  'A three-section introductory networking lab demonstrating desk/computer/info cards, per-participant variables, hints, a pattern checkpoint that captures a serial number, and a section checkpoint.';

/** True when no instructor exists yet, i.e. the seeder is about to create one. */
export function needsBootstrapInstructor() {
  return db.prepare('SELECT COUNT(*) AS n FROM instructors').get().n === 0;
}

/**
 * Idempotently ensure a bootstrap instructor and a sample template exist.
 * Safe to call on every start-up.
 */
export function ensureSeed() {
  let instructorId;
  if (needsBootstrapInstructor()) {
    const hash = bcrypt.hashSync(config.seedInstructor.password, 10);
    const info = db
      .prepare('INSERT INTO instructors (username, password_hash) VALUES (?, ?)')
      .run(config.seedInstructor.username, hash);
    instructorId = info.lastInsertRowid;
    log.info('seed.instructor', { username: config.seedInstructor.username });
  } else {
    instructorId = db.prepare('SELECT id FROM instructors ORDER BY id LIMIT 1').get().id;
  }

  const templateCount = db.prepare('SELECT COUNT(*) AS n FROM templates').get().n;
  if (templateCount === 0) {
    const info = db
      .prepare(
        `INSERT INTO templates (title, description, content, variables, version, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        SAMPLE_TITLE,
        SAMPLE_DESCRIPTION,
        JSON.stringify(SAMPLE_CONTENT),
        JSON.stringify(SAMPLE_VARIABLES),
        instructorId,
      );
    const username = db
      .prepare('SELECT username FROM instructors WHERE id = ?')
      .get(instructorId).username;
    const snapshot = JSON.stringify({
      title: SAMPLE_TITLE,
      description: SAMPLE_DESCRIPTION,
      content: SAMPLE_CONTENT,
      variables: SAMPLE_VARIABLES,
    });
    db.prepare(
      `INSERT INTO template_audit (template_id, template_title, action, version, snapshot, instructor_id, instructor_username)
       VALUES (?, ?, 'created', 1, ?, ?, ?)`,
    ).run(info.lastInsertRowid, SAMPLE_TITLE, snapshot, instructorId, username);
    log.info('seed.template', { title: SAMPLE_TITLE });
  }
}

// Allow `npm run seed` as a standalone command.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSeed();
  console.log('  Seeding complete.');
  process.exit(0);
}
