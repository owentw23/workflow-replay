// Installer: merges into existing Claude Code and Codex configs without touching other entries, is idempotent,
// backs up every file it changes, supports dry runs, and removes only what it added.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { install, stripTomlBlock } from '../src/v2/hosts/install.mjs';

function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'wr-install-'));
  const claudeDir = join(root, '.claude');
  const codexHome = join(root, '.codex');
  mkdirSync(claudeDir);
  mkdirSync(codexHome);
  const guard = { type: 'command', command: 'python guard.py' };
  writeFileSync(join(claudeDir, 'settings.json'), JSON.stringify({ model: 'opus', permissions: { allow: ['Read'] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [guard] }], UserPromptSubmit: [{ hooks: [{ type: 'command', command: 'echo hi' }] }] } }));
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ projects: { x: 1 }, mcpServers: { other: { command: 'other' } } }));
  writeFileSync(join(codexHome, 'config.toml'), 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other"\n');
  const options = { profile: 'demo', claudeDir, claudeJson: join(root, '.claude.json'), codexHome, useCli: false, skipProfileCheck: true };
  return { root, claudeDir, codexHome, options, guard };
}

const json = path => JSON.parse(readFileSync(path, 'utf8'));

test('installs into Claude Code and Codex, keeps other config, and is idempotent', () => {
  const { root, claudeDir, codexHome, options, guard } = sandbox();
  try {
    const plan = install(options);
    assert.deepEqual(plan.hosts, ['Claude Code', 'Codex']);
    const settings = json(join(claudeDir, 'settings.json'));
    assert.equal(settings.model, 'opus');
    assert.deepEqual(settings.permissions, { allow: ['Read'] });
    assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0], guard, 'existing guard hook untouched');
    assert.equal(settings.hooks.UserPromptSubmit.length, 2, 'existing prompt hook kept, ours added');
    assert.match(settings.hooks.Stop[0].hooks[0].command, /claude-hook\.mjs.* stop --profile demo/);
    assert.match(settings.hooks.SessionEnd[0].hooks[0].command, /end --profile demo/);
    const claudeJson = json(join(root, '.claude.json'));
    assert.deepEqual(claudeJson.projects, { x: 1 });
    assert.ok(claudeJson.mcpServers.other && claudeJson.mcpServers['workflow-replay'].args.includes('demo'));
    const codexHooks = json(join(codexHome, 'hooks.json'));
    assert.ok(codexHooks.hooks.UserPromptSubmit[0].hooks[0].commandWindows.startsWith('& '));
    const toml = readFileSync(join(codexHome, 'config.toml'), 'utf8');
    assert.match(toml, /model = "gpt"/);
    assert.match(toml, /\[mcp_servers\.other\]/);
    assert.match(toml, /\[mcp_servers\.workflow-replay\]\ncommand = ".+"\nargs = \[.*"demo"\]/);
    assert.ok(plan.backups.length >= 3, 'every existing file was backed up');

    install({ ...options, mode: 'carry' });
    const again = json(join(claudeDir, 'settings.json'));
    assert.equal(again.hooks.UserPromptSubmit.length, 2, 'reinstall replaces our hook instead of adding another');
    assert.match(again.hooks.UserPromptSubmit[1].hooks[0].command, /--mode carry/);
    assert.equal((readFileSync(join(codexHome, 'config.toml'), 'utf8').match(/mcp_servers\.workflow-replay/g) ?? []).length, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('dry run writes nothing; removal takes out only what was added', () => {
  const { root, claudeDir, codexHome, options, guard } = sandbox();
  try {
    const before = readFileSync(join(claudeDir, 'settings.json'), 'utf8');
    const dry = install({ ...options, dryRun: true });
    assert.ok(dry.writes.length > 0);
    assert.equal(readFileSync(join(claudeDir, 'settings.json'), 'utf8'), before);
    assert.ok(!existsSync(join(codexHome, 'hooks.json')));
    assert.equal(readdirSync(claudeDir).filter(name => name.endsWith('.bak')).length, 0);

    install(options);
    install({ ...options, remove: true });
    const settings = json(join(claudeDir, 'settings.json'));
    assert.deepEqual(settings.hooks.PreToolUse[0].hooks[0], guard);
    assert.equal(settings.hooks.UserPromptSubmit.length, 1);
    assert.equal(settings.hooks.UserPromptSubmit[0].hooks[0].command, 'echo hi');
    assert.equal(settings.hooks.Stop, undefined);
    assert.equal(json(join(root, '.claude.json')).mcpServers['workflow-replay'], undefined);
    assert.ok(json(join(root, '.claude.json')).mcpServers.other);
    assert.equal(json(join(codexHome, 'hooks.json')).hooks, undefined);
    assert.equal(readFileSync(join(codexHome, 'config.toml'), 'utf8'), 'model = "gpt"\n\n[mcp_servers.other]\ncommand = "other"\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('project scope writes .claude/settings.json and .mcp.json in the project; missing profile is refused', () => {
  const { root, options } = sandbox();
  try {
    const project = join(root, 'proj');
    mkdirSync(project);
    install({ ...options, target: 'claude', scope: 'project', project });
    assert.ok(json(join(project, '.claude', 'settings.json')).hooks.UserPromptSubmit);
    assert.ok(json(join(project, '.mcp.json')).mcpServers['workflow-replay']);
    assert.throws(() => install({ ...options, skipProfileCheck: false, profile: 'missing-profile' }), /No profile/);
    assert.equal(stripTomlBlock('a = 1\n'), 'a = 1\n');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
