import bcrypt from 'bcryptjs';
import db from './index.js';
import config from '../config.js';

/**
 * Sample master template. Demonstrates every content feature:
 *   - Desk Action vs Computer Action cards
 *   - mustache-style {{PLACEHOLDER}} variables resolved per seat
 *   - collapsible hints (progressive disclosure)
 *   - a state checkpoint that gates the following step
 */
const SAMPLE_VARIABLES = [
  { name: 'PORT_NUM', expression: 'seat' },
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
        type: 'desk',
        title: 'Prepare Your Bench',
        body:
          'Welcome, participant **#{{ SEAT_ID }}**.\n\n' +
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
            text: 'Use the cable tagged with your seat number ({{ SEAT_ID }}).',
          },
        ],
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
        checkpoint: {
          prompt: 'Enter your assigned Host IP address to complete this section',
          placeholder: 'e.g. 10.0.0.1XX',
          // Answer is computed per seat and never sent to the browser.
          answer: '{{ HOST_IP }}',
          // Markdown solution, revealed only after every hint is opened.
          solution:
            'Your Host IP is built from your seat number:\n\n' +
            '- Base network: `10.0.0.`\n' +
            '- Host octet: `100 + seat` → **{{ HOST_IP }}**\n\n' +
            'Read it live with `ip addr show eth0`.',
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
          'Excellent work, participant #{{ SEAT_ID }}.\n\n' +
          '- Label your cable and leave it connected to **Port {{ PORT_NUM }}**.\n' +
          '- Raise your hand for the instructor to validate your bench.\n\n' +
          'Your gateway was **{{ GATEWAY_IP }}** and your host was **{{ HOST_IP }}**.',
        hints: [],
      },
    ],
  },
];

/**
 * Idempotently ensure a bootstrap instructor and a sample template exist.
 * Safe to call on every start-up.
 */
export function ensureSeed() {
  const instructorCount = db
    .prepare('SELECT COUNT(*) AS n FROM instructors')
    .get().n;

  let instructorId;
  if (instructorCount === 0) {
    const hash = bcrypt.hashSync(config.seedInstructor.password, 10);
    const info = db
      .prepare('INSERT INTO instructors (username, password_hash) VALUES (?, ?)')
      .run(config.seedInstructor.username, hash);
    instructorId = info.lastInsertRowid;
    console.log(
      `  Seeded bootstrap instructor "${config.seedInstructor.username}".`,
    );
  } else {
    instructorId = db.prepare('SELECT id FROM instructors LIMIT 1').get().id;
  }

  const templateCount = db
    .prepare('SELECT COUNT(*) AS n FROM templates')
    .get().n;
  if (templateCount === 0) {
    const info = db
      .prepare(
        `INSERT INTO templates (title, description, content, variables, version, created_by)
         VALUES (?, ?, ?, ?, 1, ?)`,
      )
      .run(
        'Network Bench Setup (Sample)',
        'A three-section introductory networking lab demonstrating desk/computer cards, per-seat variables, hints and a section checkpoint.',
        JSON.stringify(SAMPLE_CONTENT),
        JSON.stringify(SAMPLE_VARIABLES),
        instructorId,
      );
    const username = db
      .prepare('SELECT username FROM instructors WHERE id = ?')
      .get(instructorId).username;
    const snapshot = JSON.stringify({
      title: 'Network Bench Setup (Sample)',
      description:
        'A three-section introductory networking lab demonstrating desk/computer cards, per-seat variables, hints and a section checkpoint.',
      content: SAMPLE_CONTENT,
      variables: SAMPLE_VARIABLES,
    });
    db.prepare(
      `INSERT INTO template_audit (template_id, template_title, action, version, snapshot, instructor_id, instructor_username)
       VALUES (?, ?, 'created', 1, ?, ?, ?)`,
    ).run(info.lastInsertRowid, 'Network Bench Setup (Sample)', snapshot, instructorId, username);
    console.log('  Seeded sample template "Network Bench Setup".');
  }
}

// Allow `npm run seed` as a standalone command.
if (import.meta.url === `file://${process.argv[1]}`) {
  ensureSeed();
  console.log('  Seeding complete.');
  process.exit(0);
}
