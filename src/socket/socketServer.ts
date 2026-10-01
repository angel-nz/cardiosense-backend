import type { Server as HTTPServer } from 'http'
import { Server as IOServer } from 'socket.io'
import { verifyAccessToken } from '@/lib/jwt'
import { assertActiveSession, type ActiveSessionCheck } from '@/lib/session'
import { logger } from '@/lib/logger'
import { env } from '@/config/env'
import { prisma } from '@/config/prisma'

// Y8D3 — module-level handle to the one Socket.IO server this process ever
// creates (`setupSocket()` is called exactly once, from index.ts's
// bootstrap). This mirrors the existing `io?: IOServer` dependency-
// injection pattern already used by patient/record/prediction/alert's
// `create*Router(io)`/`create*Controller(io)` factories (io is always
// optional there too, e.g. for tests that build the app without a socket
// server) — but auth.routes.ts and user.routes.ts are plain, non-factory
// Express Routers with no DI seam of their own, and retrofitting them into
// that factory pattern would mean also changing app.ts's wiring and
// auth.routes.ts, which is unrelated surface area for what this block
// needs. This is the "smallest explicit accessor" Y8D3 §10 asks for
// instead: a safe getter that is simply `undefined` before `setupSocket()`
// has run (e.g. in a unit test that never calls it), so every consumer
// below is written to no-op rather than crash in that case.
let ioInstance: IOServer | undefined

export function getIO(): IOServer | undefined {
  return ioInstance
}

// Y8D3 §9 — the canonical single-session revocation helper. Targets the
// `session:${sid}` room every live socket for that exact session already
// joined at handshake time (see the connection handler below), using the
// stock socket.io v4 broadcast-operator API — no Redis/new adapter, no new
// infrastructure. Best-effort and NEVER throws: by the time any caller
// reaches this (logout, single-session revoke), the authoritative DB
// revoke has already succeeded (Y8D3 §11) — this is realtime cleanup on
// top of an already-final DB state, not a source of truth itself. Zero
// matching sockets (nothing was connected, or `setupSocket()` never ran)
// is a successful no-op, not an error.
export function disconnectSessionSockets(sid: string): void {
  const io = ioInstance
  if (!io) return
  try {
    io.in(`session:${sid}`).disconnectSockets(true)
  } catch (err) {
    logger.warn('[Socket] Best-effort session disconnect failed after authoritative DB revoke — a residual live socket may survive until its own next disconnect/reconnect, but any NEW handshake for this sid will still be rejected by assertActiveSession', {
      sid,
      err: err instanceof Error ? err.message : err,
    })
  }
}

