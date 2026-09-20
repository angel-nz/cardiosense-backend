// O2 — Dashboard Calendar: multi-patient decoration of P2's event union.
//
// Deliberately NOT added to patient.timeline.ts's own types (O1 section 35):
// Patient Timeline is a single-patient context and never needed
// `patientName`; forcing it in there would leak a Dashboard-only concern
// into an already-closed, validated module. This intersection reuses the
// full discriminated union (CLINICAL_RECORD/PREDICTION/RISK_CHANGE/ALERT)
// as-is — TypeScript correctly distributes `& {patientName}` over each
// member, so discriminated narrowing on `eventType` still works.
import type { PatientTimelineEvent, TimelineEventType } from '@/modules/patients/patient.timeline'

export type DashboardCalendarEvent = PatientTimelineEvent & { patientName: string }

// Same priority P2 uses (patient.timeline.ts's own TYPE_PRIORITY is
// module-private, not exported — this is an intentional, small, documented
// duplication of a 4-entry lookup table rather than modifying P2's file).
const TYPE_PRIORITY: Record<TimelineEventType, number> = {
  CLINICAL_RECORD: 0,
  PREDICTION: 1,
  RISK_CHANGE: 2,
  ALERT: 3,
}

// Global order across MULTIPLE patients: eventDate ASC → type priority →
// patientId → id. P2's sortTimelineEvents() stops at "type priority → id"
// because a single-patient timeline never needs a patientId tie-break —
// reusing it here, unmodified, would silently under-specify the order
// whenever two different patients' events land on the exact same instant
// and type (e.g. two CLINICAL_RECORDs created in the same request burst).
export function sortDashboardCalendarEvents(events: DashboardCalendarEvent[]): DashboardCalendarEvent[] {
  return [...events].sort((a, b) => {
    const dateDiff = new Date(a.eventDate).getTime() - new Date(b.eventDate).getTime()
    if (dateDiff !== 0) return dateDiff
    const typeDiff = TYPE_PRIORITY[a.eventType] - TYPE_PRIORITY[b.eventType]
    if (typeDiff !== 0) return typeDiff
    if (a.patientId !== b.patientId) return a.patientId < b.patientId ? -1 : 1
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}
