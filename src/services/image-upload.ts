/**
 * D1 — uploaded event-graphic validation. A file upload is untrusted input, so
 * this NEVER trusts the client's Content-Type: the stored mime is derived purely
 * by sniffing the buffer's magic bytes, and only a small allowlist of web image
 * types is accepted. A hard size cap rejects oversized buffers before they reach
 * the database. The served Content-Type later comes from the sniffed mime here.
 */

/** Hard upload cap (~2 MB) — reject before storing. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

export type SniffedMime =
  | 'image/png'
  | 'image/jpeg'
  | 'image/gif'
  | 'image/webp';

/**
 * Sniff a buffer's magic bytes and return the matching allowlisted image mime,
 * or null if it is not a recognized PNG/JPEG/GIF/WEBP. The client's declared
 * content type is intentionally ignored.
 *
 *   PNG  : 89 50 4E 47
 *   JPEG : FF D8 FF
 *   GIF  : 47 49 46 38 ("GIF8")
 *   WEBP : 52 49 46 46 ("RIFF") .... 57 45 42 50 ("WEBP" at offset 8)
 */
export function sniffImageMime(buf: Buffer): SniffedMime | null {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
    return 'image/png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'image/jpeg';
  }
  if (buf.length >= 4 && buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38) {
    return 'image/gif';
  }
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return 'image/webp';
  }
  return null;
}

export type ImageValidation =
  | { ok: true; buffer: Buffer; mime: SniffedMime }
  | { ok: false; error: string };

/**
 * Validate an uploaded file buffer: enforce the size cap, then sniff. Returns a
 * friendly per-field error string on rejection (size or unrecognized type).
 */
export function validateImageUpload(buf: Buffer): ImageValidation {
  if (buf.length === 0) {
    return { ok: false, error: 'The uploaded file is empty.' };
  }
  if (buf.length > MAX_IMAGE_BYTES) {
    return { ok: false, error: 'Image is too large — uploads must be 2 MB or smaller.' };
  }
  const mime = sniffImageMime(buf);
  if (!mime) {
    return { ok: false, error: 'Unsupported file — upload a PNG, JPG, GIF, or WebP image.' };
  }
  return { ok: true, buffer: buf, mime };
}
