'use strict'

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const childProcess = require('node:child_process')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

function loadTypeScript() {
  try { return require('typescript') } catch {}
  const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  const globalRoot = childProcess.execFileSync(npmCommand, ['root', '-g'], { encoding: 'utf8' }).trim()
  return require(path.join(globalRoot, 'typescript'))
}

function compileStandalone(rel) {
  const ts = loadTypeScript()
  const source = read(rel)
  const output = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS },
    fileName: rel,
  }).outputText
  const module = { exports: {} }
  const sandbox = { module, exports: module.exports, require, setTimeout, clearTimeout, Promise, Error }
  vm.runInNewContext(`(function(require,module,exports){${output}\n})(require,module,exports)`, sandbox)
  return module.exports
}

const indexSource = read('src/index.ts')
const socketSource = read('src/socket/socketServer.ts')

// T1 + T6: actual helper runtime semantics, no process termination.
test('shutdown is idempotent across concurrent requests and cleans each resource exactly once', async () => {
  const { createGracefulShutdown } = compileStandalone('src/runtime/gracefulShutdown.ts')
  const calls = { transport: 0, worker: 0, prisma: 0, exit: [] }
  const logger = { info() {}, error() {} }
  const controller = createGracefulShutdown({
    closeTransport: async () => { calls.transport++ },
    stopBackgroundWork: async () => { calls.worker++ },
    disconnectPrisma: async () => { calls.prisma++ },
    exit: code => calls.exit.push(code),
    logger,
    timeoutMs: 1000,
  })

  const a = controller.shutdown({ reason: 'SIGINT', exitCode: 0 })
  const b = controller.shutdown({ reason: 'SIGTERM', exitCode: 0 })
  const c = controller.shutdown({ reason: 'UNCAUGHT_EXCEPTION', exitCode: 1, error: new Error('boom') })
  await Promise.all([a, b, c])

  assert.deepEqual(calls, { transport: 1, worker: 1, prisma: 1, exit: [1] })
  assert.equal(controller.isShuttingDown(), true)
})

