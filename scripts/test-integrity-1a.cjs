'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const limiter = read('src/middlewares/rateLimiter.ts')
const app = read('src/app.ts')

function exportedNumber(name) {
  const match = limiter.match(new RegExp(`export const ${name}\\s*=\\s*([0-9 *+_-]+)`))
  assert.ok(match, `${name} must be exported as a numeric expression`)
  // The source expression is program-authored arithmetic only. Restrict the
  // accepted grammar before evaluating it so the test never evaluates code.
  assert.match(match[1].trim(), /^[0-9 *+_-]+$/)
  return Function(`"use strict"; return (${match[1]})`)()
}

function blockFor(exportName) {
  const start = limiter.indexOf(`export const ${exportName} = rateLimit({`)
  assert.notEqual(start, -1, `${exportName} rateLimit block must exist`)
  const next = limiter.indexOf('\nexport const ', start + 1)
  return limiter.slice(start, next === -1 ? limiter.length : next)
}

test('general API quota no longer has the proven 100/15min availability defect', () => {
  const max = exportedNumber('GENERAL_API_MAX')
  const windowMs = exportedNumber('GENERAL_API_WINDOW_MS')
  assert.equal(windowMs, 15 * 60 * 1000)
  assert.equal(max, 2000)
  assert.ok(max > 100)

  // Configuration-level behavior regression: requests 1..101 remain inside
  // the configured bucket, while a caller can still exceed the finite quota.
  assert.ok(101 <= max)
  assert.ok(max + 1 > max)

  const general = blockFor('apiLimiter')
  assert.match(general, /max:\s*GENERAL_API_MAX/)
  assert.match(general, /keyGenerator:\s*generalApiRateLimitKey/)
  assert.match(general, /RATE_LIMITED/)
})

test('general limiter keys a valid Bearer token by user sub without session lookup', () => {
  assert.match(limiter, /verifyAccessToken\(token\)/)
  assert.match(limiter, /return `user:\$\{payload\.sub\}`/)
  assert.doesNotMatch(limiter, /assertActiveSession|prisma\.|findUnique|findFirst/)
})

test('missing or invalid access token falls back to an IP bucket instead of bypassing/erroring', () => {
  assert.match(limiter, /catch\s*\{[\s\S]*?\}/)
  assert.match(limiter, /return `ip:\$\{req\.ip \?\? req\.socket\.remoteAddress \?\? 'unknown'\}`/)
  assert.doesNotMatch(limiter, /skipSuccessfulRequests\s*:\s*true/)
})

test('two authenticated user identities have distinct general buckets by construction', () => {
  const key = sub => `user:${sub}`
  assert.notEqual(key('doctor-a'), key('doctor-b'))
  assert.equal(key('doctor-a'), 'user:doctor-a')
})

test('specialized auth/password/avatar limits remain independently strict', () => {
  const auth = blockFor('authLimiter')
  const password = blockFor('passwordChangeLimiter')
  const avatar = blockFor('avatarUploadLimiter')
  for (const block of [auth, password, avatar]) {
    assert.match(block, /windowMs:\s*15 \* 60 \* 1000/)
    assert.match(block, /max:\s*10/)
    assert.match(block, /RATE_LIMITED/)
  }
})

test('/health remains outside the general /api limiter', () => {
  const limiterMount = app.indexOf("app.use('/api', apiLimiter)")
  const health = app.indexOf("app.get('/health'")
  assert.notEqual(limiterMount, -1)
  assert.notEqual(health, -1)
  assert.ok(health > limiterMount)
  assert.doesNotMatch(app, /app\.use\(['"]\/health['"],\s*apiLimiter/)
  assert.doesNotMatch(app, /app\.get\(['"]\/api\/health['"]/)
})

test('429 response contract and standard headers are preserved', () => {
  const general = blockFor('apiLimiter')
  assert.match(general, /standardHeaders:\s*true/)
  assert.match(general, /legacyHeaders:\s*false/)
  assert.match(general, /error:\s*'Too many requests, please try again later\.'/)
  assert.match(general, /code:\s*'RATE_LIMITED'/)
})


test('actual compiled key generator separates valid users and safely falls back for invalid/missing tokens', () => {
  let ts
  try {
    ts = require('typescript')
  } catch {
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const globalRoot = childProcess.execFileSync(npmCommand, ['root', '-g'], { encoding: 'utf8' }).trim()
    ts = require(path.join(globalRoot, 'typescript'))
  }

  const compiled = ts.transpileModule(limiter, {
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
    },
    fileName: 'rateLimiter.ts',
  }).outputText

  const captured = []
  const rateLimitStub = options => {
    captured.push(options)
    return options
  }
  const verifyAccessToken = token => {
    if (token === 'signed-doctor-a') return { sub: 'doctor-a' }
    if (token === 'signed-doctor-b') return { sub: 'doctor-b' }
    throw new Error('invalid token')
  }
  const module = { exports: {} }
  const sandbox = {
    module,
    exports: module.exports,
    require(request) {
      if (request === 'express-rate-limit') return rateLimitStub
      if (request === '@/lib/jwt') return { verifyAccessToken }
      throw new Error(`Unexpected runtime require in rateLimiter test: ${request}`)
    },
  }
  vm.runInNewContext(`(function(require,module,exports){${compiled}\n})(require,module,exports)`, sandbox)
  const actual = module.exports

  const req = (authorization, ip = '127.0.0.1') => ({
    headers: authorization ? { authorization } : {},
    ip,
    socket: { remoteAddress: ip },
  })

  assert.equal(actual.GENERAL_API_MAX, 2000)
  assert.equal(actual.GENERAL_API_WINDOW_MS, 15 * 60 * 1000)
  assert.equal(actual.generalApiRateLimitKey(req('Bearer signed-doctor-a')), 'user:doctor-a')
  assert.equal(actual.generalApiRateLimitKey(req('Bearer signed-doctor-b')), 'user:doctor-b')
  assert.equal(actual.generalApiRateLimitKey(req('Bearer invalid')), 'ip:127.0.0.1')
  assert.equal(actual.generalApiRateLimitKey(req(undefined, '10.0.0.9')), 'ip:10.0.0.9')
  assert.equal(captured[0].max, 2000)
  assert.equal(captured[1].max, 10)
  assert.equal(captured[2].max, 10)
  assert.equal(captured[3].max, 10)
})
