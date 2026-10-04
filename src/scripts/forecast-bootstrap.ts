// NEW S2D — CLI: S forecast bootstrap.
//   npm run forecast:bootstrap               # DRY RUN (default): no forecast writes
//   npm run forecast:bootstrap -- --apply    # persist / supersede via the orchestrator
//   ... -- --patient <uuid> [--patient <uuid>]   # restrict the universe (diagnostics)
import 'dotenv/config'
import { prisma } from '@/config/prisma'
import { runForecastBootstrap } from '@/modules/risk-forecasts/forecast.bootstrap'

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const patientIds = argv.flatMap((a, i) => (a === '--patient' && argv[i + 1] ? [argv[i + 1]] : []))
  const report = await runForecastBootstrap({ apply, patientIds: patientIds.length ? patientIds : undefined })
  console.log(JSON.stringify(report, null, 2))
  console.log(`FORECAST BOOTSTRAP ${report.mode}: scanned=${report.counts.patientsScanned} errors=${report.counts.errors}`)
  await prisma.$disconnect()
  process.exit(report.counts.errors ? 1 : 0)
}
main().catch(async e => { console.error('FORECAST BOOTSTRAP ERROR', e); await prisma.$disconnect(); process.exit(2) })
