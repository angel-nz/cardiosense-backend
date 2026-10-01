import { prisma } from '@/config/prisma'
import { logger } from '@/lib/logger'

// Y4 — the explicit clinical cause a persisted Alert was created for, used
// ONLY to decide whether the optional `new_alert` realtime event is
// delivered. This is transient delivery metadata, not a persisted column —
// the Alert schema is unchanged for these three (Y4 §6). A stable typed
// value, set by the prediction branch that actually knows why it's creating
// the Alert — never inferred from severity or message text (Y4 §5/§31),
// since MODERATE and ANOMALY can share the same WARNING severity.
//
// Z5 — three information categories added, one per Configurable Information
// Alert event. Unlike the three prediction categories above, these DO also
// correspond 1:1 to a persisted `Alert.type` (AlertType enum, schema.prisma)
// — that column is what AlertService.createInformationAlert actually
// receives and uses both to persist `type` and to resolve the category
// here, so the two enumerations are deliberately kept with identical
// member names (never renamed independently of one another).
//
// Z6-R2 §1/§2 — the doctor-profile information alert category removed:
// that product decision (and the persisted Alert type/preference it
// gated) was withdrawn entirely, not merely disabled by default. No
// replacement category is added in its place.
export type RealtimeAlertCategory =
  | 'HIGH_RISK' | 'MODERATE_RISK' | 'ANOMALY'
  | 'INFO_PATIENT_CREATED' | 'INFO_PATIENT_UPDATED'
  | 'INFO_HEALTH_RECORD_CREATED'

// Y4 §26 / Z5 — the one and only category → NotificationPreference field
// mapping in the codebase. Anything that needs to know which preference
// gates which category reads it from here, never duplicates it.
const CATEGORY_PREFERENCE_FIELD = {
  HIGH_RISK:     'highRiskRealtime',
  MODERATE_RISK: 'moderateRiskRealtime',
  ANOMALY:       'anomalyRealtime',
  INFO_PATIENT_CREATED:       'patientCreatedRealtime',
  INFO_PATIENT_UPDATED:       'patientUpdatedRealtime',
  INFO_HEALTH_RECORD_CREATED: 'healthRecordCreatedRealtime',
} as const satisfies Record<RealtimeAlertCategory, string>

// Y4 §10/§22/§23 — resolves whether `new_alert` should be delivered for this
// category, for this user, AFTER the Alert row is already persisted (caller's
// responsibility — this function never touches Alert persistence). No
// NotificationPreference row (never configured) defaults to enabled, same as
// the GET /me/notification-preferences contract. If the lookup itself fails
// unexpectedly, the documented safe fallback is ENABLED (preserve historical
// "always notify" behavior) — a transient preference-read failure must never
// silently suppress a clinically important realtime notification, and it
// never affects the already-persisted Alert either way.
export async function isRealtimeNotificationEnabled(
  userId: string,
  category: RealtimeAlertCategory,
): Promise<boolean> {
  const field = CATEGORY_PREFERENCE_FIELD[category]
  try {
    const pref = await prisma.notificationPreference.findUnique({
      where:  { userId },
      select: { [field]: true },
    })
    if (!pref) return true
    return (pref as Record<string, boolean>)[field]
  } catch (err) {
    logger.warn('Failed to resolve notification preference — defaulting to enabled', {
      userId,
      category,
      err: err instanceof Error ? err.message : err,
    })
    return true
  }
}
