/**
 * Image type detection from magic bytes — dependency-free so it can be unit
 * tested without a database. See lib/images.js for the library itself.
 */

/**
 * Detect the real image type from magic bytes. The client-sent Content-Type
 * is never trusted: a mislabelled HTML/SVG file served back as an "image"
 * would otherwise be a stored-XSS vector.
 *
 * @returns {{ mime: string, width: number|null, height: number|null } | null}
 */
export function sniffImage(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 12) return null;
  // PNG: 89 50 4E 47 0D 0A 1A 0A; IHDR width/height at 16..24
  if (buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return {
      mime: 'image/png',
      width: buf.length >= 24 ? buf.readUInt32BE(16) : null,
      height: buf.length >= 24 ? buf.readUInt32BE(20) : null,
    };
  }
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mime: 'image/jpeg', ...jpegSize(buf) };
  }
  // GIF: "GIF87a" / "GIF89a"; logical screen size at 6..10 (LE)
  if (buf.subarray(0, 3).toString('ascii') === 'GIF') {
    return { mime: 'image/gif', width: buf.readUInt16LE(6), height: buf.readUInt16LE(8) };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.subarray(0, 4).toString('ascii') === 'RIFF' &&
    buf.subarray(8, 12).toString('ascii') === 'WEBP'
  ) {
    return { mime: 'image/webp', width: null, height: null };
  }
  return null;
}

function jpegSize(buf) {
  // Walk JPEG segments to the first SOF marker (C0–CF except C4/C8/CC).
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return { width: null, height: null };
    const marker = buf[i + 1];
    const len = buf.readUInt16BE(i + 2);
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) {
      return { height: buf.readUInt16BE(i + 5), width: buf.readUInt16BE(i + 7) };
    }
    i += 2 + len;
  }
  return { width: null, height: null };
}
