// Libraries the Studio used to load from CDNs, bundled so the offline build
// needs no network and the app build needs nothing but its own origin.
// (Markdown rendering comes from client/src/lib/markdown.js, see lab-core.js.)
import JSZip from 'jszip';

window.JSZip = JSZip;
