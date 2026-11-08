#!/usr/bin/env node
// One command to add Workflow Replay to Claude Code and Codex, with backups and clean removal.
//
//   node src/v2/hosts/install.mjs --profile NAME            install into every host found (Claude Code, Codex)
//   node src/v2/hosts/install.mjs --profile NAME --target claude --scope project --project .
//   node src/v2/hosts/install.mjs --remove                   remove everything this installer added
//   add --dry-run to print the changes without writing anything
//
// What it writes (each file is backed up first, as <file>.workflow-replay-<time>.bak):
//   Claude Code: hooks (UserPromptSubmit, Stop, SessionEnd) in settings.json, and the workflow-replay MCP server
//                (via `claude mcp add` when the CLI is available, otherwise ~/.claude.json or the project .mcp.json).
//   Codex:       hooks (UserPromptSubmit, Stop) in hooks.json, and an [mcp_servers.workflow-replay] block in config.toml.
// Profiles, playbooks and recorded traces are never touched; removal keeps them for reuse.
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';
import { requireThat } from '../util.mjs';
import { v2Home } from './profile.mjs';

const SERVER = 'workflow-replay';
const HOOK_SCRIPT = resolve(import.meta.dirname, 'claude-hook.mjs');
const GATEWAY_SCRIPT = resolve(import.meta.dirname, 'mcp-gateway.mjs');
const TOML_BEGIN = '# >>> workflow-replay (managed by the workflow-replay installer; do not edit inside this block)';
const TOML_END = '# <<< workflow-replay';
const owned = command => typeof command === 'string' && command.includes('claude-hook.mjs') && command.includes('--profile');

