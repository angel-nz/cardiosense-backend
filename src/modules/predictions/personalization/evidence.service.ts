// NEW R (R4B) — backend evidence extraction service.
//
// Repository retrieval (patient-scoped, causally cut) → pure builder.
// R4E: called by PredictionService.predictFromHealthRecord() for every
// (automatic — S2E-FIX4) prediction, after authorization + anchor resolution + eligibility. There is
// deliberately no HTTP endpoint for it.
//
// Security contract: the caller MUST pass an already-authorized patient
// (resolved through the existing doctor-ownership / hidden / active checks in
// PredictionService) and an anchor HealthRecord belonging to that patient
// (R1.5). This service never accepts history ids from outside — it selects
// all history itself, scoped to that patient in every query.
import { HealthRecordRepository } from '@/modules/health-records/record.repository'
import { PredictionRepository } from '@/modules/predictions/prediction.repository'
import {
  buildPersonalizationEvidence, type EvidenceRecordRow, type PersonalizationEvidence,
} from './evidence.builder'

export class PersonalizationEvidenceService {
  constructor(
    private readonly records = new HealthRecordRepository(),
    private readonly predictions = new PredictionRepository(),
  ) {}

  async extract(args: {
    patient:            { id: string }
    anchor:             EvidenceRecordRow
    globalModelVersion: string
    eligibleAgeRange:   { min: number; max: number }
  }): Promise<PersonalizationEvidence> {
    const { patient, anchor } = args
    if (anchor.patientId !== patient.id) {
      // Unreachable through R1.5-scoped anchor resolution; fail closed.
      throw new Error('Personalization evidence: anchor does not belong to the authorized patient')
    }
    const cutoff = anchor.recordedAt
    const priorRecords = await this.records.findPriorRecordsForPatient(patient.id, cutoff)
    const predictions = await this.predictions.findGlobalPredictionsForRecords(
      patient.id, priorRecords.map(r => r.id), cutoff,
    )
    return buildPersonalizationEvidence({
      patientId: patient.id,
      anchor,
      priorRecords,
      predictions,
      globalModelVersion: args.globalModelVersion,
      eligibleAgeRange:   args.eligibleAgeRange,
    })
  }
}
