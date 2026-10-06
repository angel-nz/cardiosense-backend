import { PrismaClient, Role } from '@prisma/client'
import bcrypt from 'bcryptjs'
import { getModelCapabilities } from '../src/lib/aiClient'
import { PatientService } from '../src/modules/patients/patient.service'
import { HealthRecordService } from '../src/modules/health-records/record.service'
import { AutomaticPredictionWorker } from '../src/modules/predictions/automatic/automaticPrediction.worker'
import { waitForForecastTriggersIdle } from '../src/modules/risk-forecasts/forecast.triggers'

const prisma = new PrismaClient()
const patientService = new PatientService()
const recordService = new HealthRecordService()
const worker = new AutomaticPredictionWorker('commercial-demo-seed')

const DEMO_MODEL_VERSION = 'Skorp-Beta-0.2'
const RNG_SEED = 0x43a2d10f

function makeRng(seed = RNG_SEED) {
  let state = seed >>> 0
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    return (state >>> 0) / 0x100000000
  }
}
const rng = makeRng()
const pick = <T>(values: readonly T[]): T => values[Math.floor(rng() * values.length)]!
const round1 = (n: number) => Math.round(n * 10) / 10
const clamp = (n: number, min: number, max: number) => Math.max(min, Math.min(max, n))

const FIRST_NAMES = [
  'Alejandra', 'Andrés', 'Beatriz', 'Carlos', 'Cecilia', 'Daniel', 'Diana', 'Eduardo', 'Elena',
  'Emilio', 'Fernanda', 'Gabriel', 'Gabriela', 'Héctor', 'Irene', 'Javier', 'Jimena', 'Jorge',
  'Laura', 'Luis', 'Marcela', 'Marco', 'Mariana', 'Mónica', 'Natalia', 'Óscar', 'Patricia',
  'Raúl', 'Renata', 'Ricardo', 'Rocío', 'Sergio', 'Silvia', 'Teresa', 'Tomás', 'Valeria',
] as const
const LAST_NAMES = [
  'Aguilar', 'Álvarez', 'Campos', 'Castillo', 'Cervantes', 'Cortés', 'Delgado', 'Domínguez',
  'Flores', 'Fuentes', 'Gómez', 'Guzmán', 'Hernández', 'Ibarra', 'Jiménez', 'Lara', 'Luna',
  'Martínez', 'Medina', 'Mendoza', 'Morales', 'Navarro', 'Ortega', 'Pacheco', 'Ramírez',
  'Reyes', 'Ríos', 'Romero', 'Salazar', 'Sánchez', 'Soto', 'Torres', 'Vargas', 'Vega',
] as const
const NOTES = [
  'Seguimiento de presión arterial.',
  'Control metabólico de rutina.',
  'Revisión periódica de factores cardiovasculares.',
  'Seguimiento de hábitos y actividad física.',
  'Control posterior a ajuste de hábitos.',
  'Revisión rutinaria de indicadores clínicos.',
  'Seguimiento de tabaquismo y presión arterial.',
] as const

type RiskProfile = 'LOW' | 'MODERATE' | 'HIGH'
type Trajectory = 'STABLE' | 'IMPROVING' | 'WORSENING'
interface DemoPatientPlan {
  index: number
  doctorUserId: string
  doctorId: string
  visits: number
  lifecycle: 'ACTIVE' | 'INACTIVE_VISIBLE' | 'HIDDEN'
  riskProfile: RiskProfile
  trajectory: Trajectory
  currentAge: number
  sex: 0 | 1
  latestOffsetDays: number
  cadenceDays: number
}

function visitCountFor(index: number): number {
  if (index < 4) return 0
  if (index < 12) return 1
  if (index < 20) return 2
  if (index < 28) return 3
  if (index < 40) return 5
  return 7
}

function lifecycleFor(index: number): DemoPatientPlan['lifecycle'] {
  if (index < 40) return 'ACTIVE'
  if (index < 48) return 'INACTIVE_VISIBLE'
  return 'HIDDEN'
}

const DOCTOR_2_PATIENT_INDICES = new Set([1, 7, 13, 25, 43, 49])
const DOCTOR_3_PATIENT_INDICES = new Set([2, 8, 14, 26, 44, 50])

function doctorSlotForPatient(index: number): 0 | 1 | 2 {
  if (DOCTOR_2_PATIENT_INDICES.has(index)) return 1
  if (DOCTOR_3_PATIENT_INDICES.has(index)) return 2
  return 0
}

