// NEW S4 — CLI: automatic-Prediction task reconciliation.
//   npm run prediction:reconcile                          # DRY RUN (default): report only, no writes
//   npm run prediction:reconcile -- --apply               # create missing durable tasks (clone/test)
//   npm run prediction:reconcile -- --apply --reopen-blocked   # BLOCKED RECORD_NOT_FOUND / PREDICTION_MISMATCH only
//   (BLOCKED/MODEL_INELIGIBLE = terminal age ineligibility: listed, never recreated or reopened)
//   ... -- --patient <uuid> [--patient <uuid>]            # restrict the scope
import 'dotenv/config'
import { prisma } from '@/config/prisma'
import { runPredictionReconcile } from '@/modules/predictions/automatic/reconcile'

async function main() {
  const argv = process.argv.slice(2)
  const apply = argv.includes('--apply')
  const reopenBlocked = argv.includes('--reopen-blocked')
  const patientIds = argv.flatMap((a, i) => (a === '--patient' && argv[i + 1] ? [argv[i + 1]] : []))
  const report = await runPredictionReconcile({ apply, reopenBlocked, patientIds })
  console.log(JSON.stringify(report, null, 2))
  console.log(`PREDICTION RECONCILE ${report.mode}: candidates=${report.candidates.length} withoutTask=${report.candidates.filter(c => !c.task).length} blocked=${report.blockedTasks.length} modelIneligible=${report.modelIneligibleTasks.length} created=${report.created} reopened=${report.reopened}`)
  await prisma.$disconnect()
}
main().catch(async e => { console.error('PREDICTION RECONCILE ERROR', e); await prisma.$disconnect(); process.exit(2) })