const quoteSh = value => `'${String(value).replaceAll("'", "'\"'\"'")}'`;
const quotePs = value => `'${String(value).replaceAll("'", "''")}'`;
const quoteCmd = value => (/[\s"]/.test(value) ? `"${String(value).replaceAll('"', '\\"')}"` : value);

function readJson(path) {
  if (!existsSync(path)) return {};
  const data = JSON.parse(readFileSync(path, 'utf8').replace(/^﻿/, ''));
  requireThat(data && typeof data === 'object' && !Array.isArray(data), `Expected a JSON object in ${path}`);
  return data;
}

function backup(path, plan) {
  if (!existsSync(path)) return null;
  const target = `${path}.workflow-replay-${new Date().toISOString().replace(/[:.]/g, '-')}.bak`;
  if (!plan.dryRun) copyFileSync(path, target);
  plan.backups.push(target);
  return target;
}

function writeAtomic(path, text, plan) {
  plan.writes.push(path);
  if (plan.dryRun) return;
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, text, { flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function hookCommand(event, profile, mode) {
  const parts = [process.execPath, '--disable-warning=ExperimentalWarning', HOOK_SCRIPT, event, '--profile', profile,
    ...(mode === 'carry' && event === 'prompt' ? ['--mode', 'carry'] : [])];
  return { command: parts.map(quoteCmd).join(' '), sh: parts.map(quoteSh).join(' '), ps: `& ${parts.map(quotePs).join(' ')}` };
}

// Merge our hooks into a host's hook map: drop any previous copy of ours, keep everyone else's.
function mergeHooks(hooks = {}, wanted) {
  const next = {};
  for (const [event, groups] of Object.entries(hooks)) {
    requireThat(Array.isArray(groups), `Hook event ${event} must be an array`);
    const kept = groups.map(group => ({ ...group, hooks: (group.hooks ?? []).filter(hook => !owned(hook.command) && !owned(hook.commandWindows)) }))
      .filter(group => group.hooks.length);
    if (kept.length) next[event] = kept;
  }
  for (const [event, hook] of Object.entries(wanted)) next[event] = [...(next[event] ?? []), { hooks: [hook] }];
  return next;
}

// ---------- Claude Code ----------
function claudeInstall(options, plan) {
  const settingsPath = options.scope === 'project' ? join(options.project, '.claude', 'settings.json') : join(options.claudeDir, 'settings.json');
  const settings = readJson(settingsPath);
  const wanted = options.remove ? {} : Object.fromEntries([['UserPromptSubmit', 'prompt'], ['Stop', 'stop'], ['SessionEnd', 'end']]
    .map(([event, name]) => [event, { type: 'command', command: hookCommand(name, options.profile, options.mode).command, timeout: 30 }]));
  const hooks = mergeHooks(settings.hooks, wanted);
  backup(settingsPath, plan);
  if (Object.keys(hooks).length) settings.hooks = hooks; else delete settings.hooks;
  writeAtomic(settingsPath, JSON.stringify(settings, null, 2) + '\n', plan);

  const server = { command: process.execPath, args: ['--disable-warning=ExperimentalWarning', GATEWAY_SCRIPT, '--profile', options.profile] };
  if (options.scope === 'project') {
    const mcpPath = join(options.project, '.mcp.json');
    const config = readJson(mcpPath);
    config.mcpServers ??= {};
    if (options.remove) delete config.mcpServers[SERVER]; else config.mcpServers[SERVER] = { type: 'stdio', ...server };
    backup(mcpPath, plan);
    writeAtomic(mcpPath, JSON.stringify(config, null, 2) + '\n', plan);
    return;
  }
  const cli = options.useCli ? spawnSync('claude', ['--version'], { encoding: 'utf8', shell: process.platform === 'win32' }) : null;
  if (cli?.status === 0) {
    const args = options.remove ? ['mcp', 'remove', '--scope', 'user', SERVER]
      : ['mcp', 'add', '--scope', 'user', SERVER, '--', server.command, ...server.args];
    plan.commands.push(`claude ${args.join(' ')}`);
    if (!plan.dryRun) {
      if (!options.remove) spawnSync('claude', ['mcp', 'remove', '--scope', 'user', SERVER], { encoding: 'utf8', shell: process.platform === 'win32' });
      const run = spawnSync('claude', args.map(arg => (process.platform === 'win32' ? quoteCmd(arg) : arg)), { encoding: 'utf8', shell: process.platform === 'win32' });
      requireThat(run.status === 0 || options.remove, `claude mcp failed: ${(run.stderr || run.stdout || '').trim().slice(0, 300)}`);
    }
    return;
  }
  const claudeJson = options.claudeJson;
  const config = readJson(claudeJson);
  config.mcpServers ??= {};
  if (options.remove) delete config.mcpServers[SERVER]; else config.mcpServers[SERVER] = { type: 'stdio', ...server };
  backup(claudeJson, plan);
  writeAtomic(claudeJson, JSON.stringify(config, null, 2) + '\n', plan);
}

// ---------- Codex ----------
function tomlString(value) {
  return JSON.stringify(String(value));
}

export function stripTomlBlock(text) {
  const start = text.indexOf(TOML_BEGIN);
  if (start < 0) return text;
  const end = text.indexOf(TOML_END, start);
  requireThat(end > start, 'Found the start of the workflow-replay block in config.toml but not its end');
  const before = text.slice(0, start).replace(/\n+$/, '');
  const after = text.slice(end + TOML_END.length).replace(/^\n+/, '');
  const joined = [before, after].filter(Boolean).join('\n\n');
  return joined ? `${joined.replace(/\n+$/, '')}\n` : '';
}

function codexInstall(options, plan) {
  const hooksPath = join(options.codexHome, 'hooks.json');
  const config = readJson(hooksPath);
  const wanted = options.remove ? {} : Object.fromEntries([['UserPromptSubmit', 'prompt'], ['Stop', 'stop']].map(([event, name]) => {
    const command = hookCommand(name, options.profile, options.mode);
    return [event, { type: 'command', command: command.sh, commandWindows: command.ps, timeout: 30 }];
  }));
  const hooks = mergeHooks(config.hooks, wanted);
  backup(hooksPath, plan);
  if (Object.keys(hooks).length) config.hooks = hooks; else delete config.hooks;
  writeAtomic(hooksPath, JSON.stringify(config, null, 2) + '\n', plan);

  const tomlPath = join(options.codexHome, 'config.toml');
  const before = existsSync(tomlPath) ? readFileSync(tomlPath, 'utf8') : '';
  let text = stripTomlBlock(before);
  if (!options.remove) {
    requireThat(!/^\s*\[mcp_servers\.workflow-replay\]/m.test(text), 'config.toml already has an unmanaged [mcp_servers.workflow-replay] section');
    text = `${text.replace(/\n*$/, text ? '\n\n' : '')}${TOML_BEGIN}\n[mcp_servers.${SERVER}]\ncommand = ${tomlString(process.execPath)}\n`
      + `args = [${['--disable-warning=ExperimentalWarning', GATEWAY_SCRIPT, '--profile', options.profile].map(tomlString).join(', ')}]\n${TOML_END}\n`;
  }
  if (text !== before) {
    backup(tomlPath, plan);
    writeAtomic(tomlPath, text, plan);
  }
}

export function install(raw) {
  const options = {
    target: raw.target ?? 'all', profile: raw.profile, mode: raw.mode ?? 'inject', scope: raw.scope ?? 'user',
    project: resolve(raw.project ?? process.cwd()), remove: !!raw.remove,
    claudeDir: resolve(raw.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude')),
    claudeJson: resolve(raw.claudeJson ?? join(homedir(), '.claude.json')),
    codexHome: resolve(raw.codexHome ?? process.env.CODEX_HOME ?? join(homedir(), '.codex')),
    useCli: raw.useCli !== false,
  };
  requireThat(['all', 'claude', 'codex'].includes(options.target), 'target must be all, claude or codex');
  requireThat(['inject', 'carry'].includes(options.mode), 'mode must be inject or carry');
  requireThat(['user', 'project'].includes(options.scope), 'scope must be user or project');
  if (!options.remove) {
    requireThat(typeof options.profile === 'string' && /^[a-z][a-z0-9-]{0,47}$/.test(options.profile), 'Give --profile NAME');
    requireThat(raw.skipProfileCheck || existsSync(join(v2Home, 'profiles', `${options.profile}.mjs`)),
      `No profile ${options.profile} in ${join(v2Home, 'profiles')}. Create one first, e.g. node src/v2/hosts/wrap.mjs mcp ${options.profile} -- <server command>`);
  }
  const plan = { dryRun: !!raw.dryRun, writes: [], backups: [], commands: [], hosts: [] };
  const wantClaude = options.target !== 'codex' && (options.target === 'claude' || existsSync(options.claudeDir) || options.scope === 'project');
  const wantCodex = options.target !== 'claude' && (options.target === 'codex' || existsSync(options.codexHome));
  if (wantClaude) { claudeInstall(options, plan); plan.hosts.push('Claude Code'); }
  if (wantCodex) { codexInstall(options, plan); plan.hosts.push('Codex'); }
  requireThat(plan.hosts.length, 'Found neither Claude Code nor Codex; pass --target claude or --target codex');
  return plan;
}

if (process.argv[1]?.endsWith('install.mjs') && process.argv[1].includes('hosts')) {
  const { values } = parseArgs({ options: {
    profile: { type: 'string' }, target: { type: 'string' }, mode: { type: 'string' }, scope: { type: 'string' },
    project: { type: 'string' }, remove: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, 'no-cli': { type: 'boolean' },
    'claude-dir': { type: 'string' }, 'claude-json': { type: 'string' }, 'codex-home': { type: 'string' } } });
  try {
    const plan = install({ profile: values.profile, target: values.target, mode: values.mode, scope: values.scope, project: values.project,
      remove: values.remove, dryRun: values['dry-run'], useCli: !values['no-cli'], claudeDir: values['claude-dir'],
      claudeJson: values['claude-json'], codexHome: values['codex-home'] });
    const verb = values.remove ? 'Removed from' : 'Installed into';
    console.log(`${plan.dryRun ? '[dry run] ' : ''}${verb}: ${plan.hosts.join(', ')}`);
    for (const path of plan.writes) console.log(`  wrote   ${path}`);
    for (const path of plan.backups) console.log(`  backup  ${path}`);
    for (const command of plan.commands) console.log(`  ran     ${command}`);
    if (!values.remove) {
      console.log('Start a new Claude Code session to load the hooks. In Codex, review and trust the hooks in /hooks.');
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
