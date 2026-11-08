// Reads Claude Code permission settings and decides whether a tool may run without asking.
// Sources, highest precedence first: managed settings, extra files in WORKFLOW_REPLAY_CLAUDE_SETTINGS (for
// --settings files), project .claude/settings.local.json, project .claude/settings.json, user ~/.claude/settings.json.
// Rule order follows Claude Code: deny beats ask beats allow. MCP rules match the exact tool
// (mcp__server__tool), the whole server (mcp__server) or a server wildcard (mcp__server__*).
// Limits: permissions granted interactively for the current session, and command-line flags, are not visible to
// this check, so it can only be stricter than Claude Code itself, never looser.
import { existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const MANAGED = {
  win32: 'C:\\ProgramData\\ClaudeCode\\managed-settings.json',
  darwin: '/Library/Application Support/ClaudeCode/managed-settings.json',
  linux: '/etc/claude-code/managed-settings.json',
};

function readSettings(path) {
  try {
    if (!existsSync(path)) return null;
    const data = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
    return data && typeof data === 'object' ? { path, permissions: data.permissions ?? {} } : null;
  } catch {
    return { path, permissions: {}, unreadable: true };
  }
}

export function settingsSources({ projectDir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd(), home = homedir(), extra = process.env.WORKFLOW_REPLAY_CLAUDE_SETTINGS } = {}) {
  const paths = [
    MANAGED[platform()],
    ...(extra ? String(extra).split(/[;,]/).filter(Boolean) : []),
    join(projectDir, '.claude', 'settings.local.json'),
    join(projectDir, '.claude', 'settings.json'),
    join(home, '.claude', 'settings.json'),
  ].filter(Boolean);
  return paths.map(readSettings).filter(Boolean);
}

export function ruleMatches(rule, tool) {
  if (typeof rule !== 'string') return false;
  if (rule === tool) return true;
  const [, server] = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool) ?? [];
  if (server && (rule === `mcp__${server}` || rule === `mcp__${server}__*`)) return true;
  return false;
}

// Returns { decision: 'allow' | 'ask' | 'deny', source, rule }.
export function decide(tool, sources = settingsSources()) {
  for (const kind of ['deny', 'ask']) {
    for (const source of sources) {
      const rule = (source.permissions[kind] ?? []).find(item => ruleMatches(item, tool));
      if (rule) return { decision: kind, source: source.path, rule };
    }
  }
  for (const source of sources) {
    const rule = (source.permissions.allow ?? []).find(item => ruleMatches(item, tool));
    if (rule) return { decision: 'allow', source: source.path, rule };
  }
  const mode = sources.find(source => source.permissions.defaultMode)?.permissions.defaultMode;
  if (mode === 'bypassPermissions') return { decision: 'allow', source: 'defaultMode', rule: mode };
  return { decision: 'ask', source: null, rule: null };
}
