#!/usr/bin/env node
import { existsSync, mkdirSync, realpathSync, renameSync, statSync, writeFileSync, rmSync, copyFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dataHome, profileName, readJsonFile } from './src/profiles.mjs';
import { requireThat } from './src/workflow.mjs';

const source = dirname(fileURLToPath(import.meta.url));
const runtime = join(dataHome, 'runtime', 'src');
const script = join(runtime, 'prompt-hook.mjs');
const sh = value => "'" + value.replaceAll("'", "'\"'\"'") + "'";
const ps = value => "'" + value.replaceAll("'", "''") + "'";

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = path + '.' + randomUUID() + '.tmp';
  try {
    writeFileSync(temporary, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function objectOrEmpty(path) {
  const data = existsSync(path) ? readJsonFile(path) : {};
  requireThat(data && typeof data === 'object' && !Array.isArray(data), 'Expected a JSON object in ' + path);
  return data;
}

function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { project: { type: 'string' }, profile: { type: 'string' }, remove: { type: 'boolean' } },
  });
  const [host] = positionals;
  requireThat(positionals.length === 1 && ['codex', 'claude'].includes(host),
    'Usage: workflow-replay-install codex|claude --project PATH --profile NAME (or --remove)');
  const path = host === 'codex'
    ? join(resolve(process.env.CODEX_HOME || join(homedir(), '.codex')), 'hooks.json')
    : join(homedir(), '.claude', 'settings.json');
  const config = objectOrEmpty(path);
  requireThat(config.hooks === undefined || (config.hooks && typeof config.hooks === 'object' && !Array.isArray(config.hooks)),
    'Existing hook config must be an object');
  const entries = config.hooks?.UserPromptSubmit ?? [];
  requireThat(Array.isArray(entries) && entries.every(entry => entry && Array.isArray(entry.hooks)),
    'Existing UserPromptSubmit hooks must be an array of groups');
  const owned = hook => hook?.args?.includes?.(script)
    || (typeof hook?.command === 'string' && hook.command.includes(sh(script)))
    || (typeof hook?.commandWindows === 'string' && hook.commandWindows.includes(ps(script)));
  const filtered = entries.map(entry => ({ ...entry, hooks: entry.hooks.filter(hook => !owned(hook)) }))
    .filter(entry => entry.hooks.length);
  if (values.remove) {
    if (!entries.some(entry => entry.hooks.some(owned))) return;
  } else {
    requireThat(values.project && values.profile && profileName.test(values.profile), 'Provide a project directory and profile name');
    const directory = realpathSync(values.project);
    requireThat(statSync(directory).isDirectory(), 'Expected a project directory');
    requireThat(existsSync(join(dataHome, 'profiles', values.profile + '.mjs')), 'Create the trusted service profile first');
    const bindingsPath = join(dataHome, 'host-bindings.json');
    const bindings = objectOrEmpty(bindingsPath).bindings ?? [];
    requireThat(Array.isArray(bindings) && bindings.length <= 128, 'Invalid existing project bindings');
    const next = bindings.filter(entry => entry.directory !== directory);
    requireThat(next.length < 128, 'Too many project bindings');
    next.push({ directory, profile: values.profile });
    mkdirSync(runtime, { recursive: true, mode: 0o700 });
    for (const file of ['prompt-hook', 'profiles', 'integration', 'host-routing', 'local-routing', 'workflow', 'playbook']) {
      copyFileSync(join(source, 'src', file + '.mjs'), join(runtime, file + '.mjs'));
    }
    writeJson(bindingsPath, { bindings: next });
    const flags = ['--disable-warning=ExperimentalWarning', script, '--hook'];
    const hook = host === 'claude'
      ? { type: 'command', command: process.execPath, args: flags, timeout: 7 }
      : { type: 'command', command: [process.execPath, ...flags].map(sh).join(' '),
        commandWindows: '& ' + [process.execPath, ...flags].map(ps).join(' '), timeout: 7 };
    filtered.push({ hooks: [hook] });
  }
  if (existsSync(path)) copyFileSync(path, path + '.workflow-replay-' + randomUUID() + '.bak');
  config.hooks ??= {};
  if (filtered.length) config.hooks.UserPromptSubmit = filtered;
  else delete config.hooks.UserPromptSubmit;
  writeJson(path, config);
  console.log(values.remove ? 'Removed the workflow replay hook.'
    : host === 'codex' ? 'Installed. Review and trust the command in Codex /hooks.'
      : 'Installed the Claude Code prompt hook. Start a new session to verify it.');
}

try { main(); } catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