function birthDateFor(referenceNow: Date, age: number, index: number): string {
  const y = referenceNow.getUTCFullYear() - age
  const m = (index * 5 + 2) % 12
  const d = 4 + (index * 7) % 23
  return `${String(y).padStart(4, '0')}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
}

function measuredAtFor(referenceNow: Date, plan: DemoPatientPlan, visitIndex: number): Date {
  const newestIndex = Math.max(0, plan.visits - 1)
  const daysBack = plan.latestOffsetDays + (newestIndex - visitIndex) * plan.cadenceDays
  // Keep every generated instant safely in the past, including "today" activity.
  const minuteOffset = 90 + (plan.index % 8) * 17
  return new Date(referenceNow.getTime() - daysBack * 86_400_000 - minuteOffset * 60_000)
}

function clinicalValues(plan: DemoPatientPlan, visitIndex: number) {
  const progress = plan.visits <= 1 ? 0 : visitIndex / (plan.visits - 1)
  const direction = plan.trajectory === 'IMPROVING' ? -1 : plan.trajectory === 'WORSENING' ? 1 : 0
  const drift = direction * progress
  const jitter = () => (rng() - 0.5) * 2

  if (plan.riskProfile === 'LOW') {
    const smoker = plan.index % 9 === 0 && visitIndex < Math.max(1, plan.visits - 2)
    return {
      currentSmoker: smoker,
      cigsPerDay: smoker ? 4 + (plan.index % 5) : 0,
      bpMeds: false,
      diabetes: false,
      totChol: round1(clamp(172 + jitter() * 8 + drift * 10, 145, 205)),
      sysBP: round1(clamp(112 + jitter() * 5 + drift * 9, 96, 132)),
      diaBP: round1(clamp(72 + jitter() * 4 + drift * 5, 60, 84)),
      bmi: round1(clamp(22.8 + jitter() * 1.2 + drift * 1.0, 19, 27)),
      glucose: round1(clamp(84 + jitter() * 6 + drift * 8, 68, 105)),
    }
  }

  if (plan.riskProfile === 'MODERATE') {
    const smoker = plan.index % 3 === 0
    return {
      currentSmoker: smoker,
      cigsPerDay: smoker ? 7 + (plan.index % 7) : 0,
      bpMeds: plan.index % 4 === 0,
      diabetes: plan.index % 9 === 0,
      totChol: round1(clamp(214 + jitter() * 12 + drift * 18, 175, 260)),
      sysBP: round1(clamp(134 + jitter() * 8 + drift * 14, 112, 168)),
      diaBP: round1(clamp(84 + jitter() * 5 + drift * 8, 68, 104)),
      bmi: round1(clamp(27.1 + jitter() * 1.7 + drift * 1.8, 22, 34)),
      glucose: round1(clamp(101 + jitter() * 10 + drift * 16, 78, 145)),
    }
  }

  const smoker = plan.index % 4 !== 0
  return {
    currentSmoker: smoker,
    cigsPerDay: smoker ? 13 + (plan.index % 9) : 0,
    bpMeds: true,
    diabetes: plan.index % 2 === 0,
    totChol: round1(clamp(258 + jitter() * 14 + drift * 20, 210, 315)),
    sysBP: round1(clamp(156 + jitter() * 10 + drift * 18, 128, 192)),
    diaBP: round1(clamp(94 + jitter() * 6 + drift * 10, 76, 118)),
    bmi: round1(clamp(31.2 + jitter() * 2.0 + drift * 2.0, 25, 39)),
    glucose: round1(clamp(137 + jitter() * 15 + drift * 24, 95, 205)),
  }
}

function assertSafeEnvironment() {
  const nodeEnv = (process.env.NODE_ENV ?? 'development').toLowerCase()
  if (nodeEnv === 'production') throw new Error('Commercial demo seed refuses to run with NODE_ENV=production')
  const raw = process.env.DATABASE_URL
  if (!raw) throw new Error('DATABASE_URL is required')
  const url = new URL(raw)
  const allowedHosts = new Set(['localhost', '127.0.0.1', '::1', '[::1]'])
  if (!allowedHosts.has(url.hostname)) {
    throw new Error(`Commercial demo seed refuses non-local database host: ${url.hostname}`)
  }
  const dbName = url.pathname.replace(/^\//, '')
  if (!/^cardiosense(?:[_-](?:dev|demo|development))?$/.test(dbName)) {
    throw new Error(`Commercial demo seed refuses unexpected database name: ${dbName}`)
  }
}

async function drainAutomaticPredictions() {
  for (let pass = 0; pass < 100; pass++) {
    const claimed = await worker.runOnce(25)
    if (claimed === 0) break
  }
  const unfinished = await prisma.automaticPredictionTask.groupBy({
    by: ['status'],
    _count: { _all: true },
    where: { status: { not: 'COMPLETED' } },
  })
  if (unfinished.length) {
    throw new Error(`Commercial seed left unfinished automatic tasks: ${JSON.stringify(unfinished)}`)
  }
}

async function createAccounts() {
  const adminPassword = await bcrypt.hash('Admin1234!', 12)
  const doctorPassword = await bcrypt.hash('Demo1234!', 12)

  await prisma.user.create({
    data: {
      email: 'admin@cardiosense.mx', passwordHash: adminPassword,
      firstName: 'Administración', lastName: 'CardioSense', role: Role.ADMIN,
    },
  })

  const doctors = [
    {
      email: 'dr.garcia@cardiosense.mx', firstName: 'Carlos', lastName: 'García López',
      professionalLicense: 'DEMO-GDL-0001', specialty: 'Cardiología', hospital: 'Hospital Metropolitano de Demostración',
    },
    {
      email: 'dra.torres@cardiosense.example.invalid', firstName: 'Ana', lastName: 'Torres Molina',
      professionalLicense: 'DEMO-GDL-0002', specialty: 'Medicina interna', hospital: 'Clínica Metropolitana de Demostración',
    },
    {
      email: 'dr.herrera@cardiosense.example.invalid', firstName: 'Miguel', lastName: 'Herrera Ruiz',
      professionalLicense: 'DEMO-GDL-0003', specialty: 'Cardiología preventiva', hospital: 'Centro Cardiovascular de Demostración',
    },
  ] as const

  const out: Array<{ userId: string; doctorId: string; email: string }> = []
  for (const d of doctors) {
    const user = await prisma.user.create({
      data: {
        email: d.email, passwordHash: doctorPassword, firstName: d.firstName, lastName: d.lastName,
        role: Role.DOCTOR,
        doctor: { create: { professionalLicense: d.professionalLicense, specialty: d.specialty, hospital: d.hospital } },
      },
      include: { doctor: true },
    })
    if (!user.doctor) throw new Error(`Doctor relation was not created for ${d.email}`)
    out.push({ userId: user.id, doctorId: user.doctor.id, email: d.email })
  }
  return out
}

function planPatients(referenceNow: Date, doctors: Array<{ userId: string; doctorId: string }>): DemoPatientPlan[] {
  return Array.from({ length: 54 }, (_, index) => {
    const doctor = doctors[doctorSlotForPatient(index)]!
    const riskProfile: RiskProfile = (['LOW', 'MODERATE', 'HIGH'] as const)[index % 3]!
    const trajectory: Trajectory = (['STABLE', 'IMPROVING', 'WORSENING'] as const)[Math.floor(index / 3) % 3]!
    const ageBase = riskProfile === 'LOW' ? 37 : riskProfile === 'MODERATE' ? 52 : 64
    const currentAge = ageBase + (index % (riskProfile === 'HIGH' ? 12 : 10))
    return {
      index,
      doctorUserId: doctor.userId,
      doctorId: doctor.doctorId,
      visits: visitCountFor(index),
      lifecycle: lifecycleFor(index),
      riskProfile,
      trajectory,
      currentAge,
      sex: (index % 2) as 0 | 1,
      latestOffsetDays: index % 12,
      cadenceDays: index >= 28 ? 30 : (index % 2 === 0 ? 21 : 45),
    }
  })
}

async function seedClinicalData(referenceNow: Date, doctors: Array<{ userId: string; doctorId: string }>) {
  const plans = planPatients(referenceNow, doctors)
  const created: Array<{ patientId: string; plan: DemoPatientPlan }> = []

  for (const plan of plans) {
    const first = FIRST_NAMES[plan.index % FIRST_NAMES.length]!
    const last1 = LAST_NAMES[(plan.index * 3) % LAST_NAMES.length]!
    const last2 = LAST_NAMES[(plan.index * 7 + 5) % LAST_NAMES.length]!
    const patient = await patientService.create(plan.doctorUserId, {
      firstName: first,
      lastName: `${last1} ${last2}`,
      birthDate: birthDateFor(referenceNow, plan.currentAge, plan.index),
      sex: plan.sex,
      email: `${first.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')}.${plan.index + 1}@patients.example.invalid`,
    })
    created.push({ patientId: patient.id, plan })

    for (let v = 0; v < plan.visits; v++) {
      const clinical = clinicalValues(plan, v)
      await recordService.create(plan.doctorUserId, {
        patientId: patient.id,
        measuredAt: measuredAtFor(referenceNow, plan, v),
        ...clinical,
        notes: pick(NOTES),
      })
    }
  }

  await drainAutomaticPredictions()
  // HealthRecord-created forecast triggers are intentionally asynchronous in product code.
  // A seed must not race them, so wait until every scheduled orchestration has settled before
  // mutating lifecycle or evaluating commercial invariants.
  await waitForForecastTriggersIdle()

  // Lifecycle mutations occur only AFTER all historical clinical workflows have completed,
  // preserving forecast history while ensuring inactive/hidden patients have no current set.
  for (const { patientId, plan } of created) {
    if (plan.lifecycle === 'ACTIVE') continue
    await patientService.setStatus(plan.doctorUserId, patientId, false)
    if (plan.lifecycle === 'HIDDEN') await patientService.hide(plan.doctorUserId, patientId)
  }
  // Lifecycle reconcile is also asynchronous by product design. Drain it deterministically so
  // inactive/hidden patients cannot transiently retain a CURRENT forecast when validation runs.
  await waitForForecastTriggersIdle()

  // Read/unread is presentation state, not clinical evidence. Make the demo inbox realistic
  // without fabricating or editing any clinical Alert content.
  const alertIds = (await prisma.alert.findMany({ orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], select: { id: true } })).map(a => a.id)
  const readIds = alertIds.filter((_, i) => i % 3 !== 0)
  if (readIds.length) await prisma.alert.updateMany({ where: { id: { in: readIds } }, data: { isRead: true } })
}

