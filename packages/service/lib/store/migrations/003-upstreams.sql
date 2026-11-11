-- Schema version 3: several upstreams (spec section 6.8). Every upstream's copy of
-- a name@version is kept in record_sources; records holds the served projection.
-- Mirror state moves from the single mirror_state row and the mirror_* keys of
-- meta_kv to one mirror_upstreams row per configured upstream. What schema 2
-- mirrored moves to the upstream named "official" with schema 2's default url, so
-- a different configured url is noticed at startup (and resynced) rather than
-- silently adopted; the service reconciles these rows with the list at startup.

CREATE TABLE mirror_upstreams (
  name TEXT PRIMARY KEY,
  position INTEGER NOT NULL,
  url TEXT,
  cursor TEXT,
  checkpoint TEXT,
  run_started_at TEXT,
  run_mode TEXT,
  pages_done INTEGER NOT NULL DEFAULT 0,
  first_sync_done INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',
  last_success_at TEXT,
  success_started TEXT,
  last_error TEXT,
  upstream_version TEXT,
  last_pass_count INTEGER,
  pass_no INTEGER NOT NULL DEFAULT 0,
  last_reconcile_at TEXT,
  reconcile_retry_at TEXT,
  reconcile_guard TEXT
);

INSERT INTO mirror_upstreams (name, position, url, cursor, checkpoint, run_started_at, run_mode, pages_done, first_sync_done,
  state, last_success_at, success_started, last_error, upstream_version, last_pass_count, pass_no, last_reconcile_at,
  reconcile_retry_at, reconcile_guard)
SELECT 'official', 0, 'https://registry.modelcontextprotocol.io', cursor, checkpoint, run_started_at,
  (SELECT v FROM meta_kv WHERE k = 'mirror_run_mode'),
  COALESCE((SELECT v = '1' FROM meta_kv WHERE k = 'mirror_pages_done'), 0),
  first_sync_done, state, last_success_at,
  (SELECT v FROM meta_kv WHERE k = 'mirror_success_started'),
  last_error, upstream_version, last_pass_count, pass_no, last_reconcile_at,
  (SELECT v FROM meta_kv WHERE k = 'mirror_reconcile_retry_at'),
  (SELECT v FROM meta_kv WHERE k = 'mirror_reconcile_guard')
FROM mirror_state WHERE id = 1;

DROP TABLE mirror_state;
DELETE FROM meta_kv WHERE k LIKE 'mirror_%';

CREATE TABLE record_sources (
  upstream TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  server TEXT NOT NULL,
  official TEXT NOT NULL,
  upstream_updated_at TEXT,
  mirrored_at TEXT NOT NULL,
  seen_pass INTEGER,
  hidden_reason TEXT,
  PRIMARY KEY (upstream, name, version)
);
CREATE INDEX record_sources_name ON record_sources (name, version);

INSERT INTO record_sources (upstream, name, version, server, official, upstream_updated_at, mirrored_at, seen_pass, hidden_reason)
SELECT 'official', name, version, server, official, upstream_updated_at, COALESCE(mirrored_at, changed_at), seen_pass, hidden_reason
FROM records WHERE source = 'mirror';

-- The upstream whose copy a mirrored record serves (operator-only, 6.8).
ALTER TABLE records ADD COLUMN upstream TEXT;
UPDATE records SET upstream = 'official' WHERE source = 'mirror' AND hidden_reason IS NULL;

CREATE TABLE reconcile_stage_3 (
  upstream TEXT NOT NULL,
  pass_no INTEGER NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  server TEXT NOT NULL,
  official TEXT NOT NULL,
  PRIMARY KEY (upstream, pass_no, name, version)
);
INSERT INTO reconcile_stage_3 SELECT 'official', pass_no, name, version, server, official FROM reconcile_stage;
DROP TABLE reconcile_stage;
ALTER TABLE reconcile_stage_3 RENAME TO reconcile_stage;

INSERT INTO meta_kv (k, v) VALUES ('upstream_order', '["official"]');
