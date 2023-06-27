-- BLOCK selectQuery 
SELECT
  COALESCE(aap.assessment_id::text, '—') AS assessment_id,
  COALESCE(format_date_full_compact(aap.created_at, 'America/Chicago'), '—') AS created_at,
  COALESCE(aap.created_by::text, '—') AS created_by,
  COALESCE(aap.credit::text, '—') AS credit,
  COALESCE(format_date_full_compact(aap.end_date, 'America/Chicago'), '—') AS end_date,
  COALESCE(aap.group_id::text, '—') AS group_id,
  COALESCE(aap.note, '—') AS note,
  COALESCE(format_date_full_compact(aap.start_date, 'America/Chicago'), '—') AS start_date,
  COALESCE(aap.extension_type::text, '—') AS type,
  COALESCE(aap.user_id::text, '—') AS user_id
FROM
  assessment_access_policies AS aap
WHERE assessment_id = $assessment_id
ORDER BY
  aap.created_at;

-- BLOCK insertQuery
INSERT INTO assessment_access_policies
  (assessment_id, created_at, created_by, credit, end_date, group_id, note, start_date, extension_type, user_id)
VALUES
  ($assessment_id, $created_at, $created_by, $credit, $end_date, $group_id, $note, $start_date, $type, $user_id);