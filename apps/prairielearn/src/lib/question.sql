-- BLOCK select_issues
SELECT
  i.assessment_id,
  i.authn_user_id,
  i.course_caused,
  (
    CASE
      WHEN $load_course_data THEN i.course_data
    END
  ) AS course_data,
  i.course_id,
  i.course_instance_id,
  i.date,
  i.id,
  i.instance_question_id,
  i.instructor_message,
  i.manually_reported,
  i.open,
  i.question_id,
  i.student_message,
  (
    CASE
      WHEN $load_system_data THEN i.system_data
    END
  ) AS system_data,
  i.user_id,
  i.variant_id,
  format_date_full (
    i.date,
    coalesce(ci.display_timezone, c.display_timezone)
  ) AS formatted_date,
  u.uid AS user_uid,
  u.name AS user_name
FROM
  issues AS i
  LEFT JOIN course_instances AS ci ON (ci.id = i.course_instance_id)
  JOIN pl_courses AS c ON (c.id = i.course_id)
  LEFT JOIN users AS u ON (u.user_id = i.user_id)
WHERE
  i.variant_id = $variant_id
  AND i.course_caused
ORDER BY
  i.date;

-- BLOCK select_basic_submissions
SELECT
  -- This includes every `submissions` column EXCEPT for jsonb columns.
  -- Those can be quite large in size, so we'll only load them for specific
  -- submissions in the `select_detailed_submissions` query below.
  s.auth_user_id,
  s.broken,
  s.correct,
  s.credit,
  s.date,
  s.duration,
  s.gradable,
  s.graded_at,
  s.grading_method,
  s.grading_requested_at,
  s.id,
  s.mode,
  s.override_score,
  s.regradable,
  s.score,
  s.sid,
  s.v2_score,
  s.variant_id,
  s.manual_rubric_grading_id,
  to_jsonb(gj) AS grading_job,
  -- These are separate for historical reasons
  gj.id AS grading_job_id,
  grading_job_status (gj.id) AS grading_job_status,
  format_date_full_compact (
    s.date,
    coalesce(ci.display_timezone, c.display_timezone)
  ) AS formatted_date,
  CASE
    WHEN s.grading_requested_at IS NOT NULL THEN format_interval ($req_date - s.grading_requested_at)
    ELSE NULL
  END AS elapsed_grading_time
FROM
  submissions AS s
  JOIN variants AS v ON (v.id = s.variant_id)
  LEFT JOIN instance_questions AS iq ON (iq.id = v.instance_question_id)
  LEFT JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
  LEFT JOIN assessments AS a ON (a.id = ai.assessment_id)
  LEFT JOIN course_instances AS ci ON (ci.id = a.course_instance_id)
  JOIN questions AS q ON (q.id = v.question_id)
  JOIN pl_courses AS c ON (c.id = v.course_id)
  LEFT JOIN LATERAL (
    SELECT
      *
    FROM
      grading_jobs
    WHERE
      submission_id = s.id
      AND grading_method != 'Manual'
    ORDER BY
      date DESC,
      id DESC
    LIMIT
      1
  ) AS gj ON TRUE
WHERE
  v.id = $variant_id
ORDER BY
  s.date DESC;

-- BLOCK select_detailed_submissions
SELECT
  -- This includes ONLY the jsonb columns from `submissions`.
  s.feedback,
  s.format_errors,
  s.params,
  s.partial_scores,
  s.raw_submitted_answer,
  s.submitted_answer,
  s.true_answer
FROM
  submissions AS s
WHERE
  s.id IN (
    SELECT
      UNNEST($submission_ids::bigint[])
  )
ORDER BY
  s.date DESC;

-- BLOCK select_issue_count_for_variant
SELECT
  COUNT(*)::int
FROM
  issues AS i
WHERE
  i.variant_id = $variant_id;

