// Logical content digest of a database: the schema, the header versions and every row of every user table in rowid
// order, with exact type-tagged values. Equal digests mean equal content regardless of page layout, so a backup is
// verified against its source without comparing file bytes.
import {createHash} from 'node:crypto';
import type Database from 'better-sqlite3';

export interface ContentDigest {rowCounts: Record<string, number>; logicalDigest: string; applicationId: number; userVersion: number}

function encode(value: unknown): string {
  if (value === null) return 'n';
  if (typeof value === 'bigint') return `i${value}`;
  if (typeof value === 'number') { const bytes = Buffer.alloc(8); bytes.writeDoubleBE(value); return `r${bytes.toString('hex')}`; }
  if (typeof value === 'string') return `t${Buffer.byteLength(value)}:${value}`;
  if (Buffer.isBuffer(value)) return `b${value.length}:${value.toString('hex')}`;
  throw new TypeError('Unsupported SQLite value');
}

export function contentDigest(db: Database.Database): ContentDigest {
  const hash = createHash('sha256'), rowCounts: Record<string, number> = {};
  const pragma = (name: string) => Number(db.prepare(`PRAGMA ${name}`).pluck().safeIntegers(true).get());
  const applicationId = pragma('application_id'), userVersion = pragma('user_version');
  hash.update(`H\x1f${applicationId}\x1f${userVersion}\x1e`);
  for (const row of db.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY type, name").raw(true).iterate() as Iterable<unknown[]>) {
    hash.update(`S\x1f${row.map(encode).join('\x1f')}\x1e`);
  }
  const tables = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY name").pluck().all() as string[];
  for (const table of tables) {
    let count = 0;
    hash.update(`T\x1f${table}\x1e`);
    for (const row of db.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).raw(true).safeIntegers(true).iterate() as Iterable<unknown[]>) {
      hash.update(`${row.map(encode).join('\x1f')}\x1e`); count++;
    }
    rowCounts[table] = count;
  }
  return {rowCounts, logicalDigest: hash.digest('hex'), applicationId, userVersion};
}
