'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')
const indexSource = read('src/index.ts')
const appSource = read('src/app.ts')
const envSource = read('src/config/env.ts')
const limiterSource = read('src/middlewares/rateLimiter.ts')
const clientIpSource = read('src/middlewares/rateLimitClientIp.ts')
const socketSource = read('src/socket/socketServer.ts')
const packageJson = JSON.parse(read('package.json'))

function loadTypeScript() {
  try { return require('typescript') } catch {}
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const globalRoot = childProcess.execFileSync(npmCommand, ['root', '-g'], { encoding: 'utf8' }).trim()
  return require(path.join(globalRoot, 'typescript'))
}

function compileStandalone(rel, extraSandbox = {}) {
  const ts = loadTypeScript()
  const output = ts.transpileModule(read(rel), {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: rel,
  }).outputText
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, require, URL, Set, process, ...extraSandbox }
  vm.runInNewContext(`(function(require,module,exports){${output}\n})(require,module,exports)`, sandbox)
  return module.exports
}

function fakeReq({ authorization, cfIp, xff, ip = '10.0.0.7', remoteAddress = '10.0.0.7', user } = {}) {
  const headers = {}
  if (authorization) headers.authorization = authorization
  if (cfIp !== undefined) headers['cf-connecting-ip'] = cfIp
  if (xff !== undefined) headers['x-forwarded-for'] = xff
  return { headers, ip, socket: { remoteAddress }, user }
}

function withRenderFlag(value, fn) {
  const previous = process.env.RENDER
  if (value === undefined) delete process.env.RENDER
  else process.env.RENDER = value
  try { return fn() } finally {
    if (previous === undefined) delete process.env.RENDER
    else process.env.RENDER = previous
  }
}

function loadRateLimiterWithStubs(rateLimitClientIp) {
  const ts = loadTypeScript()
  const output = ts.transpileModule(limiterSource, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS, esModuleInterop: true },
    fileName: 'rateLimiter.ts',
  }).outputText
  const captured = []
  const rateLimitStub = options => { captured.push(options); return options }
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
      if (request === '@/middlewares/rateLimitClientIp') return { rateLimitClientIp }
      throw new Error(`Unexpected runtime require in rateLimiter deploy test: ${request}`)
    },
  }
  vm.runInNewContext(`(function(require,module,exports){${output}\n})(require,module,exports)`, sandbox)
  return { actual: module.exports, captured }
}