-- BLOCK select_submission_info
WITH
  next_iq AS (
    SELECT
      iq.id AS current_id,
      (lead(iq.id) OVER w) AS id,
      (lead(qo.sequence_locked) OVER w) AS sequence_locked
    FROM
      instance_questions AS iq
      JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
      JOIN question_order (ai.id) AS qo ON (qo.instance_question_id = iq.id)
    WHERE
      -- need all of these rows to join on question_order
      ai.id IN (
        SELECT
          iq.assessment_instance_id
        FROM
          submissions AS s
          JOIN variants AS v ON (v.id = s.variant_id)
          JOIN instance_questions AS iq ON (iq.id = v.instance_question_id)
          JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
        WHERE
          s.id = $submission_id
      )
    WINDOW
      w AS (
        ORDER BY
          qo.row_order
      )
  ),
  last_grading_job AS (
    SELECT
      *
    FROM
      grading_jobs AS gj
    WHERE
      gj.submission_id = $submission_id
      AND grading_method != 'Manual'
    ORDER BY
      gj.date DESC,
      gj.id DESC
    LIMIT
      1
  )
SELECT
  to_jsonb(lgj) AS grading_job,
  to_jsonb(s) AS submission,
  to_jsonb(v) AS variant,
  to_jsonb(iq) || to_jsonb(iqnag) AS instance_question,
  jsonb_build_object(
    'id',
    next_iq.id,
    'sequence_locked',
    next_iq.sequence_locked
  ) AS next_instance_question,
  to_jsonb(q) AS question,
  to_jsonb(aq) AS assessment_question,
  to_jsonb(ai) AS assessment_instance,
  to_jsonb(a) AS assessment,
  to_jsonb(aset) AS assessment_set,
  to_jsonb(ci) AS course_instance,
  to_jsonb(qc) AS question_course,
  to_jsonb(ci) AS course_instance,
  lgj.id AS grading_job_id,
  grading_job_status (lgj.id) AS grading_job_status,
  format_date_full_compact (
    s.date,
    coalesce(ci.display_timezone, c.display_timezone)
  ) AS formatted_date,
  (
    SELECT
      count(*)
    FROM
      submissions AS s2
    WHERE
      s2.variant_id = s.variant_id
      AND s2.date < s.date
  ) + 1 AS submission_index,
  (
    SELECT
      count(*)
    FROM
      submissions AS s2
    WHERE
      s2.variant_id = s.variant_id
  ) AS submission_count
FROM
  submissions AS s
  JOIN variants AS v ON (v.id = s.variant_id)
  LEFT JOIN last_grading_job AS lgj ON (TRUE)
  LEFT JOIN instance_questions AS iq ON (iq.id = v.instance_question_id)
  JOIN questions AS q ON (q.id = v.question_id)
  LEFT JOIN assessment_questions AS aq ON (iq.assessment_question_id = aq.id)
  LEFT JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
  LEFT JOIN assessments AS a ON (a.id = ai.assessment_id)
  LEFT JOIN assessment_sets AS aset ON (aset.id = a.assessment_set_id)
  LEFT JOIN course_instances AS ci ON (ci.id = v.course_instance_id)
  JOIN pl_courses AS c ON (c.id = v.course_id)
  JOIN pl_courses AS qc ON (qc.id = q.course_id)
  JOIN LATERAL instance_questions_next_allowed_grade (iq.id) AS iqnag ON TRUE
  LEFT JOIN next_iq ON (next_iq.current_id = iq.id)
WHERE
  s.id = $submission_id
  AND q.id = $question_id
  AND (
    CASE
      WHEN $instance_question_id::BIGINT IS NULL THEN iq.id IS NULL
      ELSE iq.id = $instance_question_id::BIGINT
    END
  )
  AND v.id = $variant_id;

-- BLOCK select_assessment_for_submission
SELECT
  ai.id AS assessment_instance_id
FROM
  submissions AS s
  JOIN variants AS v ON (v.id = s.variant_id)
  LEFT JOIN instance_questions AS iq ON (iq.id = v.instance_question_id)
  LEFT JOIN assessment_instances AS ai ON (ai.id = iq.assessment_instance_id)
WHERE
  s.id = $submission_id;

-- BLOCK select_workspace_id
SELECT
  w.id AS workspace_id
FROM
  variants AS v
  JOIN workspaces AS w ON (v.workspace_id = w.id)
WHERE
  v.id = $variant_id;

-- BLOCK select_question_course
SELECT
  to_jsonb(c.*) AS course
FROM
  pl_courses AS c
WHERE
  c.id = $question_course_id;
