import fs from 'node:fs';
import { Router } from 'express';
import config from '../config.js';
import { requireInstructor } from '../middleware/auth.js';

/**
 * Facts about this vLabs host for the portal, mounted at /api/server.
 * Instructors only.
 */
const router = Router();
router.use(requireInstructor);

/**
 * GET /api/server/addresses — the addresses participants can use to reach
 * this vLabs right now, e.g. ["https://vlabs.local", "https://10.0.0.23"].
 * On the Pi, deploy/pi/render-caddy.sh rewrites the file every time the
 * network changes, so this follows the Pi from network to network. Elsewhere
 * (no file) the list is empty and the portal shows nothing.
 */
router.get('/addresses', (req, res) => {
  let urls = [];
  let updatedAt = null;
  try {
    const data = JSON.parse(fs.readFileSync(config.addressesFile, 'utf8'));
    if (Array.isArray(data.urls)) {
      urls = data.urls.filter((u) => typeof u === 'string' && /^https?:\/\/[^\s/]+$/.test(u));
    }
    updatedAt = typeof data.updated_at === 'string' ? data.updated_at : null;
  } catch {
    // Not on a Pi install, or not rendered yet.
  }
  res.set('Cache-Control', 'no-store');
  res.json({ urls, updated_at: updatedAt });
});

export default router;
