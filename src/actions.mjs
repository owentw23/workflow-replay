import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { execute, json, requireThat, validateValue } from './workflow.mjs';

const name = /^[a-z][a-z0-9-]{0,47}$/;
const id = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const isRecord = value => value && typeof value === 'object' && !Array.isArray(value);
const digest = (proposal, principal) => createHash('sha256').update(json([principal, proposal])).digest('hex');

function withLedger(profile, operation) {
  mkdirSync(dirname(profile.actionDatabase), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(profile.actionDatabase);
  try {
    db.exec(`PRAGMA busy_timeout = 3000;
      CREATE TABLE IF NOT EXISTS actions (
        id TEXT PRIMARY KEY, digest TEXT NOT NULL, expires INTEGER NOT NULL, status TEXT NOT NULL
      )`);
    return operation(db);
  } finally {
    db.close();
  }
}

function validateFields(schema, values, label) {
  requireThat(isRecord(schema) && isRecord(values) && Object.keys(schema).length <= 16
    && Object.keys(values).length === Object.keys(schema).length, `Invalid ${label}`);
  for (const [field, type] of Object.entries(schema)) {
    requireThat(Object.hasOwn(values, field), `Missing ${label} field ${field}`);
    validateValue(values[field], type, field, 4096);
  }
}

export function matchAction(profile, request) {
  if (typeof request !== 'string' || request.length > 256) return;
  const matches = [];
  for (const [route, action] of profile.actions) {
    const inputs = action.match?.(request);
    if (inputs !== undefined) matches.push({ route, inputs });
  }
  if (matches.length === 1) return matches[0];
}

export async function prepareAction(profile, route, inputs, principal) {
  const action = profile.actions.get(route);
  const tool = profile.actionTools.get(action?.operation);
  requireThat(typeof route === 'string' && name.test(route) && tool && typeof tool.call === 'function'
    && !profile.registry.has(action.operation), 'Unknown action workflow');
  requireThat(typeof principal === 'string' && principal.length > 0 && principal.length <= 256, 'Principal is required');
  requireThat(isRecord(action.inputs) && Object.keys(action.inputs).length <= 16 && isRecord(inputs), 'Invalid action inputs');
  for (const [field, value] of Object.entries(inputs)) {
    requireThat(Object.hasOwn(action.inputs, field), `Unknown action input ${field}`);
    validateValue(value, action.inputs[field].type, field, 4096);
  }
  const missing = Object.fromEntries(Object.entries(action.inputs).filter(([field]) => !Object.hasOwn(inputs, field)));
  const needsInputs = Object.keys(missing).length > 0;
  const preparation = action.prepare;
  const canDraft = needsInputs && action.draftContext?.length && preparation
    && Object.keys(preparation.inputs).every(field => Object.hasOwn(inputs, field));
  if (needsInputs && !canDraft) return { status: 'needs_inputs', route, missing };
  const prepared = preparation ? await execute(preparation,
    Object.fromEntries(Object.keys(preparation.inputs).map(field => [field, inputs[field]])),
    profile.registry, profile.dispatch) : {};
  if (needsInputs) {
    const context = Object.fromEntries(action.draftContext.map(field => [field, prepared[field]]));
    requireThat(Buffer.byteLength(json(context)) <= 4096, 'Draft context exceeds 4 KB');
    return { status: 'needs_inputs', route, missing, context };
  }
  const args = Object.fromEntries(Object.entries(action.args).map(([field, ref]) => [field,
    Object.hasOwn(ref, 'input') ? inputs[ref.input] : prepared[ref.prepared],
  ]));
  validateFields(tool.args, args, 'action arguments');
  const proposal = { id: randomUUID(), route, operation: action.operation, args };
  requireThat(Buffer.byteLength(json(proposal)) <= 8192, 'Action preview exceeds 8 KB');
  withLedger(profile, db => {
    db.prepare("DELETE FROM actions WHERE status = 'pending' AND expires <= ?").run(Date.now());
    db.prepare("INSERT INTO actions VALUES (?, ?, ?, 'pending')")
      .run(proposal.id, digest(proposal, principal), Date.now() + 10 * 60_000);
  });
  return { status: 'needs_approval', proposal };
}

export async function commitAction(profile, proposal, { principal, approve }) {
  requireThat(isRecord(proposal) && typeof proposal.id === 'string' && id.test(proposal.id)
    && typeof principal === 'string' && principal.length > 0 && typeof approve === 'function',
  'A prepared proposal, principal and trusted approval callback are required');
  const body = json(proposal);
  requireThat(Buffer.byteLength(body) <= 8192, 'Action preview exceeds 8 KB');
  const approved = JSON.parse(body);
  const key = digest(approved, principal);
  const lookup = () => withLedger(profile, db => db.prepare('SELECT * FROM actions WHERE id = ? AND digest = ?')
    .get(approved.id, key));
  const existing = lookup();
  requireThat(existing && (existing.status !== 'pending' || existing.expires > Date.now()),
    'Unknown, changed or expired action proposal');
  if (existing.status !== 'pending') return { id: approved.id, status: existing.status };

  const tool = profile.actionTools.get(approved.operation);
  requireThat(profile.actions.get(approved.route)?.operation === approved.operation && tool
    && !profile.registry.has(approved.operation), 'Action workflow is no longer configured');
  validateFields(tool.args, approved.args, 'action arguments');
  const next = await approve(JSON.parse(body)) === true ? 'running' : 'declined';

  const claimed = withLedger(profile, db => db.prepare(
    "UPDATE actions SET status = ? WHERE id = ? AND digest = ? AND status = 'pending' AND expires > ?",
  ).run(next, approved.id, key, Date.now()).changes);
  if (!claimed) {
    const status = lookup()?.status;
    return { id: approved.id, status: !status || status === 'pending' ? 'expired' : status };
  }
  if (next === 'declined') return { id: approved.id, status: next };

  const finish = status => withLedger(profile, db => db.prepare('UPDATE actions SET status = ? WHERE id = ?')
    .run(status, approved.id));
  let result;
  try {
    const response = await tool.call(approved.args, { idempotencyKey: approved.id, signal: AbortSignal.timeout(15_000) });
    requireThat(isRecord(response), 'Action adapter did not return structured data');
    result = Object.fromEntries(Object.keys(tool.fields).map(field => [field,
      Object.hasOwn(response, field) ? response[field] : undefined,
    ]));
    validateFields(tool.fields, result, 'action result');
    requireThat(Buffer.byteLength(json(result)) <= 4096, 'Action result exceeds 4 KB');
  } catch {
    finish('unknown');
    return { id: approved.id, status: 'unknown' };
  }
  finish('completed');
  return { id: approved.id, status: 'completed', result };
}
