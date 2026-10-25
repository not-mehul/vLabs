/** Test fixtures shared by the format tests (not a test file itself). */

/** A lab in the documented Markdown convention (code fences, hints, alternatives). */
export const SAMPLE_MARKDOWN = `---
title: Sample Networking Lab
description: A two-section starter lab you can import and adapt.
variables:
  PORT_NUM = seat
  SEAT_TAG = 'S' + pad(seat, 2)
  HOST_IP = '10.0.0.' + (100 + seat)
  GATEWAY_IP = '192.168.1.' + (100 + seat)
---

# Section 1 · Bench Preparation

## [info] About this lab
Welcome, {{ FIRST_NAME }} — you are participant #{{ SEAT_ID }}. This lab walks you through
cabling a bench and configuring a static IP. Informational steps like this one are context
only: there is nothing to do here.

## [desk] Prepare your bench
1. Power on your workstation.
2. You have been assigned **switch port {{ PORT_NUM }}** (cable tag {{ SEAT_TAG }}).

> hint: Where is the patch panel? :: It is the grey unit above your desk.
> Look for the label matching your seat tag.

## [desk] Record your switch's serial number
Find the label on the underside of your switch and enter its serial number. The format is
four groups separated by dots, e.g. \`ABCD.1234.WXYZ\` — dots are optional when typing.

> checkpoint: Enter the serial number printed on the switch label
> pattern: XXXX.XXXX.XXXX
> capture: SERIAL
> placeholder: e.g. ABCD.1234.WXYZ

# Section 2 · Network Configuration

## [computer] Assign a static IP
Set your IP address to \`{{ HOST_IP }}\` and gateway to \`{{ GATEWAY_IP }}\`.

\`\`\`
# this comment inside a code block is not a section heading
sudo ip addr add {{ HOST_IP }}/24 dev eth0
\`\`\`

> hint: Command line :: sudo ip addr add {{ HOST_IP }}/24 dev eth0

## [computer] Confirm
You configured switch **{{ SERIAL }}** from seat {{ SEAT_TAG }}. Record your assigned Host IP
below to complete the lab.

> hint: How do I read my IP? :: Run \`ip addr show eth0\` and copy the IPv4 address.

> solution:
> Your Host IP is built from your seat number:
> - Base network: \`10.0.0.\`
> - Host octet: \`100 + seat\` → **{{ HOST_IP }}**

> checkpoint: Enter your Host IP address
> accept: {{ HOST_IP }} | {{ HOST_IP }}/24
> placeholder: e.g. 10.0.0.1XX
`;
