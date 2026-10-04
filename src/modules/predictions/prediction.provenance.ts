// R2 — API exposure policy for prediction provenance.
//
// Prediction.inputSnapshot (the exact 12-value object sent to the AI) is
// PERSISTENCE-ONLY in R2: it exists so a prediction can later be explained
// as made, not for doctors or the current frontend to consume. Prisma
// returns every scalar column of a model by default (no `select`), and this
// project's Prediction read paths deliberately use `include`/full rows, so
// without this helper the column would silently leak into every Prediction
// HTTP response. Every repository/service method whose result reaches an
// HTTP response passes its rows through here.
//
// featureContractVersion is NOT stripped: like modelVersion it is a short,
// non-clinical version label, harmless and additive for existing clients
// (the frontend's normalizePrediction() ignores unknown fields).
export function withoutInputSnapshot<T extends { inputSnapshot?: unknown }>(row: T): Omit<T, 'inputSnapshot'> {
  const { inputSnapshot: _persistenceOnly, ...publicFields } = row
  return publicFields
}
