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

/**
 * Render trusted-but-sanitised Markdown. Content originates from instructor
 * templates and is server-rendered per seat, but we still sanitise on the
 * client as defence-in-depth against stored XSS.
 */
export default function Markdown({ children }) {
  const html = useMemo(() => {
    const raw = marked.parse(String(children || ''));
    return DOMPurify.sanitize(raw, { USE_PROFILES: { html: true } });
  }, [children]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