// T2/T3: source wiring proves process-level fatal events reach the same path.
test('uncaughtException and unhandledRejection both request controlled non-zero shutdown', () => {
  assert.match(indexSource, /process\.on\('uncaughtException',[\s\S]*?requestProcessShutdown\('UNCAUGHT_EXCEPTION',\s*1/)
  assert.match(indexSource, /process\.on\('unhandledRejection',[\s\S]*?requestProcessShutdown\('UNHANDLED_REJECTION',\s*1/)
  assert.doesNotMatch(indexSource, /process\.on\('uncaughtException',[\s\S]{0,250}?\}\)\s*\n\s*process\.on\('unhandledRejection'/)
})

test('SIGINT and SIGTERM converge on the same zero-exit shutdown controller', () => {
  assert.match(indexSource, /process\.on\('SIGTERM',[\s\S]*?requestProcessShutdown\('SIGTERM',\s*0/)
  assert.match(indexSource, /process\.on\('SIGINT',[\s\S]*?requestProcessShutdown\('SIGINT',\s*0/)
  assert.match(indexSource, /createGracefulShutdown\(/)
  assert.doesNotMatch(indexSource, /setTimeout\(\(\) => process\.exit/)
})

test('production shutdown has one transport owner: Socket.IO closes the attached HTTP server', () => {
  const shutdownSource = read('src/runtime/gracefulShutdown.ts')
  assert.match(indexSource, /const closeTransport = \(\) => new Promise<void>/)
  assert.match(indexSource, /io\.close\(\(\) => resolve\(\)\)/)
  assert.doesNotMatch(indexSource, /^\s*httpServer\.close\(/m)
  assert.doesNotMatch(indexSource, /closeHttp/)
  assert.doesNotMatch(indexSource, /closeSocket/)
  assert.match(shutdownSource, /closeTransport\(\): Promise<void>/)
  assert.match(shutdownSource, /runStep\('transport', deps\.closeTransport\)/)
  assert.doesNotMatch(shutdownSource, /closeHttp|closeSocket/)
})

// T4/T5: execute the real handler factory with fake DB/socket dependencies.
test('subscribe_patient catches a DB rejection locally and never joins a room', async () => {
  const { createSubscribePatientHandler } = compileStandalone('src/socket/subscribePatient.handler.ts')
  const joined = []
  const warnings = []
  const handler = createSubscribePatientHandler({
    socket: { id: 's1', join: room => joined.push(room) },
    userId: 'doctor-user',
    dataSource: {
      doctor: { findUnique: async () => { throw new Error('db down') } },
      patient: { findFirst: async () => ({ id: 'p1' }) },
    },
    logger: { debug() {}, warn: (message, meta) => warnings.push({ message, meta }) },
  })

  await assert.doesNotReject(() => handler('patient-1'))
  assert.deepEqual(joined, [])
  assert.equal(warnings.length, 1)
  assert.match(warnings[0].message, /failed safely/)
  assert.equal(warnings[0].meta.event, 'subscribe_patient')
  assert.equal(warnings[0].meta.patientId, 'patient-1')
})

test('subscribe_patient preserves successful doctor ownership authorization and joins only the owned room', async () => {
  const { createSubscribePatientHandler } = compileStandalone('src/socket/subscribePatient.handler.ts')
  const joined = []
  const handler = createSubscribePatientHandler({
    socket: { id: 's2', join: async room => { joined.push(room) } },
    userId: 'doctor-user',
    dataSource: {
      doctor: { findUnique: async ({ where }) => { assert.equal(where.userId, 'doctor-user'); return { id: 'doctor-1' } } },
      patient: { findFirst: async ({ where }) => { assert.equal(where.id, 'patient-1'); assert.equal(where.doctorId, 'doctor-1'); return { id: 'patient-1' } } },
    },
    logger: { debug() {}, warn() {} },
  })

  await handler('patient-1')
  assert.deepEqual(joined, ['patient:patient-1'])
})

test('subscribe_patient preserves deny-by-default ownership semantics', async () => {
  const { createSubscribePatientHandler } = compileStandalone('src/socket/subscribePatient.handler.ts')
  const joined = []
  const handler = createSubscribePatientHandler({
    socket: { id: 's3', join: room => joined.push(room) },
    userId: 'doctor-user',
    dataSource: {
      doctor: { findUnique: async () => ({ id: 'doctor-1' }) },
      patient: { findFirst: async () => null },
    },
    logger: { debug() {}, warn() {} },
  })
  await handler('patient-other')
  assert.deepEqual(joined, [])
})

test('all Socket.IO room mutations that may return promises have local rejection boundaries', () => {
  assert.match(socketSource, /Promise\.resolve\(socket\.join\(`user:/)
  assert.match(socketSource, /Promise\.resolve\(socket\.join\(`session:/)
  assert.match(socketSource, /createSubscribePatientHandler\(/)
  assert.match(socketSource, /Promise\.resolve\(socket\.leave\(`patient:/)
})

test('graceful shutdown has a bounded 10-second timeout and single exit guard', () => {
  const source = read('src/runtime/gracefulShutdown.ts')
  assert.match(source, /timeoutMs\s*\?\?\s*10_000/)
  assert.match(source, /timeout\.unref\?\.\(\)/)
  assert.match(source, /if \(exitRequested\) return/)
  assert.match(source, /requestedExitCode = Math\.max\(requestedExitCode, request\.exitCode\)/)
})

test('INTEGRITY-1A limiter policy remains unchanged by INTEGRITY-1B', () => {
  const limiter = read('src/middlewares/rateLimiter.ts')
  assert.match(limiter, /GENERAL_API_MAX\s*=\s*2000/)
  assert.match(limiter, /return `user:\$\{payload\.sub\}`/)
  assert.match(limiter, /return `ip:\$\{req\.ip \?\?/)
})
