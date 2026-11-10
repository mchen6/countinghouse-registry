-- countinghouse-registry store, schema version 1 (spec section 13.3).
-- Names and versions compare with the default BINARY collation: UTF-8 byte order,
-- which is the list order the read API documents (spec section 4.1).

CREATE TABLE meta_kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);

-- The change sequence (spec section 9.4): one row, bumped inside write transactions.
CREATE TABLE seq (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  value INTEGER NOT NULL
);
INSERT INTO seq (id, value) VALUES (1, 0);

-- One row per served record (name, version), whatever its source.
CREATE TABLE records (
  id INTEGER PRIMARY KEY,
  source TEXT NOT NULL CHECK (source IN ('local', 'mirror')),
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  server TEXT NOT NULL,          -- the server.json object, as stored
  official TEXT NOT NULL,        -- _meta["io.modelcontextprotocol.registry/official"]
  origin TEXT NOT NULL CHECK (origin IN ('local', 'mirror', 'local+upstream')),
  changed_at TEXT NOT NULL,      -- local change time, filtered by updated_since
  mirrored_at TEXT,
  upstream_updated_at TEXT,      -- upstream's updatedAt of the last applied copy
  seen_pass INTEGER,             -- last reconciliation pass that saw it
  hidden_reason TEXT,            -- 'gone-upstream' when hidden by reconciliation
  UNIQUE (name, version)
);
CREATE INDEX records_changed_at ON records (changed_at);

-- Distinct names for substring search (trigram tokenizer: case-insensitive,
-- substrings of three or more characters, LIKE-accelerated).
CREATE VIRTUAL TABLE names_fts USING fts5 (name, tokenize = 'trigram');

CREATE TRIGGER records_name_in AFTER INSERT ON records
WHEN NOT EXISTS (SELECT 1 FROM records WHERE name = NEW.name AND id <> NEW.id)
BEGIN
  INSERT INTO names_fts (name) VALUES (NEW.name);
END;

CREATE TRIGGER records_name_out AFTER DELETE ON records
WHEN NOT EXISTS (SELECT 1 FROM records WHERE name = OLD.name)
BEGIN
  DELETE FROM names_fts WHERE name = OLD.name;
END;

CREATE TABLE mirror_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  cursor TEXT,
  checkpoint TEXT,
  run_started_at TEXT,
  first_sync_done INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL DEFAULT 'idle',
  last_success_at TEXT,
  last_error TEXT,
  upstream_version TEXT,
  last_pass_count INTEGER,
  pass_no INTEGER NOT NULL DEFAULT 0,
  last_reconcile_at TEXT
);
INSERT INTO mirror_state (id) VALUES (1);

CREATE TABLE conflicts (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  local_sha TEXT NOT NULL,
  upstream_sha TEXT NOT NULL,
  first_seen TEXT NOT NULL,
  ack_by TEXT,
  ack_at TEXT,
  PRIMARY KEY (name, version)
);

CREATE TABLE overrides (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  keep_deleted INTEGER NOT NULL,
  by_key TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

-- countinghouse module records (spec section 8).
CREATE TABLE ch_records (
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  body TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  record_version INTEGER NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);

-- Enable state per (instance, name, version) (spec section 9.3).
CREATE TABLE enables (
  instance TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('requested', 'validated', 'changed', 'failed', 'disabled')),
  remote_index INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  updated_at TEXT NOT NULL,
  by_key TEXT NOT NULL,
  PRIMARY KEY (instance, name, version)
);
CREATE INDEX enables_instance_seq ON enables (instance, seq);

-- Instance results, kept as history (spec section 9.4).
CREATE TABLE results (
  id INTEGER PRIMARY KEY,
  instance TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  outcome TEXT NOT NULL CHECK (outcome IN ('validated', 'changed', 'failed')),
  sha256 TEXT,
  previous_sha256 TEXT,
  reason TEXT,
  tools TEXT,
  at TEXT NOT NULL,
  seq INTEGER NOT NULL
);
CREATE INDEX results_entry ON results (instance, name, version, id);

-- Operator actions, by key fingerprint.
CREATE TABLE audit (
  id INTEGER PRIMARY KEY,
  at TEXT NOT NULL,
  key_fp TEXT NOT NULL,
  action TEXT NOT NULL,
  subject TEXT NOT NULL
);
