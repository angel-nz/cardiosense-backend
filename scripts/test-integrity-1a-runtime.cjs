'use strict'

// Runtime regression for INTEGRITY-1A. Run AFTER `npm run build` so this uses
// the compiled production limiter and real express-rate-limit package. It does
// not connect to PostgreSQL and never imports the application router.

const assert = require('node:assert/strict')
const path = require('node:path')

process.env.NODE_ENV = 'test'
process.env.DATABASE_URL ||= 'postgresql://integrity-test:integrity-test@localhost:5432/integrity_test'
process.env.JWT_SECRET ||= 'integrity-1a-access-secret-32-bytes-minimum'
process.env.JWT_REFRESH_SECRET ||= 'integrity-1a-refresh-secret-32-bytes-minimum'
process.env.JWT_EXPIRES_IN ||= '1h'
process.env.JWT_REFRESH_EXPIRES_IN ||= '7d'
process.env.FRONTEND_URL ||= 'http://localhost:5173'
process.env.AI_SERVICE_URL ||= 'http://localhost:8000'
process.env.AI_SERVICE_KEY ||= 'integrity-test-key'
process.env.BCRYPT_ROUNDS ||= '12'

const express = require('express')
const {
  apiLimiter,
  authLimiter,
  passwordChangeLimiter,
  avatarUploadLimiter,
  GENERAL_API_MAX,
  GENERAL_API_WINDOW_MS,
  generalApiRateLimitKey,
} = require(path.join(__dirname, '..', 'dist', 'middlewares', 'rateLimiter.js'))
const { signAccessToken } = require(path.join(__dirname, '..', 'dist', 'lib', 'jwt.js'))

function token(sub) {
  return signAccessToken({
    sub,
    sid: `sid-${sub}`,
    email: `${sub}@example.invalid`,
    role: 'DOCTOR',
  })
}

function fakeReq(authorization, ip = '127.0.0.1') {
  return {
    headers: authorization ? { authorization } : {},
    ip,
    socket: { remoteAddress: ip },
  }
}

async function request(base, route, options = {}) {
  return fetch(`${base}${route}`, options)
}

async function main() {
  assert.equal(GENERAL_API_WINDOW_MS, 15 * 60 * 1000)
  assert.equal(GENERAL_API_MAX, 2000)

  const tokenA = token('doctor-a')
  const tokenB = token('doctor-b')
  assert.equal(generalApiRateLimitKey(fakeReq(`Bearer ${tokenA}`)), 'user:doctor-a')
  assert.equal(generalApiRateLimitKey(fakeReq(`Bearer ${tokenB}`)), 'user:doctor-b')
  assert.equal(generalApiRateLimitKey(fakeReq('Bearer definitely-invalid')), 'ip:127.0.0.1')
  assert.equal(generalApiRateLimitKey(fakeReq(undefined)), 'ip:127.0.0.1')

  const app = express()
  app.get('/health', (_req, res) => res.status(200).json({ status: 'ok' }))
  app.use('/api', apiLimiter)
  app.get('/api/ping', (_req, res) => res.status(200).json({ ok: true }))
  app.post('/auth-test', authLimiter, (_req, res) => res.sendStatus(204))
  app.post('/password-test', passwordChangeLimiter, (_req, res) => res.sendStatus(204))
  app.post('/avatar-test', (req, _res, next) => {
    req.user = { sub: 'avatar-user' }
    next()
  }, avatarUploadLimiter, (_req, res) => res.sendStatus(204))

  const server = await new Promise(resolve => {
    const instance = app.listen(0, '127.0.0.1', () => resolve(instance))
  })
  const address = server.address()
  const base = `http://127.0.0.1:${address.port}`

  try {
    // Old failure threshold: 101 ordinary authenticated requests must all pass.
    for (let i = 0; i < 101; i++) {
      const response = await request(base, '/api/ping', {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
      assert.equal(response.status, 200, `request ${i + 1} should not be rate-limited`)
    }

    // User A can consume the remainder of its finite bucket, then receives 429.
    for (let i = 101; i < GENERAL_API_MAX; i++) {
      const response = await request(base, '/api/ping', {
        headers: { Authorization: `Bearer ${tokenA}` },
      })
      assert.equal(response.status, 200)
    }
    const limited = await request(base, '/api/ping', {
      headers: { Authorization: `Bearer ${tokenA}` },
    })
    assert.equal(limited.status, 429)
    assert.equal((await limited.json()).code, 'RATE_LIMITED')

    // Different authenticated identity has an independent bucket.
    const userB = await request(base, '/api/ping', {
      headers: { Authorization: `Bearer ${tokenB}` },
    })
    assert.equal(userB.status, 200)

    // /health remains outside /api limiter even while user A is exhausted.
    assert.equal((await request(base, '/health')).status, 200)

    // Specialized security-sensitive limiters remain strict at 10 / 15 min.
    for (const route of ['/auth-test', '/password-test', '/avatar-test']) {
      for (let i = 0; i < 10; i++) assert.equal((await request(base, route, { method: 'POST' })).status, 204)
      assert.equal((await request(base, route, { method: 'POST' })).status, 429)
    }
  } finally {
    await new Promise((resolve, reject) => server.close(err => err ? reject(err) : resolve()))
  }

  console.log('INTEGRITY-1A runtime limiter regression: PASS')
}

main().catch(err => {
  console.error(err)
  process.exitCode = 1
})
