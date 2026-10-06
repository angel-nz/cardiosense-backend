import { isIP } from 'node:net'
import type { Request } from 'express'

function firstHeaderValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value
}

function validIp(value: string | undefined): string | null {
  if (!value) return null
  const candidate = value.trim()
  if (!candidate) return null

  // RFC-style bracketed IPv6 is accepted defensively, although the canonical
  // proxy header normally carries the bare address.
  const normalized = candidate.startsWith('[') && candidate.endsWith(']')
    ? candidate.slice(1, -1)
    : candidate

  return isIP(normalized) ? normalized : null
}

/**
 * Canonical IP identity for IP-based rate limiting.
 *
 * Render public traffic traverses Cloudflare/Render proxy infrastructure. When
 * the trusted Render marker is active, only Cloudflare's overwritten
 * CF-Connecting-IP header is accepted as a forwarded client identity.
 * X-Forwarded-For is deliberately never used for security-sensitive rate-limit
 * identity. If the trusted Cloudflare header is unavailable or invalid, fall
 * back to the transport peer address instead of caller-controlled forwarding
 * metadata.
 *
 * Outside Render, forwarded headers are ignored and ordinary direct Express /
 * socket identity is preserved.
 */
export function rateLimitClientIp(req: Request): string {
  if (process.env.RENDER === 'true') {
    const cloudflareIp = validIp(firstHeaderValue(req.headers['cf-connecting-ip']))
    if (cloudflareIp) return cloudflareIp

    return validIp(req.socket.remoteAddress)
      ?? validIp(req.ip)
      ?? 'unknown'
  }

  return validIp(req.ip)
    ?? validIp(req.socket.remoteAddress)
    ?? 'unknown'
}
