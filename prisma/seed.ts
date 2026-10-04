import { PrismaClient, Role } from '@prisma/client'
import bcrypt from 'bcryptjs'

const prisma = new PrismaClient()

async function main() {
  console.log('🌱 Seeding database...')

  // Admin user
  const adminHash = await bcrypt.hash('Admin1234!', 12)
  const admin = await prisma.user.upsert({
    where: { email: 'admin@cardiosense.mx' },
    update: {},
    create: {
      email: 'admin@cardiosense.mx',
      passwordHash: adminHash,
      firstName: 'Admin',
      lastName: 'CardioSense',
      role: Role.ADMIN,
    },
  })

  // Demo doctor
  const doctorHash = await bcrypt.hash('Demo1234!', 12)
  const doctor = await prisma.user.upsert({
    where: { email: 'dr.garcia@cardiosense.mx' },
    update: {},
    create: {
      email: 'dr.garcia@cardiosense.mx',
      passwordHash: doctorHash,
      firstName: 'Carlos',
      lastName: 'García López',
      role: Role.MEDICO,
      medico: {
        create: {
          cedulaProfesional: '1234567',
          especialidad: 'Cardiología',
          hospital: 'Hospital Civil de Guadalajara',
        },
      },
    },
    include: { medico: true },
  })

  const medico = await prisma.medico.findUnique({ where: { userId: doctor.id } })
  if (!medico) throw new Error('Medico not created')

  // Demo patients
  const p1 = await prisma.paciente.upsert({
    where: { curp: 'RAVJ680514HMCRNS04' },
    update: {},
    create: {
      medicoId: medico.id,
      firstName: 'Juan Carlos',
      lastName: 'Ramírez Vega',
      birthDate: new Date('1968-05-14'),
      sex: 1,
      curp: 'RAVJ680514HMCRNS04',
      phone: '+52 33 1234 5678',
    },
  })

  const p2 = await prisma.paciente.upsert({
    where: { curp: 'LOHM751103MJCPRR09' },
    update: {},
    create: {
      medicoId: medico.id,
      firstName: 'María Elena',
      lastName: 'López Hernández',
      birthDate: new Date('1975-11-03'),
      sex: 0,
      curp: 'LOHM751103MJCPRR09',
      phone: '+52 33 9876 5432',
    },
  })

  // Health record for p1
  // NEW S2A — every NEW HealthRecord carries an explicit REAL clinical time
  // (clinicalTimeSource has no DB default). Demo seed: measured "now".
  const seedMeasuredAt = new Date()
  const record = await prisma.healthRecord.create({
    data: {
      patientId: p1.id,
      recordedAt: seedMeasuredAt,
      measuredAt: seedMeasuredAt,
      clinicalTimeSource: 'CLINICIAN_ENTERED',
      age: 56,
      currentSmoker: true,
      cigsPerDay: 10,
      bpMeds: true,
      diabetes: false,
      totChol: 245.0,
      sysBP: 158.0,
      diaBP: 95.0,
      bmi: 29.8,
      heartRate: 82,
      glucose: 118.0,
      notes: 'Consulta de rutina. Paciente refiere cefalea frecuente.',
      createdBy: doctor.id,
    },
  })

  // Prediction for p1
  const prediction = await prisma.prediction.create({
    data: {
      patientId: p1.id,
      healthRecordId: record.id,
      riskScore: 0.7234,
      riskLevel: 'HIGH',
      // NEW S2E-FIX3 — synthetic demo row, not produced by either real path.
      origin: 'LEGACY_UNKNOWN',
      anomalyScore: -0.0812,
      isAnomaly: false,
      modelVersion: '1.2.0',
    },
  })

  // Alert for p1
  await prisma.alert.create({
    data: {
      patientId: p1.id,
      predictionId: prediction.id,
      severity: 'CRITICAL',
      message: 'Riesgo cardiovascular alto detectado (72.3%). Presión sistólica: 158 mmHg, Glucosa: 118 mg/dL.',
    },
  })

  console.log('✅ Seed complete.')
  console.log(`   Admin:  admin@cardiosense.mx  / Admin1234!`)
  console.log(`   Doctor: dr.garcia@cardiosense.mx / Demo1234!`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
