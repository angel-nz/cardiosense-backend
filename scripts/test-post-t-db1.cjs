'use strict'
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

function walk(dir) {
  const out = []
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

test('Prisma runtime schema uses English Doctor/Patient identifiers', () => {
  const schema = read('prisma/schema.prisma')
  for (const expected of [
    'model Doctor', 'model Patient', '@@map("doctors")', '@@map("patients")',
    '@map("doctor_id")', '@map("professional_license")', 'specialty', 'DOCTOR', 'PATIENT',
  ]) assert.match(schema, new RegExp(expected.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  for (const obsolete of ['model Medico', 'model Paciente', '@@map("medicos")', '@@map("pacientes")', '@map("medico_id")', '@map("cedula_profesional")']) {
    assert.equal(schema.includes(obsolete), false, obsolete)
  }
})

test('Forward migration renames data-preservingly and does not drop/recreate', () => {
  const sql = read('prisma/migrations/20261005233000_english_database_identifiers/migration.sql')
  for (const expected of [
    "RENAME VALUE 'MEDICO' TO 'DOCTOR'", "RENAME VALUE 'PACIENTE' TO 'PATIENT'",
    'ALTER TABLE "medicos" RENAME TO "doctors"', 'ALTER TABLE "pacientes" RENAME TO "patients"',
    'RENAME COLUMN "medico_id" TO "doctor_id"', 'RENAME COLUMN "cedula_profesional" TO "professional_license"',
    'RENAME COLUMN "especialidad" TO "specialty"', 'RENAME CONSTRAINT', 'ALTER INDEX',
  ]) assert.ok(sql.includes(expected), expected)
  assert.doesNotMatch(sql, /DROP\s+TABLE|CREATE\s+TABLE/i)
})

test('Active source has no obsolete physical DB/delegate references', () => {
  const roots = ['src', 'scripts', 'prisma/preflight']
  const historicalExceptions = new Set([
    path.normalize('prisma/preflight/z6-r1_duplicate_phone_check.sql'),
  ])
  const forbidden = [
    /\bmedico_id\b/, /\bcedula_profesional\b/,
    /prisma\.medico\b/, /prisma\.paciente\b/, /tx\.medico\b/, /tx\.paciente\b/, /\bfindByIdForMedico\b/,
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["`]?medicos\b/i,
    /\b(?:FROM|JOIN|INTO|UPDATE|TABLE)\s+["`]?pacientes\b/i,
  ]
  for (const rel of roots) {
    for (const file of walk(path.join(root, rel))) {
      if (!/\.(?:ts|js|cjs|sql)$/.test(file) || file === __filename) continue
      const relative = path.normalize(path.relative(root, file))
      if (historicalExceptions.has(relative)) continue
      const src = fs.readFileSync(file, 'utf8')
      const runtimeSource = src
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '')
        .replace(/^\s*--.*$/gm, '')
      for (const re of forbidden) assert.doesNotMatch(runtimeSource, re, `${relative} ${re}`)
    }
  }

  const historicalPreflight = read('prisma/preflight/z6-r1_duplicate_phone_check.sql')
  assert.match(historicalPreflight, /FROM medicos/)
  assert.doesNotMatch(historicalPreflight, /FROM doctors/)
})

test('Public Spanish wire compatibility is explicit at one boundary helper', () => {
  const src = read('src/lib/publicIdentity.ts')
  assert.match(src, /DOCTOR.*MEDICO/s)
  assert.match(src, /PATIENT.*PACIENTE/s)
  assert.match(src, /cedulaProfesional/)
  assert.match(src, /especialidad/)
})

test('Commercial seed uses canonical workflows and never inserts derived clinical rows directly', () => {
  const src = read('prisma/seed.ts')
  for (const required of ['PatientService', 'HealthRecordService', 'AutomaticPredictionWorker', 'getModelCapabilities', 'waitForForecastTriggersIdle', 'Skorp-Beta-0.2']) assert.ok(src.includes(required), required)
  for (const forbidden of ['prisma.prediction.create(', 'prisma.riskForecast.create(', 'prisma.riskForecastSet.create(', 'prisma.rForecastBridgeState.create(']) assert.equal(src.includes(forbidden), false, forbidden)
})

test('Commercial seed plans 54 patients and 206 HealthRecords with lifecycle variety', () => {
  const visits = i => i < 4 ? 0 : i < 12 ? 1 : i < 20 ? 2 : i < 28 ? 3 : i < 40 ? 5 : 7
  assert.equal(Array.from({length:54}, (_,i)=>visits(i)).reduce((a,b)=>a+b,0), 206)
  assert.match(read('prisma/seed.ts'), /Array\.from\(\{ length: 54 \}/)
})

test('Commercial seed records each created patient exactly once for lifecycle processing', () => {
  const src = read('prisma/seed.ts')
  const exact = 'created.push({ patientId: patient.id, plan })'
  assert.equal(src.split(exact).length - 1, 1)
})

test('Commercial ownership/lifecycle plan is deterministic and distributed across all doctors', () => {
  const src = read('prisma/seed.ts')
  const extractSet = name => {
    const match = src.match(new RegExp(`const ${name} = new Set\\(\\[([^\\]]+)\\]\\)`))
    assert.ok(match, `${name} must be declared in seed.ts`)
    return new Set(match[1].split(',').map(v => Number(v.trim())))
  }
  const d2 = extractSet('DOCTOR_2_PATIENT_INDICES')
  const d3 = extractSet('DOCTOR_3_PATIENT_INDICES')
  assert.deepEqual([...d2].sort((a,b)=>a-b), [1, 7, 13, 25, 43, 49])
  assert.deepEqual([...d3].sort((a,b)=>a-b), [2, 8, 14, 26, 44, 50])
  assert.equal([...d2].some(index => d3.has(index)), false)
  assert.match(src, /doctors\[doctorSlotForPatient\(index\)\]/)
  assert.match(src, /if \(index < 40\) return 'ACTIVE'/)
  assert.match(src, /if \(index < 48\) return 'INACTIVE_VISIBLE'/)

  const matrix = [
    { active: 0, inactiveVisible: 0, hidden: 0, total: 0 },
    { active: 0, inactiveVisible: 0, hidden: 0, total: 0 },
    { active: 0, inactiveVisible: 0, hidden: 0, total: 0 },
  ]
  for (let index = 0; index < 54; index++) {
    const slot = d2.has(index) ? 1 : d3.has(index) ? 2 : 0
    const lifecycle = index < 40 ? 'active' : index < 48 ? 'inactiveVisible' : 'hidden'
    matrix[slot][lifecycle]++
    matrix[slot].total++
  }
  assert.deepEqual(matrix, [
    { active: 32, inactiveVisible: 6, hidden: 4, total: 42 },
    { active: 4, inactiveVisible: 1, hidden: 1, total: 6 },
    { active: 4, inactiveVisible: 1, hidden: 1, total: 6 },
  ])
  assert.deepEqual(
    matrix.reduce((acc, row) => ({
      active: acc.active + row.active,
      inactiveVisible: acc.inactiveVisible + row.inactiveVisible,
      hidden: acc.hidden + row.hidden,
      total: acc.total + row.total,
    }), { active: 0, inactiveVisible: 0, hidden: 0, total: 0 }),
    { active: 40, inactiveVisible: 8, hidden: 6, total: 54 },
  )

  for (const expected of [
    "patients !== 54",
    "globalLifecycle.active !== 40",
    "globalLifecycle.inactiveVisible !== 8",
    "globalLifecycle.hidden !== 6",
    "active: 32, inactiveVisible: 6, hidden: 4, total: 42",
    "active: 4, inactiveVisible: 1, hidden: 1, total: 6",
  ]) assert.ok(src.includes(expected), expected)
})

test('Commercial reset refuses implicit/remote/production destructive targets', () => {
  const src = read('scripts/commercial-demo-reset.cjs')
  for (const required of ['NODE_ENV=production', 'CARDIOSENSE_DEMO_RESET', 'localhost', '127.0.0.1', "'migrate', 'reset'", '--skip-seed']) assert.ok(src.includes(required), required)
  assert.doesNotMatch(src, /db push/i)
})

test('Invariant pack checks schema Englishness, clinical integrity and clean versions read-only', () => {
  const sql = read('prisma/validation/POST-T-DB1-INVARIANTS.sql')
  for (let i=1;i<=22;i++) assert.ok(sql.includes(`I${String(i).padStart(2,'0')}`), `I${i}`)
  const executable = sql.split('\n').filter(line => !line.trimStart().startsWith('--')).join('\n')
  assert.doesNotMatch(executable, /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|ALTER|DROP|CREATE)\b/i)
})


test('Commercial reset launcher is Windows Node 24 compatible without weakening safety', () => {
  const src = read('scripts/commercial-demo-reset.cjs')

  assert.doesNotMatch(src, /npx\.cmd|npm\.cmd/)
  assert.match(src, /process\.env\.ComSpec\s*\|\|\s*['"]cmd\.exe['"]/)
  assert.match(src, /['"]\/c['"]/)
  assert.doesNotMatch(src, /shell\s*:\s*true/)

  for (const canonical of [
    "run('npx', ['prisma', 'migrate', 'reset', '--force', '--skip-seed'])",
    "run('npx', ['prisma', 'generate'])",
    "run('npm', ['run', 'prisma:seed'])",
  ]) assert.ok(src.includes(canonical), canonical)

  for (const safety of [
    'NODE_ENV=production',
    'CARDIOSENSE_DEMO_RESET',
    "new Set(['localhost', '127.0.0.1', '::1', '[::1]'])",
    '/^cardiosense(?:[_-](?:dev|demo|development))?$/',
  ]) assert.ok(src.includes(safety), safety)

  assert.match(src, /isWindows[\s\S]*?spawnSync\([\s\S]*?process\.env\.ComSpec[\s\S]*?\['\/d', '\/s', '\/c'/)
  assert.match(src, /:\s*spawnSync\(command, args, options\)/)

  const windowsCommand = "['/d', '/s', '/c', [command, ...args].join(' ')]"
  assert.ok(src.includes(windowsCommand), windowsCommand)
  for (const forbiddenDynamic of ['DATABASE_URL', 'database}', 'url.hostname', 'url.searchParams', 'process.argv']) {
    const commandBlock = src.slice(src.indexOf("const isWindows"), src.indexOf("console.log('Commercial demo reset"))
    assert.equal(commandBlock.includes(forbiddenDynamic), false, `Windows command block must not include ${forbiddenDynamic}`)
  }
})

test('Forward migration chain renames all 13 residual Spanish NOT NULL constraints', () => {
  const sql = read('prisma/migrations/20261006024500_english_not_null_constraint_names/migration.sql')
  const renames = [
    ['doctors', 'medicos_created_at_not_null', 'doctors_created_at_not_null'],
    ['doctors', 'medicos_id_not_null', 'doctors_id_not_null'],
    ['doctors', 'medicos_user_id_not_null', 'doctors_user_id_not_null'],
    ['patients', 'pacientes_birth_date_not_null', 'patients_birth_date_not_null'],
    ['patients', 'pacientes_created_at_not_null', 'patients_created_at_not_null'],
    ['patients', 'pacientes_first_name_not_null', 'patients_first_name_not_null'],
    ['patients', 'pacientes_id_not_null', 'patients_id_not_null'],
    ['patients', 'pacientes_is_active_not_null', 'patients_is_active_not_null'],
    ['patients', 'pacientes_is_hidden_not_null', 'patients_is_hidden_not_null'],
    ['patients', 'pacientes_last_name_not_null', 'patients_last_name_not_null'],
    ['patients', 'pacientes_medico_id_not_null', 'patients_doctor_id_not_null'],
    ['patients', 'pacientes_sex_not_null', 'patients_sex_not_null'],
    ['patients', 'pacientes_updated_at_not_null', 'patients_updated_at_not_null'],
  ]
  for (const [table, oldName, newName] of renames) {
    const statement = `ALTER TABLE "${table}" RENAME CONSTRAINT "${oldName}" TO "${newName}";`
    assert.ok(sql.includes(statement), statement)
  }
  assert.equal((sql.match(/RENAME CONSTRAINT/g) || []).length, 13)
  assert.doesNotMatch(sql, /\b(?:DROP|CREATE|UPDATE|INSERT|DELETE|TRUNCATE)\b/i)

  const original = read('prisma/migrations/20261005233000_english_database_identifiers/migration.sql')
  assert.doesNotMatch(original, /medicos_created_at_not_null|pacientes_birth_date_not_null/)
})

test('I05 matches canonical COMPLETED task semantics and permits retained next_attempt_at', () => {
  const sql = read('prisma/validation/POST-T-DB1-INVARIANTS.sql')
  const match = sql.match(/-- I05 malformed COMPLETED task([\s\S]*?)-- I06 malformed terminal MODEL_INELIGIBLE task/)
  assert.ok(match, 'I05 block must be present before I06')
  const i05 = match[1]

  for (const required of [
    'prediction_id IS NULL',
    'completed_at IS NULL',
    'lease_until IS NOT NULL',
    'lease_owner IS NOT NULL',
    'last_error_code IS NOT NULL',
  ]) assert.ok(i05.includes(required), required)

  assert.equal(i05.includes('next_attempt_at IS NOT NULL'), false, 'COMPLETED tasks may retain next_attempt_at')
  assert.equal(i05.includes('next_attempt_at IS NULL'), false, 'I05 must not constrain next_attempt_at')

  const worker = read('src/modules/predictions/automatic/automaticPrediction.worker.ts')
  const completeMatch = worker.match(/private async complete\([\s\S]*?private async retry\(/)
  assert.ok(completeMatch, 'worker complete() transition must be inspectable')
  const complete = completeMatch[0]
  assert.ok(complete.includes("SET status = 'COMPLETED'"))
  assert.ok(complete.includes('completed_at ='))
  assert.ok(complete.includes('lease_until = NULL'))
  assert.ok(complete.includes('lease_owner = NULL'))
  assert.ok(complete.includes('last_error_code = NULL'))
  assert.equal(complete.includes('next_attempt_at = NULL'), false)
})
