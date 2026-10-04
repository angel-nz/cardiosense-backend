// NEW S2C — bit-exact binary64 transport for the decisive `appliedLogit`.
//
// WRITE: the JS number is rendered as its shortest round-trip decimal text
// (Number.prototype.toString, plus an explicit "-0") and bound as a TEXT
// parameter that PostgreSQL casts with `::text::float8` (float8in is
// correctly rounded, so the stored binary64 is exactly the JS value).
// READ: `float8send(applied_logit)` returns the 8 IEEE-754 big-endian bytes,
// decoded here bit-for-bit — independent of extra_float_digits, of the
// PostgreSQL version and of how any ORM/engine renders floats.
// The Prisma model API is never used for this value (S2A sandbox finding).

export function float8ToText(v: number): string {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new RangeError('float8ToText: finite number required')
  return Object.is(v, -0) ? '-0' : v.toString()
}

export function float8FromBigEndianBytes(bytes: Uint8Array): number {
  if (!(bytes instanceof Uint8Array) || bytes.length !== 8) throw new RangeError('float8 bytes must be exactly 8')
  return new DataView(bytes.buffer, bytes.byteOffset, 8).getFloat64(0, false)
}

export function float64Bits(v: number): string {
  const dv = new DataView(new ArrayBuffer(8)); dv.setFloat64(0, v, false)
  return dv.getBigUint64(0, false).toString(16).padStart(16, '0')
}
