import { readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { requireThat } from './workflow.mjs';

export const profileName = /^[a-z][a-z0-9-]{0,47}$/;
export const dataHome = process.env.WORKFLOW_REPLAY_HOME
  ? resolve(process.env.WORKFLOW_REPLAY_HOME) : join(homedir(), '.workflow-replay');
export const readJsonFile = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

export function listProfiles() {
  const entries = readdirSync(join(dataHome, 'profiles'), { withFileTypes: true, throwIfNoEntry: false }) ?? [];
  return entries.filter(entry => entry.isFile() && entry.name.endsWith('.mjs')
    && profileName.test(entry.name.slice(0, -4))).map(entry => entry.name.slice(0, -4)).sort();
}

export async function loadProfile(name, root = dataHome) {
  requireThat(typeof name === 'string' && profileName.test(name), 'Invalid profile name');
  const { registry, dispatch, contracts = new Map(), expand, actions = new Map(), actionTools = new Map() } = await import(
    pathToFileURL(join(root, 'profiles', name + '.mjs')).href
  );
  requireThat(registry instanceof Map && typeof dispatch === 'function' && contracts instanceof Map
    && (expand === undefined || typeof expand === 'function') && actions instanceof Map && actionTools instanceof Map
    && [...actionTools.keys()].every(operation => !registry.has(operation)), 'Invalid trusted profile exports');
  return { registry, dispatch, contracts, expand, actions, actionTools,
    database: join(root, 'playbooks', name + '.sqlite'), actionDatabase: join(root, 'actions', name + '.sqlite') };
}
