'use strict';
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const {openStore} = require('../lib/store');

describe('store', () => {
  let dir;
  let store;
  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'chr-store-'));
    store = await openStore(path.join(dir, 'r.db'));
  });
  afterEach(async () => {
    if (store) await store.close();
    fs.rmSync(dir, {recursive: true, force: true});
  });

  const rec = (name, version) => ({
    sql: `INSERT INTO records (source, name, version, server, official, origin, changed_at)
          VALUES ('mirror', ?, ?, '{}', '{}', 'mirror', '2026-11-10T00:00:00.000Z')`,
    params: [name, version]
  });

  it('migrates a new file to the latest schema version and is idempotent on reopen', async () => {
    assert.strictEqual(await store.schemaVersion(), 2);
    await store.close();
    store = await openStore(path.join(dir, 'r.db'));
    assert.strictEqual(await store.schemaVersion(), 2);
  });

  it('uses WAL mode', async () => {
    const [row] = await store.read('PRAGMA journal_mode');
    assert.strictEqual(row.journal_mode, 'wal');
  });

  it('the read connection cannot write', async () => {
    await assert.rejects(store.read("INSERT INTO meta_kv (k, v) VALUES ('x', 'y')"), /SQLITE_READONLY/);
    assert.deepStrictEqual(await store.read("SELECT v FROM meta_kv WHERE k = 'x'"), []);
  });

  it('write commits and read sees it', async () => {
    await store.write(async (tx) => { const r = rec('a/x', '1'); await tx.run(r.sql, r.params); });
    const rows = await store.read('SELECT name FROM records');
    assert.deepStrictEqual(rows.map((r) => r.name), ['a/x']);
  });

  it('write rolls back on throw', async () => {
    await assert.rejects(store.write(async (tx) => {
      const r = rec('a/x', '1');
      await tx.run(r.sql, r.params);
      throw new Error('boom');
    }), /boom/);
    assert.deepStrictEqual(await store.read('SELECT name FROM records'), []);
  });

  it('writes are serialised', async () => {
    await store.write((tx) => tx.run("INSERT INTO meta_kv (k, v) VALUES ('n', '0')"));
    const bump = () => store.write(async (tx) => {
      const {v} = await tx.get("SELECT v FROM meta_kv WHERE k = 'n'");
      await new Promise((r) => setTimeout(r, 20));
      await tx.run("UPDATE meta_kv SET v = ? WHERE k = 'n'", [String(Number(v) + 1)]);
    });
    await Promise.all([bump(), bump()]);
    const [row] = await store.read("SELECT v FROM meta_kv WHERE k = 'n'");
    assert.strictEqual(row.v, '2');
  });

  it('nextSeq is monotonic across transactions and rolled back with its transaction', async () => {
    const a = await store.write((tx) => tx.nextSeq());
    await assert.rejects(store.write(async (tx) => { await tx.nextSeq(); throw new Error('x'); }));
    const b = await store.write((tx) => tx.nextSeq());
    const c = await store.write((tx) => tx.nextSeq());
    assert.strictEqual(b, a + 1);
    assert.strictEqual(c, b + 1);
  });

  it('sorts names bytewise', async () => {
    await store.write(async (tx) => {
      for (const n of ['b/x', 'B/x', 'a/x', 'é/x']) { const r = rec(n, '1'); await tx.run(r.sql, r.params); }
    });
    const rows = await store.read('SELECT name FROM records ORDER BY name');
    assert.deepStrictEqual(rows.map((r) => r.name), ['B/x', 'a/x', 'b/x', 'é/x']);
  });

  it('names_fts finds a case-insensitive substring of three characters', async () => {
    await store.write(async (tx) => {
      for (const n of ['io.x/filesystem', 'io.x/other']) { const r = rec(n, '1'); await tx.run(r.sql, r.params); }
    });
    const rows = await store.read(
      "SELECT n.name FROM names n WHERE n.id IN (SELECT rowid FROM names_fts WHERE name LIKE '%' || ? || '%' ESCAPE '\\')", ['ILE']);
    assert.deepStrictEqual(rows.map((r) => r.name), ['io.x/filesystem']);
  });

  it('a name appears once in names_fts however many versions it has, and leaves it with its last version', async () => {
    await store.write(async (tx) => {
      for (const v of ['1', '2']) { const r = rec('io.x/abc', v); await tx.run(r.sql, r.params); }
    });
    let [row] = await store.read('SELECT count(*) AS n FROM names_fts');
    assert.strictEqual(row.n, 1);
    await store.write((tx) => tx.run("DELETE FROM records WHERE name = 'io.x/abc' AND version = '1'"));
    [row] = await store.read('SELECT count(*) AS n FROM names_fts');
    assert.strictEqual(row.n, 1);
    await store.write((tx) => tx.run("DELETE FROM records WHERE name = 'io.x/abc'"));
    [row] = await store.read('SELECT count(*) AS n FROM names_fts');
    assert.strictEqual(row.n, 0);
  });

  it('refuses a second record for the same name and version', async () => {
    await store.write(async (tx) => { const r = rec('a/x', '1'); await tx.run(r.sql, r.params); });
    await assert.rejects(store.write(async (tx) => { const r = rec('a/x', '1'); await tx.run(r.sql, r.params); }), /UNIQUE/);
  });
  it('refuses a file whose schema is newer than this code knows', async () => {
    await store.write((tx) => tx.run("UPDATE meta_kv SET v = '99' WHERE k = 'schema_version'"));
    await store.close();
    store = null;
    await assert.rejects(openStore(path.join(dir, 'r.db')), /schema version 99 is newer than this release \(2\)/);
  });

  it('two stores opening a new file at once migrate it once', async () => {
    // Forty pairs: the race (the WAL switch answering SQLITE_BUSY without the
    // busy timeout) showed up in about 4% of single pairs.
    for (let i = 0; i < 40; i++) {
      const f = path.join(dir, `race-${i}.db`);
      const [a, b] = await Promise.all([openStore(f), openStore(f)]);
      assert.strictEqual(await a.schemaVersion(), 2);
      assert.strictEqual(await b.schemaVersion(), 2);
      await a.close();
      await b.close();
    }
  }).timeout(20000);

  it('closes its connections when opening fails', async () => {
    await store.write((tx) => tx.run("UPDATE meta_kv SET v = '99' WHERE k = 'schema_version'"));
    await store.close();
    store = null;
    const fds = () => fs.readdirSync('/proc/self/fd').length;
    await assert.rejects(openStore(path.join(dir, 'r.db')));
    const before = fds();
    for (let i = 0; i < 5; i++) await assert.rejects(openStore(path.join(dir, 'r.db')));
    assert.strictEqual(fds(), before, 'file descriptors leaked by failed opens');
  });

  it('keeps names_fts right when a record is renamed', async () => {
    await store.write(async (tx) => { const r = rec('io.x/abc', '1'); await tx.run(r.sql, r.params); });
    await store.write((tx) => tx.run("UPDATE records SET name = 'io.x/xyz' WHERE name = 'io.x/abc'"));
    const rows = await store.read("SELECT n.name FROM names n WHERE n.id IN (SELECT rowid FROM names_fts WHERE name LIKE '%xyz%')");
    assert.deepStrictEqual(rows.map((r) => r.name), ['io.x/xyz']);
    const old = await store.read("SELECT count(*) AS n FROM names_fts WHERE name LIKE '%abc%'");
    assert.strictEqual(old[0].n, 0);
  });

  it('an upsert of an existing record leaves one names_fts entry', async () => {
    const up = `INSERT INTO records (source, name, version, server, official, origin, changed_at)
      VALUES ('mirror', 'io.x/abc', '1', '{}', '{}', 'mirror', ?)
      ON CONFLICT (name, version) DO UPDATE SET changed_at = excluded.changed_at`;
    await store.write((tx) => tx.run(up, ['2026-11-10T00:00:00.000Z']));
    await store.write((tx) => tx.run(up, ['2026-11-11T00:00:00.000Z']));
    const [row] = await store.read('SELECT count(*) AS n FROM names_fts');
    assert.strictEqual(row.n, 1);
  });
});

