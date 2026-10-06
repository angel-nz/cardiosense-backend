-- POST-T-DB1 — read-only invariant and commercial-demo audit pack.
-- Run only after the english_database_identifiers migration + commercial demo seed.
-- Expected invariant counts are zero unless explicitly labelled informational.

-- I01 lifecycle invalid state
SELECT 'I01 lifecycle true/true' AS check_name, COUNT(*) AS violations
FROM patients WHERE is_active = true AND is_hidden = true;

-- I02 duplicate automatic Predictions per HealthRecord
SELECT 'I02 duplicate automatic predictions per health record' AS check_name, COUNT(*) AS violations
FROM (
  SELECT health_record_id
  FROM predictions
  WHERE origin = 'AUTOMATIC_HEALTH_RECORD' AND health_record_id IS NOT NULL
  GROUP BY health_record_id HAVING COUNT(*) > 1
) q;

-- I03 duplicate durable task per HealthRecord
SELECT 'I03 duplicate durable tasks per health record' AS check_name, COUNT(*) AS violations
FROM (
  SELECT health_record_id FROM automatic_prediction_tasks
  GROUP BY health_record_id HAVING COUNT(*) > 1
) q;

-- I04 automatic Prediction without source HealthRecord
SELECT 'I04 automatic prediction without health record' AS check_name, COUNT(*) AS violations
FROM predictions p
LEFT JOIN health_records h ON h.id = p.health_record_id
WHERE p.origin = 'AUTOMATIC_HEALTH_RECORD' AND (p.health_record_id IS NULL OR h.id IS NULL);

-- I05 malformed COMPLETED task
-- next_attempt_at is intentionally allowed to remain populated for COMPLETED tasks;
-- the canonical worker clears lease/error state but does not clear that scheduling timestamp.
SELECT 'I05 malformed completed task' AS check_name, COUNT(*) AS violations
FROM automatic_prediction_tasks
WHERE status = 'COMPLETED'
  AND (
    prediction_id IS NULL
    OR completed_at IS NULL
    OR lease_until IS NOT NULL
    OR lease_owner IS NOT NULL
    OR last_error_code IS NOT NULL
  );

-- I06 malformed terminal MODEL_INELIGIBLE task
SELECT 'I06 malformed model-ineligible task' AS check_name, COUNT(*) AS violations
FROM automatic_prediction_tasks
WHERE status = 'BLOCKED' AND last_error_code = 'MODEL_INELIGIBLE'
  AND (prediction_id IS NOT NULL OR completed_at IS NOT NULL OR next_attempt_at IS NOT NULL OR lease_until IS NOT NULL OR lease_owner IS NOT NULL);

-- I07 at most one current forecast per patient (defense beyond unique index)
SELECT 'I07 patients with >1 current forecast set' AS check_name, COUNT(*) AS violations
FROM (
  SELECT patient_id FROM risk_forecast_sets
  WHERE current_for_patient_id IS NOT NULL
  GROUP BY patient_id HAVING COUNT(*) > 1
) q;

-- I08 current marker identity
SELECT 'I08 mismatched current_for_patient_id' AS check_name, COUNT(*) AS violations
FROM risk_forecast_sets
WHERE current_for_patient_id IS NOT NULL AND current_for_patient_id <> patient_id;

-- I09 inactive/hidden patients may not retain a current forecast
SELECT 'I09 inactive/hidden patients with current forecast' AS check_name, COUNT(*) AS violations
FROM risk_forecast_sets s
JOIN patients p ON p.id = s.patient_id
WHERE s.current_for_patient_id IS NOT NULL AND (p.is_active = false OR p.is_hidden = true);

-- I10 duplicate horizon per set
SELECT 'I10 duplicate horizon per forecast set' AS check_name, COUNT(*) AS violations
FROM (
  SELECT set_id, horizon_index FROM risk_forecasts
  GROUP BY set_id, horizon_index HAVING COUNT(*) > 1
) q;

-- I11 bridge identity must match its Prediction
SELECT 'I11 bridge/prediction identity mismatch' AS check_name, COUNT(*) AS violations
FROM r_forecast_bridge_states b
JOIN predictions p ON p.id = b.prediction_id
WHERE p.patient_id <> b.patient_id
   OR p.health_record_id IS DISTINCT FROM b.health_record_id
   OR p.model_version IS DISTINCT FROM b.model_version
   OR p.personalization_version IS DISTINCT FROM b.personalization_version;

