interface SubscribeSocket {
  id: string
  join(room: string): void | Promise<unknown>
}

interface SubscribePatientDataSource {
  doctor: {
    findUnique(args: { where: { userId: string } }): Promise<{ id: string } | null>
  }
  patient: {
    findFirst(args: { where: { id: string; doctorId: string } }): Promise<{ id: string } | null>
  }
}

interface SubscribeLogger {
  debug(message: string): void
  warn(message: string, meta?: Record<string, unknown>): void
}

export interface SubscribePatientHandlerDependencies {
  socket: SubscribeSocket
  userId: string
  dataSource: SubscribePatientDataSource
  logger: SubscribeLogger
}

// INTEGRITY-1B — the Socket.IO callback owns its operational rejection
// boundary. Authorization remains deny-by-default: any dependency failure
// returns without joining the patient room, and only safe diagnostic fields
// are logged (never token/session/clinical payloads or raw DB errors).
export function createSubscribePatientHandler(deps: SubscribePatientHandlerDependencies) {
  return async (patientId: string): Promise<void> => {
    if (typeof patientId !== 'string') return

    try {
      const doctor = await deps.dataSource.doctor.findUnique({ where: { userId: deps.userId } })
      if (!doctor) {
        deps.logger.warn(`[Socket] ${deps.userId} rejected — no doctor profile for subscribe_patient`)
        return
      }

      const patient = await deps.dataSource.patient.findFirst({
        where: { id: patientId, doctorId: doctor.id },
      })
      if (!patient) {
        deps.logger.warn(`[Socket] ${deps.userId} rejected subscribe_patient:${patientId} — not owned by this doctor`)
        return
      }

      await deps.socket.join(`patient:${patientId}`)
      deps.logger.debug(`[Socket] ${deps.userId} subscribed to patient:${patientId}`)
    } catch (error) {
      deps.logger.warn('[Socket] subscribe_patient failed safely — room not joined', {
        socketId: deps.socket.id,
        event: 'subscribe_patient',
        patientId,
        errorType: error instanceof Error ? error.name : typeof error,
      })
    }
  }
}
