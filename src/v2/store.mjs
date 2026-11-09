// One SQLite file per profile: the trace store (sensitive, retention-limited) and the route catalog.
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { canonical, requireThat } from './util.mjs';

export const STATES = ['candidate', 'verified', 'shadow', 'live', 'retired'];

export function openStore(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  // WAL lets hooks, the MCP server and background learning read and write the same file concurrently.
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');
  db.exec(`
    PRAGMA busy_timeout = 5000;
    CREATE TABLE IF NOT EXISTS episodes (
      id INTEGER PRIMARY KEY, request TEXT NOT NULL, answer TEXT, success INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'default', created INTEGER NOT NULL, mined INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS calls (
      episode INTEGER NOT NULL REFERENCES episodes(id), seq INTEGER NOT NULL, op TEXT NOT NULL,
      args TEXT NOT NULL, result TEXT, ok INTEGER NOT NULL, PRIMARY KEY (episode, seq)
    );
    CREATE TABLE IF NOT EXISTS routes (
      id TEXT PRIMARY KEY, state TEXT NOT NULL, version INTEGER NOT NULL, scope TEXT NOT NULL,
      description TEXT NOT NULL, plan TEXT NOT NULL, examples TEXT NOT NULL, vocab TEXT NOT NULL,
      attention TEXT NOT NULL, episodes TEXT NOT NULL, stats TEXT NOT NULL, category TEXT,
      merged_into TEXT, updated INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS route_history (
      id TEXT NOT NULL, version INTEGER NOT NULL, state TEXT NOT NULL, plan TEXT NOT NULL,
      note TEXT, at INTEGER NOT NULL, seq INTEGER PRIMARY KEY AUTOINCREMENT
    );
  `);
  try { db.exec('ALTER TABLE episodes ADD COLUMN principal TEXT'); } catch { /* already present */ }
  return db;
}

export function recordEpisode(db, { request, answer, success, calls, scope = 'default', principal = null }) {
  requireThat(typeof request === 'string' && request.length <= 4096, 'Invalid request');
  db.exec('BEGIN IMMEDIATE');
  try {
    const { lastInsertRowid: id } = db.prepare(
      'INSERT INTO episodes (request, answer, success, scope, created, principal) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(request, answer === undefined ? null : canonical(answer), success ? 1 : 0, scope, Date.now(), principal);
    const insert = db.prepare('INSERT INTO calls VALUES (?, ?, ?, ?, ?, ?)');
    calls.forEach((call, seq) => insert.run(id, seq, call.op, canonical(call.args),
      call.result === undefined ? null : canonical(call.result), call.ok ? 1 : 0));
    db.exec('COMMIT');
    return Number(id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export function loadEpisodes(db, { scope = 'default', ids, onlyUnmined = false } = {}) {
  const rows = ids
    ? ids.map(id => db.prepare('SELECT * FROM episodes WHERE id = ?').get(id)).filter(Boolean)
    : db.prepare(`SELECT * FROM episodes WHERE scope = ? AND success = 1 ${onlyUnmined ? 'AND mined = 0' : ''} ORDER BY id`).all(scope);
  const calls = db.prepare('SELECT * FROM calls WHERE episode = ? ORDER BY seq');
  return rows.map(row => ({
    id: row.id, request: row.request, success: !!row.success, principal: row.principal ?? null,
    answer: row.answer === null ? null : JSON.parse(row.answer),
    calls: calls.all(row.id).map(call => ({ op: call.op, args: JSON.parse(call.args),
      result: call.result === null ? null : JSON.parse(call.result), ok: !!call.ok })),
  }));
}

export function markMined(db, ids) {
  const update = db.prepare('UPDATE episodes SET mined = 1 WHERE id = ?');
  for (const id of ids) update.run(id);
}

export function purgeTraces(db, olderThanMs) {
  const cutoff = Date.now() - olderThanMs;
  db.prepare('DELETE FROM calls WHERE episode IN (SELECT id FROM episodes WHERE created < ?)').run(cutoff);
  db.prepare('DELETE FROM episodes WHERE created < ?').run(cutoff);
}

const parseRoute = row => row && ({
  ...row, plan: JSON.parse(row.plan), examples: JSON.parse(row.examples), vocab: JSON.parse(row.vocab),
  attention: JSON.parse(row.attention), episodes: JSON.parse(row.episodes), stats: JSON.parse(row.stats),
});

export function saveRoute(db, route, note) {
  requireThat(STATES.includes(route.state), 'Invalid route state');
  const now = Date.now();
  const row = [route.id, route.state, route.version, route.scope ?? 'default', route.description,
    canonical(route.plan), JSON.stringify(route.examples), JSON.stringify(route.vocab),
    JSON.stringify(route.attention), JSON.stringify(route.episodes), JSON.stringify(route.stats),
    route.category ?? null, route.merged_into ?? null, now];
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare(`INSERT INTO routes VALUES (${row.map(() => '?').join(', ')})
      ON CONFLICT(id) DO UPDATE SET state=excluded.state, version=excluded.version, description=excluded.description,
      plan=excluded.plan, examples=excluded.examples, vocab=excluded.vocab, attention=excluded.attention,
      episodes=excluded.episodes, stats=excluded.stats, category=excluded.category,
      merged_into=excluded.merged_into, updated=excluded.updated`).run(...row);
    db.prepare('INSERT INTO route_history (id, version, state, plan, note, at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(route.id, route.version, route.state, canonical(route.plan), note ?? null, now);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return route;
}

export const getRoute = (db, id) => parseRoute(db.prepare('SELECT * FROM routes WHERE id = ?').get(id));

export function listRoutes(db, { states, scope = 'default' } = {}) {
  return db.prepare('SELECT * FROM routes WHERE scope = ? ORDER BY id').all(scope).map(parseRoute)
    .filter(route => !states || states.includes(route.state));
}

export function routeHistory(db, id) {
  return db.prepare('SELECT * FROM route_history WHERE id = ? ORDER BY seq').all(id)
    .map(row => ({ ...row, plan: JSON.parse(row.plan) }));
}