// Y8D3 §15/§18 — the bulk "revoke every OTHER session of this user"
// counterpart (DELETE /me/sessions/others, PATCH /me/password), used
// instead of a sid-list collected from a separate query. Y8C originally
// anticipated changing revokeOtherSessions()/revokeAllSessions() to return
// the exact revoked sid list, then disconnecting each one — that would
// require a query-then-deleteMany two-step whose result window has a real
// (if narrow) race: a session created between the query and the delete
// could be missed. This instead re-reads LIVE socket state, AFTER the
// authoritative DB revoke has already committed, starting from the
// existing `user:${userId}` room (already joined by every live socket for
// this user, unchanged from before this block).
//
// Y8D3-FIX1 (Defect B) — an EARLIER version of this helper then disconnected
// every candidate purely because its `socket.data.sessionId !== keepSid`,
// which raced a NEW, legitimately-created session for this same user: if
// that session's socket joined `user:${userId}` between the authoritative
// DB revoke and this function's `fetchSockets()` call, its sessionId also
// isn't `keepSid`, but it was never part of the DB operation that just
// ran — the old code would forcibly terminate an active, un-revoked
// session. Every candidate is therefore now re-checked against the SAME
// canonical `assertActiveSession(sid, userId)` rule HTTP/the socket
// handshake already use (never a second, duplicated DB rule), and only a
// candidate this check confirms INACTIVE is actually disconnected — a
// candidate that comes back ACTIVE (a genuinely new/still-live session) is
// left alone, and a candidate whose check itself hits DB_ERROR is ALSO
// left alone rather than guessed at either way (§ below). Unique sids are
// deduplicated before querying (several sockets/tabs can share one sid —
// Y8D3 §19) so a multi-tab session costs one assertActiveSession call, not
// one per socket. Preserves current external semantics of
// revokeOtherSessions()/the password-change transaction exactly —
// lib/session.ts was not modified for this.
export async function disconnectOtherSessionSockets(userId: string, keepSid: string): Promise<void> {
  const io = ioInstance
  if (!io) return
  try {
    const sockets = await io.in(`user:${userId}`).fetchSockets()
    const candidates = sockets.filter(s => s.data.sessionId !== keepSid)

    const uniqueSids = [...new Set(
      candidates
        .map(s => s.data.sessionId as string | undefined)
        .filter((sid): sid is string => Boolean(sid)),
    )]

    const statusBySid = new Map<string, ActiveSessionCheck>()
    for (const sid of uniqueSids) {
      const status = await assertActiveSession(sid, userId)
      statusBySid.set(sid, status)
      if (status === 'DB_ERROR') {
        // Y8D3-FIX1 §8 — the authoritative bulk DB operation already
        // succeeded and is NEVER rolled back here. A DB error while
        // re-checking THIS specific candidate means its true status is
        // simply unknown right now — never guessed as INACTIVE (that risks
        // forcibly terminating a session that is actually still ACTIVE,
        // exactly the Defect B failure mode this fix removes) and never
        // treated as safely ACTIVE either (that would forcibly skip a
        // session that might genuinely be revoked) — the candidate is left
        // CONNECTED, not disconnected, because forcibly terminating a
        // session whose revocation status cannot currently be confirmed is
        // worse than leaving a possibly-still-revoked socket connected a
        // little longer: that socket's own NEXT handshake (its next
        // reconnect) is independently re-validated by this exact same
        // assertActiveSession check, so the security boundary is not
        // weakened — only this one best-effort realtime cleanup pass is
        // incomplete for this candidate. Other candidates are still
        // processed normally.
        logger.warn('[Socket] Bulk disconnect: could not confirm a candidate session\'s status (DB unavailable) — leaving it connected rather than guessing; its next handshake will still be independently re-validated', {
          userId,
          candidateSid: sid,
        })
      }
    }

    for (const s of candidates) {
      const sid = s.data.sessionId as string | undefined
      if (sid && statusBySid.get(sid) === 'INACTIVE') {
        s.disconnect(true)
      }
    }
  } catch (err) {
    logger.warn('[Socket] Best-effort bulk session disconnect failed after authoritative DB revoke-others — residual live sockets may survive until their own next disconnect/reconnect, but any NEW handshake for those sids will still be rejected by assertActiveSession', {
      userId,
      keepSid,
      err: err instanceof Error ? err.message : err,
    })
  }
}