async function validateCommercialDataset() {
  const [
    users, doctors, patients, records, tasks, predictions, bridges, sets, forecasts, alerts,
    lifecycle, riskLevels, personalization, generation, severities, doctorPatientRows,
  ] = await Promise.all([
    prisma.user.count(), prisma.doctor.count(), prisma.patient.count(), prisma.healthRecord.count(),
    prisma.automaticPredictionTask.count(), prisma.prediction.count(), prisma.rForecastBridgeState.count(),
    prisma.riskForecastSet.count(), prisma.riskForecast.count(), prisma.alert.count(),
    prisma.patient.groupBy({ by: ['isActive', 'isHidden'], _count: { _all: true } }),
    prisma.prediction.groupBy({ by: ['riskLevel'], _count: { _all: true } }),
    prisma.prediction.groupBy({ by: ['personalizationStatus'], _count: { _all: true } }),
    prisma.riskForecastSet.groupBy({ by: ['generationStatus'], _count: { _all: true } }),
    prisma.alert.groupBy({ by: ['severity', 'isRead'], _count: { _all: true } }),
    prisma.doctor.findMany({
      select: {
        user: { select: { email: true } },
        patients: { select: { isActive: true, isHidden: true } },
      },
    }),
  ])

  if (doctors !== 3 || patients !== 54 || records !== 206) {
    throw new Error(`Commercial volume invariant failed: doctors=${doctors}, patients=${patients}, records=${records}`)
  }

  const lifecycleCount = (isActive: boolean, isHidden: boolean) =>
    lifecycle.find(x => x.isActive === isActive && x.isHidden === isHidden)?._count._all ?? 0
  const globalLifecycle = {
    active: lifecycleCount(true, false),
    inactiveVisible: lifecycleCount(false, false),
    hidden: lifecycleCount(false, true),
  }
  if (globalLifecycle.active !== 40 || globalLifecycle.inactiveVisible !== 8 || globalLifecycle.hidden !== 6) {
    throw new Error(`Commercial lifecycle invariant failed: ${JSON.stringify(globalLifecycle)}`)
  }

  const summarizeDoctor = (email: string) => {
    const doctor = doctorPatientRows.find(row => row.user.email === email)
    if (!doctor) throw new Error(`Commercial doctor missing from validation: ${email}`)
    const active = doctor.patients.filter(p => p.isActive && !p.isHidden).length
    const inactiveVisible = doctor.patients.filter(p => !p.isActive && !p.isHidden).length
    const hidden = doctor.patients.filter(p => !p.isActive && p.isHidden).length
    return { active, inactiveVisible, hidden, total: doctor.patients.length }
  }
  const doctorLifecycle = {
    primary: summarizeDoctor('dr.garcia@cardiosense.mx'),
    doctor2: summarizeDoctor('dra.torres@cardiosense.example.invalid'),
    doctor3: summarizeDoctor('dr.herrera@cardiosense.example.invalid'),
  }
  const expectedDoctorLifecycle = {
    primary: { active: 32, inactiveVisible: 6, hidden: 4, total: 42 },
    doctor2: { active: 4, inactiveVisible: 1, hidden: 1, total: 6 },
    doctor3: { active: 4, inactiveVisible: 1, hidden: 1, total: 6 },
  }
  if (JSON.stringify(doctorLifecycle) !== JSON.stringify(expectedDoctorLifecycle)) {
    throw new Error(`Commercial doctor/lifecycle distribution invariant failed: ${JSON.stringify(doctorLifecycle)}`)
  }
  if (await prisma.patient.count({ where: { isActive: true, isHidden: true } })) {
    throw new Error('Invalid lifecycle state true/true detected')
  }
  if (await prisma.prediction.count({ where: { origin: 'LEGACY_UNKNOWN' } })) {
    throw new Error('Commercial reset must contain zero LEGACY_UNKNOWN Predictions')
  }
  if (await prisma.prediction.count({ where: { modelVersion: { not: DEMO_MODEL_VERSION } } })) {
    throw new Error('Unexpected model version persisted during commercial seed')
  }
  if (await prisma.prediction.count({ where: { personalizationVersion: { not: 'R-BPBC-3' } } })) {
    throw new Error('Unexpected personalization version persisted during commercial seed')
  }
  if (await prisma.automaticPredictionTask.count({ where: { status: { not: 'COMPLETED' } } })) {
    throw new Error('Commercial seed contains non-COMPLETED automatic prediction tasks')
  }
  if (await prisma.riskForecastSet.count({ where: { currentForPatientId: { not: null }, patient: { OR: [{ isActive: false }, { isHidden: true }] } } })) {
    throw new Error('Inactive/hidden patient retained a current forecast set')
  }
  const riskSet = new Set(riskLevels.map(x => x.riskLevel))
  for (const level of ['LOW', 'MODERATE', 'HIGH'] as const) {
    if (!riskSet.has(level)) throw new Error(`Commercial risk distribution is missing ${level}; adjust INPUT profiles and rerun the reset`)
  }
  if ((personalization.find(x => x.personalizationStatus === 'INDIVIDUALIZED')?._count._all ?? 0) === 0) {
    throw new Error('Commercial seed produced no INDIVIDUALIZED R-BPBC-3 Predictions')
  }
  if ((generation.find(x => x.generationStatus === 'GENERATED_FULL')?._count._all ?? 0) < 3) {
    throw new Error('Commercial seed produced too few GENERATED_FULL forecast sets')
  }

  return {
    users, doctors, patients, records, tasks, predictions, bridges, sets, forecasts, alerts,
    lifecycle, doctorLifecycle, riskLevels, personalization, generation, severities,
  }
}

