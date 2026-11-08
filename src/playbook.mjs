import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { fingerprint, json, requireThat } from './workflow.mjs';

export function openPlaybook(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout = 3000;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS graphs (
      digest TEXT PRIMARY KEY, category TEXT NOT NULL, body TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS plans (
      digest TEXT PRIMARY KEY, graph_digest TEXT NOT NULL REFERENCES graphs(digest),
      projection TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS routes (
      route TEXT PRIMARY KEY, description TEXT NOT NULL,
      digest TEXT NOT NULL REFERENCES plans(digest)
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS search USING fts5(route, description);
    CREATE VIRTUAL TABLE IF NOT EXISTS request_examples USING fts5(route, description, tokenize='porter unicode61');
  `);
  return db;
}

export function validateRoute(route, description) {
  requireThat(typeof route === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(route), 'Invalid route id');
  requireThat(typeof description === 'string' && /^[\p{L}\p{N} .,-]{3,120}$/u.test(description)
    && description.trim() === description, 'Use a short, plain description');
}

export function publish(db, route, description, workflow) {
  validateRoute(route, description);
  const digest = fingerprint(workflow);
  const { output, ...graph } = workflow;
  const graphDigest = fingerprint(graph);
  const category = [...new Set(workflow.steps.map(step => step.op.replace(/\.v\d+$/, '')))]
    .sort().join(' + ');
  db.exec('BEGIN IMMEDIATE');
  try {
    const previous = db.prepare('SELECT digest, description FROM routes WHERE route = ?').get(route);
    if (previous) {
      requireThat(previous.digest === digest && previous.description === description,
        'Route is already published. Choose a new route for a changed workflow');
    } else {
      db.prepare('INSERT INTO graphs VALUES (?, ?, ?) ON CONFLICT(digest) DO NOTHING')
        .run(graphDigest, category, json(graph));
      db.prepare('INSERT INTO plans VALUES (?, ?, ?) ON CONFLICT(digest) DO NOTHING')
        .run(digest, graphDigest, json(output));
      db.prepare('INSERT INTO routes VALUES (?, ?, ?)').run(route, description, digest);
      db.prepare('INSERT INTO search VALUES (?, ?)').run(route, description);
    }
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  return { route, digest, category };
}

export function indexRouteExamples(db, route, examples) {
  requireThat(Array.isArray(examples) && examples.length >= 1 && examples.length <= 16
    && examples.every(text => typeof text === 'string' && text.trim().length > 0 && text.length <= 256),
  'Provide 1–16 example requests of at most 256 characters');
  db.exec('BEGIN IMMEDIATE');
  try {
    const entry = db.prepare('SELECT description FROM routes WHERE route = ?').get(route);
    requireThat(entry, 'Unknown workflow route');
    db.prepare('DELETE FROM request_examples WHERE route = ?').run(route);
    db.prepare('INSERT INTO request_examples VALUES (?, ?)')
      .run(route, [entry.description, ...examples].join('\n'));
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function termsFor(goal) {
  requireThat(typeof goal === 'string' && goal.length <= 256, 'Goal is limited to 256 characters');
  return [...new Set(goal.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];
}

function searchIndex(db, index, terms) {
  if (!terms.length) return [];
  const query = terms.map(term => `"${term}"`).join(' OR ');
  return db.prepare(`
    SELECT r.route, r.description, g.category, json_extract(g.body, '$.inputs') AS inputs,
      p.projection AS outputs
    FROM ${index} JOIN routes r ON ${index}.route = r.route JOIN plans p USING (digest)
    JOIN graphs g ON p.graph_digest = g.digest
    WHERE ${index} MATCH ?
    ORDER BY bm25(${index}), r.route LIMIT 3
  `).all(query).map(row => ({
    ...row, inputs: JSON.parse(row.inputs), outputs: Object.keys(JSON.parse(row.outputs)),
  }));
}

export function lookup(db, goal) {
  return searchIndex(db, 'search', termsFor(goal).slice(0, 16));
}

const COMMON = new Set('a an and are as at be can could do for from get give had has how i in is it me my of on or please show tell that the their them this to use was what were with would you your'.split(' '));

export function lookupWithExamples(db, goal, expanded = goal) {
  const terms = [...new Set([...termsFor(expanded), ...termsFor(goal)])]
    .filter(term => !COMMON.has(term) && !/^\d+$/.test(term)).slice(0, 24);
  const enriched = searchIndex(db, 'request_examples', terms);
  if (enriched.length === 3) return enriched;
  const seen = new Set(enriched.map(item => item.route));
  return [...enriched, ...lookup(db, goal).filter(item => !seen.has(item.route))].slice(0, 3);
}

export function load(db, route) {
  const row = db.prepare(`
    SELECT p.digest, g.body, p.projection FROM routes JOIN plans p USING (digest)
    JOIN graphs g ON p.graph_digest = g.digest WHERE route = ?
  `).get(route);
  requireThat(row, 'Unknown workflow route');
  const workflow = { ...JSON.parse(row.body), output: JSON.parse(row.projection) };
  requireThat(fingerprint(workflow) === row.digest, 'Stored workflow hash mismatch');
  return workflow;
}

export function renderPlaybook(db) {
  const rows = db.prepare(`
    SELECT g.category, p.graph_digest, p.digest, route, description FROM routes
    JOIN plans p USING (digest) JOIN graphs g ON p.graph_digest = g.digest
    ORDER BY g.category, p.graph_digest, p.digest, route
  `).all();
  const lines = ['# Workflow playbook', ''];
  let category;
  let graphDigest;
  let digest;
  for (const row of rows) {
    if (category !== row.category) {
      category = row.category;
      lines.push(`## ${category}`, '');
    }
    if (graphDigest !== row.graph_digest) {
      graphDigest = row.graph_digest;
      lines.push('', `### Graph ${graphDigest.slice(0, 12)}`, '');
    }
    if (digest !== row.digest) {
      digest = row.digest;
      lines.push('', `#### Plan \`${digest}\``, '');
    }
    lines.push(`- \`${row.route}\` · ${row.description}`);
  }
  return lines.join('\n');
}
