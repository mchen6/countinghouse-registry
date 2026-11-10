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

  it('migrates a new file to schema version 1 and is idempotent on reopen', async () => {
    assert.strictEqual(await store.schemaVersion(), 1);
    await store.close();
    store = await openStore(path.join(dir, 'r.db'));
    assert.strictEqual(await store.schemaVersion(), 1);
  });

  it('uses WAL mode', async () => {
    const [row] = await store.read('PRAGMA journal_mode');
    assert.strictEqual(row.journal_mode, 'wal');
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
      "SELECT DISTINCT r.name FROM names_fts f JOIN records r ON r.name = f.name WHERE f.name LIKE '%' || ? || '%' ESCAPE '\\'", ['ILE']);
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
});
