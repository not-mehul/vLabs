/**
 * Minimal geometric line-icon set.
 *
 * Original icons drawn on a 24×24 grid with a consistent 1.75px stroke and
 * round joins — a clean, technical style. Icons inherit `currentColor` so they
 * take on the surrounding text colour, and expose an accessible label via
 * `title`/`aria-label` when used on their own.
 */

const P = {
  // Desk / physical action — a wrench (tool)
  desk: (
    <path d="M14.7 6.3a4 4 0 0 0-5.4 5.4l-5 5a1.5 1.5 0 0 0 2.1 2.1l5-5a4 4 0 0 0 5.4-5.4l-2.3 2.3-2.1-.6-.6-2.1 2.9-1.7Z" />
  ),
  // Computer / on-screen action — a monitor
  computer: (
    <>
      <rect x="3" y="4" width="18" height="12" rx="1.5" />
      <path d="M8 20h8M12 16v4" />
    </>
  ),
  // Informational step — a book (context to read, nothing to do)
  info: (
    <>
      <path d="M12 6.5C10.5 5.2 8.6 4.5 6.5 4.5H4v13h2.5c2.1 0 4 .7 5.5 2" />
      <path d="M12 6.5c1.5-1.3 3.4-2 5.5-2H20v13h-2.5c-2.1 0-4 .7-5.5 2" />
      <path d="M12 6.5v13" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M12 7.5V12l3 2" />
    </>
  ),
  lock: (
    <>
      <rect x="4.5" y="10.5" width="15" height="9" rx="1.5" />
      <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
    </>
  ),
  check: <path d="M5 12.5l4.5 4.5L19 7" />,
  'check-circle': (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M8.5 12.2l2.4 2.4 4.6-4.9" />
    </>
  ),
  chevronRight: <path d="M9 5l7 7-7 7" />,
  chevronLeft: <path d="M15 5l-7 7 7 7" />,
  chevronDown: <path d="M5 9l7 7 7-7" />,
  copy: (
    <>
      <rect x="9" y="9" width="11" height="11" rx="1.6" />
      <path d="M15 9V5.6A1.6 1.6 0 0 0 13.4 4H5.6A1.6 1.6 0 0 0 4 5.6v7.8A1.6 1.6 0 0 0 5.6 15H9" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </>
  ),
  moon: <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />,
  logout: (
    <>
      <path d="M15 8V5.5A1.5 1.5 0 0 0 13.5 4h-8A1.5 1.5 0 0 0 4 5.5v13A1.5 1.5 0 0 0 5.5 20h8a1.5 1.5 0 0 0 1.5-1.5V16" />
      <path d="M10 12h10m0 0-3-3m3 3-3 3" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  trash: (
    <>
      <path d="M4 7h16M9 7V4.5h6V7M6 7l1 12.5A1.5 1.5 0 0 0 8.5 21h7a1.5 1.5 0 0 0 1.5-1.5L18 7" />
    </>
  ),
  arrowUp: <path d="M12 19V5m0 0-6 6m6-6 6 6" />,
  arrowDown: <path d="M12 5v14m0 0 6-6m-6 6-6-6" />,
  user: (
    <>
      <circle cx="12" cy="8" r="3.5" />
      <path d="M5 20a7 7 0 0 1 14 0" />
    </>
  ),
  close: <path d="M6 6l12 12M18 6 6 18" />,
  hint: (
    <>
      <path d="M9 17h6M10 20h4" />
      <path d="M12 3a6 6 0 0 0-3.6 10.8c.6.5 1.1 1.2 1.3 2h4.6c.2-.8.7-1.5 1.3-2A6 6 0 0 0 12 3Z" />
    </>
  ),
  upload: (
    <>
      <path d="M12 15V4m0 0-4 4m4-4 4 4" />
      <path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  download: (
    <>
      <path d="M12 4v11m0 0-4-4m4 4 4-4" />
      <path d="M5 15v3.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V15" />
    </>
  ),
  refresh: (
    <>
      <path d="M20 12a8 8 0 1 1-2.3-5.6" />
      <path d="M20 4v3.5h-3.5" />
    </>
  ),
  eye: (
    <>
      <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
      <circle cx="12" cy="12" r="2.8" />
    </>
  ),
  layers: (
    <>
      <path d="M12 3 3 8l9 5 9-5-9-5Z" />
      <path d="M3 13l9 5 9-5" />
    </>
  ),
  key: (
    <>
      <circle cx="8" cy="8" r="4.2" />
      <path d="M11 11l7 7m-3 0 2-2m-4-1 2-2" />
    </>
  ),
  edit: (
    <>
      <path d="M4 20h4L18.6 9.4a2 2 0 0 0-2.8-2.8L5.2 17.2 4 20Z" />
      <path d="M14 8l2.8 2.8" />
    </>
  ),
  settings: (
    <>
      <path d="M4 7h9M18 7h2M4 12h2M9 12h11M4 17h6M15 17h5" />
      <circle cx="16" cy="7" r="2" />
      <circle cx="7" cy="12" r="2" />
      <circle cx="13" cy="17" r="2" />
    </>
  ),
  history: (
    <>
      <path d="M3 5v4h4" />
      <path d="M3.5 9a8.5 8.5 0 1 1-1 5" />
      <path d="M12 8v4.5l3 1.8" />
    </>
  ),
  undo: (
    <>
      <path d="M9 7 4 12l5 5" />
      <path d="M4 12h11a5 5 0 0 1 0 10h-2" />
    </>
  ),
  save: (
    <>
      <path d="M5 4h11l3 3v13H5z" />
      <path d="M8 4v5h7M8 20v-6h8v6" />
    </>
  ),
  play: <path d="M7 5.5 18.5 12 7 18.5z" />,
  power: (
    <>
      <path d="M12 4v8" />
      <path d="M7.6 7.2a7 7 0 1 0 8.8 0" />
    </>
  ),
};

export default function Icon({ name, size = 20, strokeWidth = 1.75, className = '', title }) {
  const path = P[name];
  if (!path) return null;
  return (
    <svg
      className={`icon ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      focusable="false"
    >
      {title ? <title>{title}</title> : null}
      {path}
    </svg>
  );
}
