import { useMemo } from 'react';
import { renderMarkdown } from '../lib/markdown.js';

/**
 * Render trusted-but-sanitised Markdown. Content originates from instructor
 * templates and is server-rendered per seat, but we still sanitise on the
 * client as defence-in-depth against stored XSS.
 */
export default function Markdown({ children }) {
  const html = useMemo(() => renderMarkdown(children), [children]);

  return <div className="md" dangerouslySetInnerHTML={{ __html: html }} />;
}