-- I12 bridge is valid only for individualized NEW-R Prediction
SELECT 'I12 invalid individualized bridge relation' AS check_name, COUNT(*) AS violations
FROM r_forecast_bridge_states b
JOIN predictions p ON p.id = b.prediction_id
WHERE b.status <> 'INDIVIDUALIZED'
   OR p.personalization_status <> 'INDIVIDUALIZED'
   OR p.global_risk_score IS NULL
   OR p.personalization_version IS NULL;

-- I13 NEW-R persistence pair must be complete
SELECT 'I13 incomplete NEW-R pair' AS check_name, COUNT(*) AS violations
FROM predictions
WHERE (personalization_status IS NULL) <> (global_risk_score IS NULL)
   OR (personalization_status IS NOT NULL AND personalization_version IS NULL);

-- I14 obsolete heart_rate column absent
SELECT 'I14 legacy heart_rate schema column' AS check_name, COUNT(*) AS violations
FROM information_schema.columns
WHERE table_schema = current_schema() AND column_name = 'heart_rate';

-- I15 old Spanish runtime tables absent
SELECT 'I15 old Spanish DB tables' AS check_name, COUNT(*) AS violations
FROM information_schema.tables
WHERE table_schema = current_schema() AND table_name IN ('medicos', 'pacientes');

-- I16 old Spanish runtime columns absent
SELECT 'I16 old Spanish DB columns' AS check_name, COUNT(*) AS violations
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (column_name ILIKE '%medico%' OR column_name ILIKE '%paciente%' OR column_name ILIKE '%cedula%' OR column_name ILIKE '%especialidad%');

-- I17 old Spanish constraints/indexes absent
SELECT 'I17 old Spanish DB constraints/indexes' AS check_name, COUNT(*) AS violations
FROM (
  SELECT conname AS object_name
  FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
  WHERE n.nspname = current_schema()
  UNION ALL
  SELECT indexname
  FROM pg_indexes
  WHERE schemaname = current_schema()
) q
WHERE object_name ILIKE '%medico%'
   OR object_name ILIKE '%paciente%'
   OR object_name ILIKE '%cedula%'
   OR object_name ILIKE '%especialidad%';

-- I18 Role enum contains no old Spanish values
SELECT 'I18 MEDICO/PACIENTE enum values' AS check_name, COUNT(*) AS violations
FROM pg_enum e
JOIN pg_type t ON t.oid = e.enumtypid
JOIN pg_namespace n ON n.oid = t.typnamespace
WHERE n.nspname = current_schema() AND t.typname = 'Role' AND e.enumlabel IN ('MEDICO', 'PACIENTE');

-- I19 commercial reset has no legacy Prediction origin
SELECT 'I19 legacy unknown predictions' AS check_name, COUNT(*) AS violations
FROM predictions WHERE origin = 'LEGACY_UNKNOWN';

-- I20 commercial reset has no legacy model/R versions
SELECT 'I20 legacy model/R versions' AS check_name, COUNT(*) AS violations
FROM predictions
WHERE model_version IS DISTINCT FROM 'Skorp-Beta-0.2'
   OR personalization_version IS DISTINCT FROM 'R-BPBC-3';

-- I21 no old S policies in clean commercial DB
SELECT 'I21 legacy S policy versions' AS check_name, COUNT(*) AS violations
FROM risk_forecast_sets
WHERE s_version <> 'S-3'
   OR clinical_time_policy_version <> 'S-TIME-1'
   OR cadence_policy_version <> 'S-CAD-3'
   OR feature_policy_version <> 'S-FEAT-SEQUENTIAL-ROBUST-2';

-- I22 no accidental unfinished technical work
SELECT 'I22 unfinished automatic prediction work' AS check_name, COUNT(*) AS violations
FROM automatic_prediction_tasks
WHERE status <> 'COMPLETED';

-- Informational commercial-demo summary
SELECT 'users' AS metric, COUNT(*)::text AS value FROM users
UNION ALL SELECT 'doctors', COUNT(*)::text FROM doctors
UNION ALL SELECT 'patients', COUNT(*)::text FROM patients
UNION ALL SELECT 'health_records', COUNT(*)::text FROM health_records
UNION ALL SELECT 'automatic_prediction_tasks', COUNT(*)::text FROM automatic_prediction_tasks
UNION ALL SELECT 'predictions', COUNT(*)::text FROM predictions
UNION ALL SELECT 'r_forecast_bridge_states', COUNT(*)::text FROM r_forecast_bridge_states
UNION ALL SELECT 'risk_forecast_sets', COUNT(*)::text FROM risk_forecast_sets
UNION ALL SELECT 'risk_forecasts', COUNT(*)::text FROM risk_forecasts
UNION ALL SELECT 'alerts', COUNT(*)::text FROM alerts
ORDER BY metric;

