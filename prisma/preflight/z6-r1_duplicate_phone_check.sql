-- Z6-R1 — PRE-MIGRATION DUPLICATE SAFETY CHECK
-- Run this BEFORE `npx prisma migrate deploy` for
-- 20260930220000_allow_doctor_email_or_phone_auth.
--
-- That migration adds a UNIQUE index on medicos.phone. If any two Medico
-- rows already share the same non-null phone value, the migration will
-- fail to apply (and must not be forced through) until the real data is
-- resolved by hand.
--
-- Expected result: ZERO ROWS.
--
-- If this returns any rows: STOP. Do not run migrate deploy. Resolve the
-- real duplicate data first (e.g. decide which Medico actually owns that
-- phone number and clear/update the other row's phone) — do not delete or
-- rewrite data automatically; Claude has not and must not do this for you.

SELECT phone, COUNT(*)
FROM medicos
WHERE phone IS NOT NULL
GROUP BY phone
HAVING COUNT(*) > 1;