export function setupSocket(httpServer: HTTPServer): IOServer {
  const io = new IOServer(httpServer, {
    cors: {
      origin:      env.FRONTEND_URL,
      methods:     ['GET', 'POST'],
      credentials: true,
    },
    transports: ['websocket', 'polling'],
  })

  // ─── Auth middleware ──────────────────────────────────────────────
  // Y8D3 (F4) — cryptographic verification alone no longer suffices, for
  // exactly the same reason Y8D2 extended HTTP's `authenticate`: a
  // signature-valid, unexpired access JWT can still name a session that
  // has since been revoked (logout, single/bulk session revoke, password
  // change) or expired at the DB level. Order is deliberate and mirrors
  // HTTP exactly: verify the JWT's signature/expiry FIRST (cheap, no DB
  // access) — a malformed/expired/missing token is rejected immediately,
  // with no session lookup ever attempted for it. Only a structurally
  // valid token proceeds to the SAME canonical active-session check
  // middlewares/authenticate.ts already uses (lib/session.ts::
  // assertActiveSession) — this rule is never re-implemented a second
  // time here; no duplicate DB-lookup logic exists in this file.
  io.use(async (socket, next) => {
    const token = socket.handshake.auth.token as string | undefined
    if (!token) {
      return next(new Error('Authentication token required'))
    }

    let payload
    try {
      payload = verifyAccessToken(token)
    } catch {
      return next(new Error('Invalid token'))
    }

    const status = await assertActiveSession(payload.sid, payload.sub)
    if (status === 'DB_ERROR') {
      // Y8D3 §4/§6 — an infrastructure failure during the active-session
      // check must NOT be reported as the same auth failure INACTIVE uses
      // below (Y8C-R1 §15, Y8C-R2 §9, Y8D2's own assertActiveSession
      // contract). The frontend's SocketContext only treats
      // 'Invalid token'/'Authentication token required' as an auth
      // failure warranting a refresh/logout attempt — this distinct
      // message+code deliberately does NOT match that check, so no false
      // credential-revoked logout is triggered merely because the DB is
      // unavailable. No access is granted either way. socket.io-client's
      // own default reconnection (already configured in SocketContext.tsx
      // with reconnection:true, reconnectionAttempts:Infinity, 1s→5s
      // backoff) automatically retries the handshake with the same
      // still-valid token once the DB recovers — no additional frontend
      // code is needed for that recovery loop (see this block's report,
      // §18, for why no SocketContext change was made).
      const dbErr = new Error('Session validation unavailable') as Error & { data?: unknown }
      dbErr.data = { code: 'SESSION_VALIDATION_UNAVAILABLE' }
      return next(dbErr)
    }
    if (status === 'INACTIVE') {
      // Y8D3 §5 — deliberately reuses the EXACT existing 'Invalid token'
      // message SocketContext.tsx's connect_error handler already
      // recognizes as an auth failure (isAuthFailure check), so a revoked/
      // expired session's socket handshake converges through the SAME
      // existing coordinatedRefresh() → handleSessionExpired() path a
      // rejected/expired access JWT already takes — no new frontend error
      // shape was introduced for this case. A revoked session's refresh
      // cookie is normally gone too (or about to be, per Y8D2b/Y8D2c), so
      // coordinatedRefresh() will itself fail and this converges to a
      // clean logged-out state, never an infinite reconnect loop with a
      // dead credential.
      return next(new Error('Invalid token'))
    }

    socket.data.userId    = payload.sub
    socket.data.role      = payload.role
    // Y8D3 §7 — the ONLY source for socket session identity is the access
    // JWT's own sid, read AFTER assertActiveSession has already confirmed
    // it names a live session for this exact user. Never derived from
    // userId, socket.id, the refresh JWT, or any request query/body value.
    socket.data.sessionId = payload.sid
    next()
  })

  // ─── Connection handler ───────────────────────────────────────────
  io.on('connection', socket => {
    const userId    = socket.data.userId as string
    const sessionId = socket.data.sessionId as string
    logger.debug(`[Socket] connected: ${socket.id} (user: ${userId}, session: ${sessionId})`)

    // Auto-join personal room (unchanged — user-level realtime fanout)
    void socket.join(`user:${userId}`)
    // Y8D3 §8 — session-level revocation ownership room, joined in
    // ADDITION to (never replacing) the user room above: the two rooms
    // serve different purposes (user:${userId} = "broadcast to this
    // user's every device/tab"; session:${sid} = "this exact persistent
    // session, which may itself span multiple same-browser tabs sharing
    // one refresh cookie — Y8D3 §19 — and is the unit that gets
    // individually revoked"). Every existing room join below (patient:*)
    // is preserved unchanged.
    void socket.join(`session:${sessionId}`)

    // Subscribe to a patient's room
    // Q6 — authorization fix: previously joined ANY patientId with no
    // ownership check, so any authenticated médico could listen to
    // health_record_created/prediction_completed for a patient belonging
    // to a different médico. Reuses the exact ownership pattern already
    // established in record.service.ts/patient.service.ts/prediction.service.ts
    // (medico lookup by userId, then patient lookup scoped to that
    // medico.id) — no new permission model introduced, just applying the
    // one already used everywhere else in the codebase to this handler too.
    socket.on('subscribe_patient', async (patientId: string) => {
      if (typeof patientId !== 'string') return
      const medico = await prisma.medico.findUnique({ where: { userId } })
      if (!medico) {
        logger.warn(`[Socket] ${userId} rejected — no medico profile for subscribe_patient`)
        return
      }
      const patient = await prisma.paciente.findFirst({
        where: { id: patientId, medicoId: medico.id },
      })
      if (!patient) {
        logger.warn(`[Socket] ${userId} rejected subscribe_patient:${patientId} — not owned by this medico`)
        return
      }
      void socket.join(`patient:${patientId}`)
      logger.debug(`[Socket] ${userId} subscribed to patient:${patientId}`)
    })

    // Unsubscribe from a patient's room
    socket.on('unsubscribe_patient', (patientId: string) => {
      if (typeof patientId !== 'string') return
      void socket.leave(`patient:${patientId}`)
    })

    // Ping/pong keepalive
    socket.on('ping', () => socket.emit('pong'))

    socket.on('disconnect', reason => {
      logger.debug(`[Socket] disconnected: ${socket.id} (${reason})`)
    })
  })

  // Y8D3 — record this process's one Socket.IO server so getIO()/
  // disconnectSessionSockets()/disconnectOtherSessionSockets() above can
  // reach it. Set once, right before returning — after this point every
  // consumer's `if (!io) return` guard is simply dead code for the life of
  // the process (until/unless a future test harness calls setupSocket()
  // without ever assigning its result anywhere, which this module-level
  // assignment does not depend on).
  ioInstance = io

  return io
}