SELECT is_active, is_hidden, COUNT(*) AS patients
FROM patients GROUP BY is_active, is_hidden ORDER BY is_active DESC, is_hidden;

SELECT risk_level, COUNT(*) FROM predictions GROUP BY risk_level ORDER BY risk_level;
SELECT personalization_status, COUNT(*) FROM predictions GROUP BY personalization_status ORDER BY personalization_status;
SELECT eligibility_status, COUNT(*) FROM risk_forecast_sets GROUP BY eligibility_status ORDER BY eligibility_status;
SELECT generation_status, COUNT(*) FROM risk_forecast_sets GROUP BY generation_status ORDER BY generation_status;
SELECT severity, is_read, COUNT(*) FROM alerts GROUP BY severity, is_read ORDER BY severity, is_read;
SELECT status, last_error_code, COUNT(*) FROM automatic_prediction_tasks GROUP BY status, last_error_code ORDER BY status, last_error_code;

SELECT model_version, COUNT(*) FROM predictions GROUP BY model_version ORDER BY model_version;
SELECT personalization_version, COUNT(*) FROM predictions GROUP BY personalization_version ORDER BY personalization_version;
SELECT s_version, clinical_time_policy_version, cadence_policy_version, feature_policy_version, model_version, COUNT(*)
FROM risk_forecast_sets
GROUP BY s_version, clinical_time_policy_version, cadence_policy_version, feature_policy_version, model_version
ORDER BY s_version, clinical_time_policy_version, cadence_policy_version, feature_policy_version, model_version;

-- Full catalog audit for active non-English identifiers. Expected: zero rows.
SELECT 'table' AS object_type, table_name AS object_name
FROM information_schema.tables
WHERE table_schema = current_schema()
  AND (table_name ILIKE '%medico%' OR table_name ILIKE '%paciente%' OR table_name ILIKE '%cedula%' OR table_name ILIKE '%especialidad%')
UNION ALL
SELECT 'column', table_name || '.' || column_name
FROM information_schema.columns
WHERE table_schema = current_schema()
  AND (column_name ILIKE '%medico%' OR column_name ILIKE '%paciente%' OR column_name ILIKE '%cedula%' OR column_name ILIKE '%especialidad%')
UNION ALL
SELECT 'constraint', conname
FROM pg_constraint c JOIN pg_namespace n ON n.oid = c.connamespace
WHERE n.nspname = current_schema()
  AND (conname ILIKE '%medico%' OR conname ILIKE '%paciente%' OR conname ILIKE '%cedula%' OR conname ILIKE '%especialidad%')
UNION ALL
SELECT 'index', indexname
FROM pg_indexes
WHERE schemaname = current_schema()
  AND (indexname ILIKE '%medico%' OR indexname ILIKE '%paciente%' OR indexname ILIKE '%cedula%' OR indexname ILIKE '%especialidad%')
UNION ALL
SELECT 'view', table_name
FROM information_schema.views
WHERE table_schema = current_schema()
  AND (table_name ILIKE '%medico%' OR table_name ILIKE '%paciente%' OR table_name ILIKE '%cedula%' OR table_name ILIKE '%especialidad%')
UNION ALL
SELECT 'materialized_view', matviewname
FROM pg_matviews
WHERE schemaname = current_schema()
  AND (matviewname ILIKE '%medico%' OR matviewname ILIKE '%paciente%' OR matviewname ILIKE '%cedula%' OR matviewname ILIKE '%especialidad%')
UNION ALL
SELECT 'trigger', trigger_name
FROM information_schema.triggers
WHERE trigger_schema = current_schema()
  AND (trigger_name ILIKE '%medico%' OR trigger_name ILIKE '%paciente%' OR trigger_name ILIKE '%cedula%' OR trigger_name ILIKE '%especialidad%')
UNION ALL
SELECT 'function', p.proname
FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = current_schema()
  AND (p.proname ILIKE '%medico%' OR p.proname ILIKE '%paciente%' OR p.proname ILIKE '%cedula%' OR p.proname ILIKE '%especialidad%')
UNION ALL
SELECT 'sequence', sequence_name
FROM information_schema.sequences
WHERE sequence_schema = current_schema()
  AND (sequence_name ILIKE '%medico%' OR sequence_name ILIKE '%paciente%' OR sequence_name ILIKE '%cedula%' OR sequence_name ILIKE '%especialidad%')
ORDER BY object_type, object_name;
