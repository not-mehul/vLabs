import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ breaks: true, gfm: true });

// Open every rendered link in a new tab, safely. Registered once at module load.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A' && node.hasAttribute('href')) {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer nofollow');
  }
});

const SANITIZE_OPTIONS = {
  USE_PROFILES: { html: true },
  // Inline style attributes are stripped: the production CSP no longer allows
  // 'unsafe-inline' styles, so they would be ignored by the browser anyway,
  // and authored content should not be able to restyle the surrounding UI.
  FORBID_ATTR: ['style'],
  FORBID_TAGS: ['style', 'form', 'input', 'button'],
};

/**
 * Render trusted-but-sanitised Markdown. Content originates from instructor
 * templates and is server-rendered per seat, but we still sanitise on the
 * client as defence-in-depth against stored XSS.
 */
export default function Markdown({ children }) {
  const html = useMemo(() => {
    const raw = marked.parse(String(children || ''));
    return DOMPurify.sanitize(raw, SANITIZE_OPTIONS);
  }, [children]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
