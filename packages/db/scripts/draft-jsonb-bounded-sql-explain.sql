BEGIN;

CREATE TEMP TABLE bounded_rows (
  id INTEGER PRIMARY KEY,
  title TEXT NOT NULL,
  score INTEGER NOT NULL
);
CREATE INDEX bounded_rows_score_id_idx ON bounded_rows (score DESC, id);

CREATE TEMP TABLE wystack_draft_row_changes (
  draft_id TEXT NOT NULL,
  table_key TEXT NOT NULL,
  tenant_key_text TEXT NOT NULL DEFAULT '',
  tenant_key JSONB,
  row_key_text TEXT NOT NULL,
  row_key JSONB NOT NULL,
  operation TEXT NOT NULL,
  base_exists BOOLEAN NOT NULL,
  base_revision JSONB,
  fields JSONB NOT NULL DEFAULT '{}'::JSONB,
  PRIMARY KEY (draft_id, table_key, tenant_key_text, row_key_text)
);

INSERT INTO bounded_rows (id, title, score)
SELECT value, 'row-' || value, 100000 - value
FROM generate_series(1, 100000) value;

-- Eight updates: odd identities leave the prefix, even identities move upward.
INSERT INTO wystack_draft_row_changes
  (draft_id, table_key, tenant_key_text, row_key_text, row_key,
   operation, base_exists, fields)
SELECT
  'target', 'bounded_rows', '',
  jsonb_build_object('type', 'integer', 'value', value)::TEXT,
  jsonb_build_object('type', 'integer', 'value', value),
  'update', TRUE,
  jsonb_build_object(
    'score', jsonb_build_object(
      'original', jsonb_build_object('kind', 'value', 'value', 100000 - value),
      'value', jsonb_build_object(
        'kind', 'value',
        'value', CASE WHEN value % 2 = 0 THEN 200000 + value ELSE 1 END
      )
    )
  )
FROM generate_series(1, 8) value;

-- One delete and one draft-only insert complete M = 10.
INSERT INTO wystack_draft_row_changes
  (draft_id, table_key, tenant_key_text, row_key_text, row_key,
   operation, base_exists, fields)
VALUES
  ('target', 'bounded_rows', '', '{"type": "integer", "value": 9}',
   '{"type": "integer", "value": 9}', 'delete', TRUE, '{}'),
  ('target', 'bounded_rows', '', '{"type": "integer", "value": 100001}',
   '{"type": "integer", "value": 100001}', 'insert', FALSE,
   '{"title":{"original":{"kind":"sql-null"},"value":{"kind":"value","value":"inserted"}},
     "score":{"original":{"kind":"sql-null"},"value":{"kind":"value","value":199999}}}');

-- Noise proves the target lookup stays draft-indexed.
INSERT INTO wystack_draft_row_changes
  (draft_id, table_key, tenant_key_text, row_key_text, row_key,
   operation, base_exists, fields)
SELECT
  'other-' || value, 'bounded_rows', '',
  jsonb_build_object('type', 'integer', 'value', value)::TEXT,
  jsonb_build_object('type', 'integer', 'value', value),
  'update', TRUE, '{}'
FROM generate_series(1, 10000) value;

ANALYZE bounded_rows;
ANALYZE wystack_draft_row_changes;

\echo 'GENERIC FULL EFFECTIVE PLAN'
EXPLAIN (ANALYZE, BUFFERS)
SELECT
  COALESCE((d.row_key #>> '{value}')::INTEGER, b.id) AS id,
  CASE WHEN d.fields ? 'title'
    THEN CASE WHEN d.fields -> 'title' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::TEXT
      ELSE (d.fields -> 'title' -> 'value' #>> '{value}')::TEXT END
    ELSE b.title END AS title,
  CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END AS score
FROM bounded_rows b
FULL OUTER JOIN (
  SELECT * FROM wystack_draft_row_changes
  WHERE draft_id = 'target' AND table_key = 'bounded_rows' AND tenant_key_text = ''
) d ON b.id = (d.row_key #>> '{value}')::INTEGER
WHERE COALESCE(d.operation, 'update') <> 'delete'
  AND CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END >= 50000
ORDER BY
  CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END DESC,
  COALESCE((d.row_key #>> '{value}')::INTEGER, b.id)
LIMIT 20;

\echo 'BOUNDED SQL CANDIDATE PLAN'
EXPLAIN (ANALYZE, BUFFERS)
WITH draft_delta AS (
  SELECT * FROM wystack_draft_row_changes
  WHERE draft_id = 'target' AND table_key = 'bounded_rows' AND tenant_key_text = ''
),
base_top AS (
  SELECT c.*
  FROM bounded_rows c
  WHERE c.score >= 50000
  ORDER BY c.score DESC, c.id
  LIMIT (20 + (SELECT COUNT(*) FROM draft_delta))
),
candidate_base AS (
  SELECT bt.*
  FROM base_top bt
  WHERE NOT EXISTS (
    SELECT 1 FROM draft_delta dc
    WHERE bt.id = (dc.row_key #>> '{value}')::INTEGER
  )
  UNION ALL
  SELECT c.*
  FROM draft_delta dc
  JOIN bounded_rows c ON c.id = (dc.row_key #>> '{value}')::INTEGER
)
SELECT
  COALESCE((d.row_key #>> '{value}')::INTEGER, b.id) AS id,
  CASE WHEN d.fields ? 'title'
    THEN CASE WHEN d.fields -> 'title' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::TEXT
      ELSE (d.fields -> 'title' -> 'value' #>> '{value}')::TEXT END
    ELSE b.title END AS title,
  CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END AS score
FROM candidate_base b
FULL OUTER JOIN draft_delta d
  ON b.id = (d.row_key #>> '{value}')::INTEGER
WHERE COALESCE(d.operation, 'update') <> 'delete'
  AND CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END >= 50000
ORDER BY
  CASE WHEN d.fields ? 'score'
    THEN CASE WHEN d.fields -> 'score' -> 'value' ->> 'kind' = 'sql-null'
      THEN NULL::INTEGER
      ELSE (d.fields -> 'score' -> 'value' #>> '{value}')::INTEGER END
    ELSE b.score END DESC,
  COALESCE((d.row_key #>> '{value}')::INTEGER, b.id)
LIMIT 20;

ROLLBACK;