async function main() {
  assertSafeEnvironment()
  const referenceNow = new Date()
  const capabilities = await getModelCapabilities()
  if (capabilities.modelVersion !== DEMO_MODEL_VERSION || capabilities.eligibleAgeRange.min !== 32 || capabilities.eligibleAgeRange.max !== 81) {
    throw new Error(`Commercial seed requires ${DEMO_MODEL_VERSION} with support 32-81; got ${capabilities.modelVersion} ${capabilities.eligibleAgeRange.min}-${capabilities.eligibleAgeRange.max}`)
  }

  const existing = await prisma.user.count()
  if (existing !== 0) {
    throw new Error('Commercial demo seed requires an empty database produced by the guarded demo reset')
  }

  const doctors = await createAccounts()
  await seedClinicalData(referenceNow, doctors)
  const summary = await validateCommercialDataset()

  console.log('Commercial demo seed complete.')
  console.log(JSON.stringify({ referenceNow: referenceNow.toISOString(), modelVersion: capabilities.modelVersion, ...summary }, null, 2))
  console.log('Demo login emails: admin@cardiosense.mx, dr.garcia@cardiosense.mx')
  console.log('Passwords are intentionally not printed. Use the documented development credentials or environment-specific demo credentials.')
}

main()
  .catch(err => {
    console.error('Commercial demo seed aborted:', err instanceof Error ? err.message : err)
    process.exitCode = 1
  })
  .finally(async () => prisma.$disconnect())
