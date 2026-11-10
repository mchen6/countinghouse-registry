'use strict';
// The registry's only state: one SQLite file in WAL mode (spec section 13.3).
//
// Two connections. Writes go through `write(fn)`: an in-process mutex serialises
// them and each runs inside BEGIN IMMEDIATE ... COMMIT, so SQLite's single-writer
// order is also the order of the change sequence (`tx.nextSeq()`, spec 9.4).
// Reads go through `read(sql)`, one statement each on the second connection, so
// every read sees one committed snapshot and never sees a write half-done.
const fs = require('fs');
const path = require('path');
const sqlite3 = require('sqlite3');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function open(file, mode) {
  return new Promise((resolve, reject) => {
    const db = new sqlite3.Database(file, mode, (err) => (err ? reject(err) : resolve(db)));
  });
}

function wrap(db) {
  return {
    run: (sql, params = []) => new Promise((resolve, reject) => {
      db.run(sql, params, function onRun(err) {
        if (err) reject(err);
        else resolve({changes: this.changes, lastID: this.lastID});
      });
    }),
    get: (sql, params = []) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => (err ? reject(err) : resolve(row)))),
    all: (sql, params = []) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => (err ? reject(err) : resolve(rows)))),
    exec: (sql) => new Promise((resolve, reject) => db.exec(sql, (err) => (err ? reject(err) : resolve()))),
    close: () => new Promise((resolve, reject) => db.close((err) => (err ? reject(err) : resolve())))
  };
}

function migrations() {
  return fs.readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{3}-.+\.sql$/.test(f))
    .sort()
    .map((f) => ({version: Number(f.slice(0, 3)), sql: fs.readFileSync(path.join(MIGRATIONS_DIR, f), 'utf8')}));
}

// Switching a new file to WAL needs every other connection out of the way, and
// SQLite answers SQLITE_BUSY at once there instead of applying busy_timeout (seen
// when two processes open a new file together). So the switch is retried, up to
// the same five seconds.
async function enableWal(db) {
  const deadline = Date.now() + 5000;
  for (;;) {
    try {
      await db.exec('PRAGMA journal_mode = WAL;');
      return;
    } catch (err) {
      if (err.code !== 'SQLITE_BUSY' || Date.now() > deadline) throw err;
      await new Promise((resolve) => setTimeout(resolve, 10 + Math.floor(Math.random() * 20)));
    }
  }
}

const LATEST = migrations().reduce((max, m) => Math.max(max, m.version), 0);

async function openStore(file) {
  const opened = [];
  try {
    const w = wrap(await open(file, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE));
    opened.push(w);
    await w.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    await enableWal(w);
    const r = wrap(await open(file, sqlite3.OPEN_READWRITE));
    opened.push(r);
    await r.exec('PRAGMA busy_timeout = 5000;');

    let tail = Promise.resolve();
    const write = (fn) => {
      const result = tail.then(async () => {
        await w.exec('BEGIN IMMEDIATE');
        try {
          const tx = {
            run: w.run, get: w.get, all: w.all, exec: w.exec,
            nextSeq: async () => (await w.get('UPDATE seq SET value = value + 1 WHERE id = 1 RETURNING value')).value
          };
          const out = await fn(tx);
          await w.exec('COMMIT');
          return out;
        } catch (err) {
          await w.exec('ROLLBACK').catch(() => {});
          throw err;
        }
      });
      tail = result.catch(() => {});
      return result;
    };

    const versionIn = async (db) => {
      const exists = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'meta_kv'");
      if (!exists) return 0;
      const row = await db.get("SELECT v FROM meta_kv WHERE k = 'schema_version'");
      return row ? Number(row.v) : 0;
    };

    // The version is read inside the write transaction, so two processes opening
    // a new file at once migrate it once (the second sees the first's commit).
    await write(async (tx) => {
      const current = await versionIn(tx);
      if (current > LATEST) {
        throw new Error(`store ${file}: schema version ${current} is newer than this release (${LATEST}); refusing to start`);
      }
      for (const m of migrations()) {
        if (m.version <= current) continue;
        await tx.exec(m.sql);
        await tx.run("INSERT INTO meta_kv (k, v) VALUES ('schema_version', ?) ON CONFLICT (k) DO UPDATE SET v = excluded.v", [String(m.version)]);
      }
    });

    return {
      read: (sql, params) => r.all(sql, params),
      write,
      schemaVersion: () => versionIn(r),
      close: async () => { await tail; await r.close(); await w.close(); }
    };
  } catch (err) {
    for (const db of opened.reverse()) await db.close().catch(() => {});
    throw err;
  }
}

module.exports = {openStore};
