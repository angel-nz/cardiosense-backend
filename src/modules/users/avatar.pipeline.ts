import sharp from 'sharp'
import {
  InvalidImageError,
  UnsupportedMediaTypeError,
  AnimatedImageNotSupportedError,
  ImageDimensionsExceededError,
  ImageOutputTooLargeError,
  AvatarProcessingFailedError,
} from '@/lib/errors'
import { logger } from '@/lib/logger'

// The installed sharp version's shipped type declarations do not expose a
// usable `sharp.Sharp`/`sharp.Metadata` namespace under this project's
// `module: commonjs` + default-import setup (verified this block — a
// namespace-qualified reference fails to resolve). Deriving the instance
// and metadata types directly from the callable's own signature sidesteps
// that entirely and needs no namespace reference at all.
type SharpInstance = ReturnType<typeof sharp>
type SharpMetadata = Awaited<ReturnType<SharpInstance['metadata']>>

// Y3.1B §11 — the validation/normalization pipeline, isolated as a pure
// function (raw bytes in, normalized bytes out) so it can be exercised
// directly with real image fixtures without needing a running HTTP server,
// Multer, or a database. Steps 1-3 of §11 (multipart structure, 5MB
// parser-level cap, optional declared-MIME early filter) happen in the
// route/Multer layer BEFORE this function is ever called — everything here
// is step 4 onward, operating only on already-parsed raw bytes.

const MAX_DECODED_PIXELS = 20_000_000 // Y3.1B §12 — decompression-bomb guard
const OUTPUT_DIMENSION = 512 // Y3.1B §13
const OUTPUT_CEILING_BYTES = 300 * 1024 // Y3.1B §14
const QUALITY_LADDER = [82, 76, 70] as const // Y3.1B §14 — bounded, not a loop
const ACCEPTED_DECODED_FORMATS = new Set(['jpeg', 'png', 'webp'])

export interface NormalizedAvatar {
  data: Buffer
  mimeType: 'image/webp'
  byteSize: number
}

// sharp's own `limitInputPixels` guard throws a generic, non-code-bearing
// error at decode time — deliberately disabled here (`limitInputPixels:
// false`) in favor of an explicit metadata-based check below, which is what
// actually produces the frozen IMAGE_DIMENSIONS_EXCEEDED code every time
// (Y3.1B §12 — "and/or validate metadata before normalization").
function decode(raw: Buffer): SharpInstance {
  return sharp(raw, { failOn: 'error', limitInputPixels: false })
}

export async function normalizeAvatarUpload(raw: Buffer, userId: string): Promise<NormalizedAvatar> {
  // ── Step 4: decode attempt. Corrupt bytes, or bytes that are not an image
  // at all despite a plausible declared Content-Type/extension, fail here —
  // the declared type is never trusted (Y3.1B §10).
  let metadata: SharpMetadata
  try {
    metadata = await decode(raw).metadata()
  } catch {
    logger.warn('[Avatar] decode failed', { userId })
    throw new InvalidImageError()
  }

  // ── Step 5: the ACTUAL decoded format is authoritative, never the
  // declared Content-Type/extension (Y3.1B §10).
  const format = metadata.format
  if (!format || !ACCEPTED_DECODED_FORMATS.has(format)) {
    logger.warn('[Avatar] rejected unsupported decoded format', { userId, format })
    throw new UnsupportedMediaTypeError()
  }

  // ── Step 6: animated/multi-frame rejection. Sharp reports >1 for an
  // animated WebP or a multi-page/APNG-style PNG; a normal static image
  // reports 1 (or is undefined, treated as 1) (Y3.1A-FIX1 §20, Y3.1B §10).
  const pages = metadata.pages ?? 1
  if (pages > 1) {
    logger.warn('[Avatar] rejected animated/multi-frame image', { userId, pages })
    throw new AnimatedImageNotSupportedError()
  }

  // ── Step 7: decoded pixel ceiling — decompression-bomb guard, checked
  // from cheap header metadata BEFORE any expensive resize/encode work.
  const width = metadata.width ?? 0
  const height = metadata.height ?? 0
  if (width <= 0 || height <= 0) {
    logger.warn('[Avatar] decoded image reports invalid dimensions', { userId, width, height })
    throw new InvalidImageError()
  }
  if (width * height > MAX_DECODED_PIXELS) {
    logger.warn('[Avatar] rejected — decoded pixel count exceeds ceiling', { userId, width, height })
    throw new ImageDimensionsExceededError()
  }

  // ── Steps 8-12: auto-orient (consumes EXIF orientation, which is then
  // discarded along with all other metadata — Sharp never preserves input
  // metadata unless `.withMetadata()` is explicitly called, which it never
  // is here — Y3.1B §13), center-crop to a square, resize to the fixed
  // output dimension, then WebP-encode through the bounded quality ladder.
  // Any failure from here on is a genuine processing fault (input already
  // passed every validation check above), not an input-rejection — wrapped
  // as AvatarProcessingFailedError, never leaking the underlying Sharp
  // error's own message/stack to the caller (Y3.1B §15/§39).
  try {
    const base = decode(raw)
      .rotate()
      .resize(OUTPUT_DIMENSION, OUTPUT_DIMENSION, { fit: 'cover', position: 'centre' })

    for (const quality of QUALITY_LADDER) {
      const buffer = await base.clone().webp({ quality }).toBuffer()
      if (buffer.length <= OUTPUT_CEILING_BYTES) {
        return { data: buffer, mimeType: 'image/webp', byteSize: buffer.length }
      }
    }
  } catch (err) {
    logger.error('[Avatar] normalization pipeline failed unexpectedly', {
      userId,
      message: err instanceof Error ? err.message : 'unknown',
    })
    throw new AvatarProcessingFailedError()
  }

  // Step 12 (bounded): all three quality attempts still exceeded the
  // ceiling — a semantic rejection of this specific image's
  // compressibility, not a server fault (Y3.1B §14).
  logger.warn('[Avatar] output exceeded size ceiling after full quality ladder', { userId })
  throw new ImageOutputTooLargeError()
}