test('public listener uses env.PORT and explicitly binds 0.0.0.0', () => {
  assert.match(indexSource, /const port = parseInt\(env\.PORT, 10\)/)
  assert.match(indexSource, /httpServer\.listen\(port,\s*'0\.0\.0\.0'/)
  assert.doesNotMatch(indexSource, /httpServer\.listen\((?:3001|10000)/)
})

test('rate-limit identity does not depend on Express fixed-hop trust proxy', () => {
  assert.doesNotMatch(appSource, /app\.set\(['"]trust proxy['"]/)
  assert.match(clientIpSource, /process\.env\.RENDER === 'true'/)
  assert.match(clientIpSource, /cf-connecting-ip/)
  assert.doesNotMatch(clientIpSource, /req\.headers\[['"]x-forwarded-for['"]\]/i)
  assert.doesNotMatch(clientIpSource, /firstForwardedIp/)
})

test('Render canonical client-IP helper trusts CF identity only and never X-Forwarded-For', () => {
  const { rateLimitClientIp } = compileStandalone('src/middlewares/rateLimitClientIp.ts')

  withRenderFlag('true', () => {
    const sharedProxy = '10.20.30.40'
    const clientA = fakeReq({ cfIp: '198.51.100.10', xff: '203.0.113.250', ip: sharedProxy, remoteAddress: sharedProxy })
    const clientB = fakeReq({ cfIp: '198.51.100.11', xff: '203.0.113.250', ip: sharedProxy, remoteAddress: sharedProxy })

    assert.equal(rateLimitClientIp(clientA), '198.51.100.10') // R1
    assert.equal(rateLimitClientIp(clientB), '198.51.100.11') // R2
    assert.notEqual(rateLimitClientIp(clientA), rateLimitClientIp(clientB)) // R3
    assert.equal(clientA.socket.remoteAddress, clientB.socket.remoteAddress) // same Render proxy
    assert.equal(rateLimitClientIp(clientA), '198.51.100.10') // R4: spoofed XFF cannot override CF

    const noCf = fakeReq({ xff: '203.0.113.250', ip: sharedProxy, remoteAddress: sharedProxy })
    assert.equal(rateLimitClientIp(noCf), sharedProxy) // R5: transport fallback, never XFF
    assert.notEqual(rateLimitClientIp(noCf), '203.0.113.250')

    const invalidCf = fakeReq({ cfIp: 'garbage', xff: '203.0.113.250', ip: sharedProxy, remoteAddress: sharedProxy })
    assert.equal(rateLimitClientIp(invalidCf), sharedProxy) // R6: invalid CF also falls back to transport
    assert.notEqual(rateLimitClientIp(invalidCf), '203.0.113.250')
  })

  withRenderFlag(undefined, () => {
    const local = fakeReq({ cfIp: '198.51.100.99', xff: '203.0.113.250', ip: '127.0.0.1', remoteAddress: '127.0.0.1' })
    assert.equal(rateLimitClientIp(local), '127.0.0.1') // R7
  })
})

test('general and specialized rate limiters use canonical Render identity without changing capacities', () => {
  const { rateLimitClientIp } = compileStandalone('src/middlewares/rateLimitClientIp.ts')
  const { actual, captured } = loadRateLimiterWithStubs(rateLimitClientIp)

  withRenderFlag('true', () => {
    const base = { cfIp: '198.51.100.10', xff: '192.0.2.200, 10.20.30.40', ip: '10.20.30.40', remoteAddress: '10.20.30.40' }
    const other = { ...base, cfIp: '198.51.100.11' }

    // R8: authenticated general traffic remains keyed by cryptographically verified sub.
    assert.equal(actual.generalApiRateLimitKey(fakeReq({ ...base, authorization: 'Bearer signed-doctor-a' })), 'user:doctor-a')
    assert.equal(actual.generalApiRateLimitKey(fakeReq({ ...other, authorization: 'Bearer signed-doctor-a' })), 'user:doctor-a')

    // Missing/invalid JWT falls back to the canonical deployment-aware IP.
    assert.equal(actual.generalApiRateLimitKey(fakeReq({ ...base, authorization: 'Bearer invalid' })), 'ip:198.51.100.10')
    assert.equal(actual.generalApiRateLimitKey(fakeReq(base)), 'ip:198.51.100.10')

    assert.equal(captured[0].max, 2000)
    assert.equal(captured[0].windowMs, 15 * 60 * 1000)
    for (const options of captured.slice(1)) {
      assert.equal(options.max, 10)
      assert.equal(options.windowMs, 15 * 60 * 1000)
    }

    // R9: credential-sensitive auth/password limiters use the same canonical IP.
    assert.equal(captured[1].keyGenerator(fakeReq(base)), '198.51.100.10')
    assert.equal(captured[1].keyGenerator(fakeReq(other)), '198.51.100.11')
    assert.equal(captured[2].keyGenerator(fakeReq(base)), '198.51.100.10')
    assert.equal(captured[2].keyGenerator(fakeReq(other)), '198.51.100.11')

    const missingTrustedHeader = { xff: '203.0.113.250', ip: '10.20.30.40', remoteAddress: '10.20.30.40' }
    assert.equal(captured[1].keyGenerator(fakeReq(missingTrustedHeader)), '10.20.30.40')
    assert.equal(captured[2].keyGenerator(fakeReq(missingTrustedHeader)), '10.20.30.40')
    assert.equal(actual.generalApiRateLimitKey(fakeReq(missingTrustedHeader)), 'ip:10.20.30.40')

    // Avatar limiter preserves authenticated-user keying; its defensive fallback is canonical IP.
    assert.equal(captured[3].keyGenerator(fakeReq({ ...base, user: { sub: 'avatar-user' } })), 'avatar-user')
    assert.equal(captured[3].keyGenerator(fakeReq(base)), '198.51.100.10')
  })
})

test('production environment rejects malformed/non-HTTPS URLs and requires canonical frontend origin', () => {
  const { validateProductionDeploymentEnvironment } = compileStandalone('src/config/deploymentEnvironment.ts')

  assert.deepEqual(Array.from(validateProductionDeploymentEnvironment({ NODE_ENV: 'development' })), [])

  const missing = validateProductionDeploymentEnvironment({ NODE_ENV: 'production' })
  assert.deepEqual(Array.from(missing, issue => issue.field).sort(), ['AI_SERVICE_KEY', 'AI_SERVICE_URL', 'FRONTEND_URL'])

  const invalidCases = [
    { FRONTEND_URL: 'not-a-url', AI_SERVICE_URL: 'https://ai.example.invalid' },
    { FRONTEND_URL: 'https://app.example.invalid', AI_SERVICE_URL: 'broken' },
    { FRONTEND_URL: 'http://app.example.invalid', AI_SERVICE_URL: 'https://ai.example.invalid' },
    { FRONTEND_URL: 'https://app.example.invalid', AI_SERVICE_URL: 'http://ai.example.invalid' },
    { FRONTEND_URL: 'https://localhost:5173', AI_SERVICE_URL: 'https://ai.example.invalid' },
    { FRONTEND_URL: 'https://app.example.invalid', AI_SERVICE_URL: 'https://127.0.0.1:8000' },
    { FRONTEND_URL: 'https://app.example.invalid/', AI_SERVICE_URL: 'https://ai.example.invalid' },
    { FRONTEND_URL: 'https://app.example.invalid/path', AI_SERVICE_URL: 'https://ai.example.invalid' },
    { FRONTEND_URL: 'https://app.example.invalid?x=1', AI_SERVICE_URL: 'https://ai.example.invalid' },
  ]
  for (const values of invalidCases) {
    const issues = validateProductionDeploymentEnvironment({
      NODE_ENV: 'production',
      ...values,
      AI_SERVICE_KEY: 'strong-non-development-secret',
    })
    assert.ok(issues.length > 0, JSON.stringify(values))
  }

  for (const placeholder of ['internal-dev-key', 'internal-dev-key-change-in-prod']) {
    const issues = validateProductionDeploymentEnvironment({
      NODE_ENV: 'production',
      FRONTEND_URL: 'https://app.example.invalid',
      AI_SERVICE_URL: 'https://ai.example.invalid',
      AI_SERVICE_KEY: placeholder,
    })
    assert.ok(issues.some(issue => issue.field === 'AI_SERVICE_KEY'))
  }

  const configured = validateProductionDeploymentEnvironment({
    NODE_ENV: 'production',
    FRONTEND_URL: 'https://app.example.invalid',
    AI_SERVICE_URL: 'https://ai.example.invalid',
    AI_SERVICE_KEY: 'strong-non-development-secret',
  })
  assert.deepEqual(Array.from(configured), [])
})

test('canonical env bootstrap invokes production fail-closed validation without logging secret values', () => {
  assert.match(envSource, /validateProductionDeploymentEnvironment\(process\.env\)/)
  assert.match(envSource, /Invalid production deployment environment/)
  assert.doesNotMatch(envSource, /console\.(?:error|log)\([^\n]*AI_SERVICE_KEY[^\n]*process\.env/)
})

test('Northflank AI contract remains GET health, POST predict and X-Internal-Key', () => {
  const aiClient = read('src/lib/aiClient.ts')
  assert.match(aiClient, /baseURL:\s*env\.AI_SERVICE_URL/)
  assert.match(aiClient, /'X-Internal-Key': env\.AI_SERVICE_KEY/)
  assert.match(aiClient, /aiClient\.post<unknown>\('\/predict'/)
  assert.match(aiClient, /aiClient\.get\('\/health'\)/)
})

test('build/start path remains native Node and contains no migration/reset/seed', () => {
  assert.equal(packageJson.scripts.build, 'npm run prisma:generate && tsc && tsc-alias')
  assert.equal(packageJson.scripts.start, 'node dist/index.js')
  for (const script of [packageJson.scripts.build, packageJson.scripts.start, packageJson.scripts.postinstall]) {
    assert.doesNotMatch(script, /migrate|db push|demo:reset|seed/i)
  }
})

test('/health remains outside /api limiter and its semantics are unchanged', () => {
  const limiterMount = appSource.indexOf("app.use('/api', apiLimiter)")
  const health = appSource.indexOf("app.get('/health'")
  assert.notEqual(limiterMount, -1)
  assert.notEqual(health, -1)
  assert.ok(health > limiterMount)
  assert.match(appSource.slice(health, health + 260), /status:\s*'ok'/)
  assert.doesNotMatch(appSource, /app\.get\(['"]\/api\/health/)
})

test('Socket.IO remains attached to the same HTTP server and shares its public port', () => {
  assert.match(indexSource, /const httpServer = http\.createServer\(\)/)
  assert.match(indexSource, /const io = setupSocket\(httpServer\)/)
  assert.match(socketSource, /new IOServer\(httpServer,/)
  assert.doesNotMatch(socketSource, /\.listen\(/)
})

test('free-instance sleep is compatible with durable worker startup recovery', () => {
  const worker = read('src/modules/predictions/automatic/automaticPrediction.worker.ts')
  assert.match(indexSource, /automaticPredictionWorker\.start\(io\)/)
  assert.match(worker, /Startup recovery \+ periodic polling/)
  assert.match(worker, /this\.kick\(\)/)
  assert.match(worker, /status IN \('PENDING', 'RETRY_WAIT'\)/)
  assert.match(worker, /status = 'PROCESSING' AND lease_until </)
})

test('runtime source does not persist business state to local filesystem', () => {
  const sourceRoot = path.join(root, 'src')
  const stack = [sourceRoot]
  const offenders = []
  while (stack.length) {
    const dir = stack.pop()
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) stack.push(full)
      else if (/\.(?:ts|tsx)$/.test(entry.name)) {
        const src = fs.readFileSync(full, 'utf8')
        if (/\b(?:writeFile|writeFileSync|createWriteStream|diskStorage|appendFile|appendFileSync)\b/.test(src)) {
          offenders.push(path.relative(root, full))
        }
      }
    }
  }
  assert.deepEqual(offenders, [])
})

test('refresh cookie remains HttpOnly/Secure in production/SameSite=Lax pending end-to-end topology decision', () => {
  const cookies = read('src/lib/cookies.ts')
  assert.match(cookies, /httpOnly:\s*true/)
  assert.match(cookies, /secure:\s*isProd/)
  assert.match(cookies, /sameSite:\s*'lax'/)
  assert.doesNotMatch(cookies, /sameSite:\s*'none'/i)
})
