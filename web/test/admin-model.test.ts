import { beforeEach, describe, expect, test } from 'bun:test';
import { connect } from '@tursodatabase/database';
import { applyMigrations } from '../db/migrate';
import { createClock } from '../lib/hlc';
import type { Ctx } from '../lib/client/repo';
import { AdminError, addCustomField, deleteStatus, removeCustomField, saveStatus, statusCode, validateStatus } from '../lib/client/admin-model';
import { statusMaster } from '../lib/client/bug-model';
import type { Db, Row } from '../lib/db-types';

let db: Db, ctx: Ctx;
const master = async () => statusMaster((await db.all('SELECT * FROM bug_status_master')) as Row[]);

beforeEach(async () => {
  db = (await connect(':memory:')) as unknown as Db;
  await applyMigrations(db, 'local');
  ctx = { db, clock: createClock('d1'), email: 'root@bugrail.test', role: 'admin' };
});

describe('statusCode', () => {
  test('upper-cases, collapses punctuation, suffixes on a clash, falls back for a symbol-only name', () => {
    expect(statusCode('Ready for QA!', [])).toBe('READY_FOR_QA');
    expect(statusCode('Open', ['OPEN'])).toBe('OPEN_2');
    expect(statusCode('Open', ['OPEN', 'OPEN_2'])).toBe('OPEN_3');
    expect(statusCode('***', [])).toBe('STATUS');
  });
});

describe('validateStatus', () => {
  test('requires a name and a #RRGGBB colour; a name used by another status is refused', () => {
    expect(validateStatus({ name: ' ', color: 'red', order: 1 }, [])).toEqual({ name: 'Nama Status wajib diisi.', color: 'Warna Label harus format hex, contoh #2563EB.' });
    expect(validateStatus({ name: 'Open', color: '#2563EB', order: 1 }, [{ code: 'OPEN', name: 'Open', color: null, order: 1 }]).name).toBe('Nama status sudah dipakai.');
    expect(validateStatus({ name: 'New', color: '#2563eb', order: 1 }, [])).toEqual({});
  });
});

describe('master status', () => {
  test('the first edit turns the defaults into rows, then adds the new status after them', async () => {
    const code = await saveStatus(ctx, { name: 'Ready for QA', color: '#123456', order: 7 });
    expect(code).toBe('READY_FOR_QA');
    const m = await master();
    expect(m.map((s) => s.code)).toEqual(['OPEN', 'IN_PROGRESS', 'RETEST', 'RESOLVED', 'CLOSED', 'REJECTED', 'READY_FOR_QA']);
    expect(m.at(-1)).toMatchObject({ name: 'Ready for QA', color: '#123456', order: 7 });
  });
  test('rename keeps the code (bugs store codes, so nothing else changes); a duplicate name throws with field errors', async () => {
    await saveStatus(ctx, { name: 'Ship it', color: '#111111', order: 8 });
    await saveStatus(ctx, { name: 'Shipped', color: '#222222', order: 8 }, 'SHIP_IT');
    expect((await master()).find((s) => s.code === 'SHIP_IT')?.name).toBe('Shipped');
    const err = await saveStatus(ctx, { name: 'Closed', color: '#222222', order: 1 }, 'SHIP_IT').catch((e) => e);
    expect(err).toBeInstanceOf(AdminError);
    expect(err.fields.name).toBe('Nama status sudah dipakai.');
  });
  test('a status that a bug still uses cannot be deleted; an unused one can', async () => {
    await saveStatus(ctx, { name: 'Spare', color: '#333333', order: 9 });
    await db.run("INSERT INTO bugs (id, status_code) VALUES ('b1', 'SPARE')");
    expect(await deleteStatus(ctx, 'SPARE').catch((e) => e)).toBeInstanceOf(AdminError);
    await db.run("UPDATE bugs SET status_code = 'OPEN' WHERE id = 'b1'");
    await deleteStatus(ctx, 'SPARE');
    expect((await master()).some((s) => s.code === 'SPARE')).toBe(false);
  });
  test('deleting from a fresh install seeds the defaults first, so the others survive', async () => {
    await deleteStatus(ctx, 'REJECTED');
    expect((await master()).map((s) => s.code)).toEqual(['OPEN', 'IN_PROGRESS', 'RETEST', 'RESOLVED', 'CLOSED']);
  });
});

describe('custom fields', () => {
  test('add, refuse an empty or duplicate label, remove', async () => {
    await addCustomField(ctx, ' Region ');
    expect(await addCustomField(ctx, 'Region').catch((e) => e)).toBeInstanceOf(AdminError);
    expect(await addCustomField(ctx, '  ').catch((e) => e)).toBeInstanceOf(AdminError);
    const [d] = (await db.all('SELECT * FROM custom_field_defs WHERE deleted_at IS NULL')) as Row[];
    expect(d.label).toBe('Region');
    await removeCustomField(ctx, String(d.id));
    expect(await db.all('SELECT * FROM custom_field_defs WHERE deleted_at IS NULL')).toHaveLength(0);
    await addCustomField(ctx, 'Region'); // a removed label can come back
  });
});
