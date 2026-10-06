#!/usr/bin/env node
'use strict'

require('dotenv').config()
const { spawnSync } = require('child_process')

function fail(message) {
  console.error(`Commercial demo reset refused: ${message}`)
  process.exit(2)
}

const nodeEnv = String(process.env.NODE_ENV || 'development').toLowerCase()
if (nodeEnv === 'production') fail('NODE_ENV=production')
if (process.env.CARDIOSENSE_DEMO_RESET !== 'YES') {
  fail('set CARDIOSENSE_DEMO_RESET=YES to explicitly authorize destructive local/demo reset')
}

const raw = process.env.DATABASE_URL
if (!raw) fail('DATABASE_URL is missing')
let url
try { url = new URL(raw) } catch { fail('DATABASE_URL is invalid') }

const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
if (!allowedHosts.has(url.hostname)) fail(`database host is not local: ${url.hostname}`)
const database = url.pathname.replace(/^\//, '')
if (!/^cardiosense(?:[_-](?:dev|demo|development))?$/.test(database)) {
  fail(`database name is not an authorized CardioSense local/demo target: ${database}`)
}

console.log(`Authorized local/demo reset target: host=${url.hostname} port=${url.port || '5432'} database=${database} schema=${url.searchParams.get('schema') || 'public'}`)

const isWindows = process.platform === 'win32'
function run(command, args) {
  const options = { stdio: 'inherit', env: process.env }
  const result = isWindows
    ? spawnSync(
        process.env.ComSpec || 'cmd.exe',
        ['/d', '/s', '/c', [command, ...args].join(' ')],
        options,
      )
    : spawnSync(command, args, options)

  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}

// These command names and arguments are program-authored constants only.
run('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed'])
run('npx', ['prisma', 'generate'])
run('npm', ['run', 'prisma:seed'])

console.log('Commercial demo reset + canonical seed completed. Run prisma/validation/POST-T-DB1-INVARIANTS.sql next.')
