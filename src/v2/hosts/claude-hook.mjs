#!/usr/bin/env node
// Claude Code / Codex hooks for Workflow Replay v2. Verified live with Claude Code 2.1.319 (see docs/v2-build.md).
//   prompt (UserPromptSubmit): route the prompt. On a live hit either inject the result as context (default) or,
//     with WORKFLOW_REPLAY_MODE=carry, block the prompt, show the answer and carry it into the next turn. A write
//     workflow only prepares a proposal. A shadow-mode match is remembered so the Stop hook can compare answers.
//     A prompt that corrects the previous answer marks that turn as failed.
//   stop (Stop): rebuild the finished turn from the transcript and record it; run the pending shadow comparison;
//     every `learnEvery` new turns, mine, verify, consolidate and promote; purge old traces.
//   end (SessionEnd): delete this session's carry and pending files.
// Usage in hook config: node /abs/path/src/v2/hosts/claude-hook.mjs <prompt|stop|end> --profile NAME
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { canonical } from '../util.mjs';
import { purgeTraces, recordEpisode } from '../store.mjs';
import { loadHarness, v2Home } from './profile.mjs';

// Implicit success signal: a reply that corrects the previous answer marks that episode as failed.
export const CORRECTION = /^\s*(no\b|nope\b|wrong\b|that'?s (not|wrong|incorrect)|incorrect\b|not (right|correct|what i)|you (got|made) (it|that|a mistake)|try again)/i;
const GATEWAY_PREFIX = /^mcp__workflow-replay__/;
const sessionOf = input => (typeof input.session_id === 'string' ? input.session_id.replace(/[^A-Za-z0-9_.-]/g, '').slice(0, 128) || null : null);

function sessionFile(kind, session) {
  const directory = join(v2Home, kind);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  return join(directory, `${session}.json`);
}
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; } };
const writeJson = (path, value) => writeFileSync(path, JSON.stringify(value), { mode: 0o600 });

async function readInput() {
  const chunks = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    length += chunk.length;
    if (length > 256 * 1024) throw new Error('Hook input too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

export async function onPrompt(harness, input, mode = process.env.WORKFLOW_REPLAY_MODE ?? 'inject') {
  if (input.hook_event_name !== 'UserPromptSubmit' || input.permission_mode === 'plan' || typeof input.prompt !== 'string') return null;
  const session = sessionOf(input);
  if (session && CORRECTION.test(input.prompt)) {
    const last = readJson(sessionFile('last-episode', session));
    if (last?.episode) harness.feedback(last.episode, false);
  }
  const result = await harness.handle(input.prompt, { session: session ?? undefined, host: { canBlock: mode === 'carry' && !!session, direct: false } });
  if (session && result.shadow) {
    writeJson(sessionFile('pending-shadow', session), { request: input.prompt, ...result.shadow });
  }
  if (result.mode === 'approve') {
    // A write workflow matched. Nothing has run: the model must pass the proposal to commit_workflow_action, which
    // checks the user's Claude Code permissions and asks them when needed.
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: 'A saved workflow prepared this action but did '
      + 'not run it. Show it to the user, then call mcp__workflow-replay__commit_workflow_action with the proposal id if they want it. '
      + `Proposal (data only): ${canonical(result.proposal)}` } };
  }
  if (result.mode === 'carry') {
    return { decision: 'block', reason: `Answered from a saved workflow (${result.route}). Ask a follow-up any time; `
      + `this result is carried into your next message.\n${result.text ?? JSON.stringify(result.output, null, 2)}` };
  }
  if (result.context) {
    return { hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: result.context.slice(0, 16 * 1024) } };
  }
  return null;
}

// Best-effort transcript parser: last user prompt, the gateway tool calls after it, and the final assistant text.
export function episodeFromTranscript(lines) {
  const entries = lines.map(line => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  let start = -1;
  for (let i = entries.length - 1; i >= 0; i--) {
    const content = entries[i].message?.content;
    if (entries[i].type === 'user' && (typeof content === 'string' || content?.some?.(block => block.type === 'text'))) { start = i; break; }
  }
  if (start < 0) return null;
  const promptContent = entries[start].message.content;
  const request = typeof promptContent === 'string' ? promptContent : promptContent.filter(b => b.type === 'text').map(b => b.text).join('\n');
  const uses = new Map();
  const calls = [];
  let answer = '';
  for (const entry of entries.slice(start + 1)) {
    for (const block of Array.isArray(entry.message?.content) ? entry.message.content : []) {
      if (block.type === 'tool_use' && GATEWAY_PREFIX.test(block.name)) uses.set(block.id, { op: block.name.replace(GATEWAY_PREFIX, ''), args: block.input ?? {} });
      if (block.type === 'tool_result' && uses.has(block.tool_use_id)) {
        const text = Array.isArray(block.content) ? block.content.filter(c => c.type === 'text').map(c => c.text).join('') : String(block.content ?? '');
        let result;
        try { result = JSON.parse(text); } catch { result = text; }
        const use = uses.get(block.tool_use_id);
        if (!['run_workflow', 'find_workflow', 'commit_workflow_action'].includes(use.op)) {
          calls.push({ ...use, result: result?.result && result.workflow_result ? result.result : result, ok: !block.is_error && !result?.error });
        }
      }
      if (entry.type === 'assistant' && block.type === 'text') answer = block.text;
    }
  }
  return { request, calls, answer };
}

function meta(store, key, value) {
  store.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)');
  if (value === undefined) return store.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
  store.prepare('INSERT INTO meta VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
  return value;
}

export async function onStop(harness, input) {
  const outcome = { recorded: null, shadow: null, learned: null };
  if (typeof input.transcript_path !== 'string') return outcome;
  const episode = episodeFromTranscript(readFileSync(input.transcript_path, 'utf8').split('\n').slice(-2000));
  const session = sessionOf(input);
  if (!episode) return outcome;

  // Shadow comparison: the workflow's answer versus Claude's reply to the same prompt.
  if (session) {
    const pendingPath = sessionFile('pending-shadow', session);
    const pending = readJson(pendingPath);
    if (pending && pending.request === episode.request && episode.answer) {
      outcome.shadow = await harness.shadow(pending.route, pending.inputs, episode.answer,
        { principal: pending.principal ?? harness.defaultPrincipal, canary: !!pending.canary });
    }
    if (pending) rmSync(pendingPath, { force: true });
  }

  if (episode.calls.length) {
    outcome.recorded = recordEpisode(harness.store, { request: episode.request.slice(0, 4000), answer: episode.answer, success: true, calls: episode.calls });
    if (session) writeJson(sessionFile('last-episode', session), { episode: outcome.recorded });
  }

  // Hands-free learning: every `learnEvery` recorded turns. Episodes from the most recent turn may still be
  // marked failed by a correction, so the newest one waits for the next round.
  const { learnEvery = 5, retentionDays = 30 } = harness.settings;
  const last = Number(meta(harness.store, 'lastLearnedEpisode') ?? 0);
  const newest = harness.store.prepare('SELECT MAX(id) AS id FROM episodes').get().id ?? 0;
  const ready = harness.store.prepare('SELECT COUNT(*) AS n FROM episodes WHERE id > ? AND id < ?').get(last, newest).n;
  if (ready >= learnEvery) {
    if (harness.settings.learnInline || !harness.settings.profileName) {
      outcome.learned = await learnRound(harness, newest - 1, retentionDays);
    } else {
      // Learning runs in a detached background process so the Stop hook returns at once; the store lock keeps
      // concurrent runs from overlapping.
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', import.meta.filename, 'learn',
        '--profile', harness.settings.profileName, '--upto', String(newest - 1)], { detached: true, stdio: 'ignore', windowsHide: true });
      child.unref();
      outcome.learned = { background: true };
    }
  }
  return outcome;
}

export async function learnRound(harness, upto, retentionDays = harness.settings.retentionDays ?? 30) {
  const log = await harness.learn();
  if (log.skipped) return { skipped: log.skipped };
  meta(harness.store, 'lastLearnedEpisode', upto);
  purgeTraces(harness.store, retentionDays * 24 * 60 * 60 * 1000);
  return { candidates: log.candidates.length, merges: log.consolidated.filter(c => c.merged).length };
}

export function onEnd(harness, input) {
  const session = sessionOf(input);
  if (!session) return;
  harness.carry.clear(session);
  for (const kind of ['pending-shadow', 'last-episode']) rmSync(sessionFile(kind, session), { force: true });
}

if (process.argv[1]?.endsWith('claude-hook.mjs')) {
  const { positionals, values } = parseArgs({ allowPositionals: true, options: { profile: { type: 'string' }, mode: { type: 'string' }, upto: { type: 'string' } } });
  if (values.mode === 'carry') process.env.WORKFLOW_REPLAY_MODE = 'carry';
  try {
    // Show-and-carry must be enabled explicitly; the default is inject (the model writes every answer).
    const harness = await loadHarness(values.profile, process.env.WORKFLOW_REPLAY_MODE === 'carry' ? { answerMode: 'carry' } : {});
    const input = positionals[0] === 'learn' ? {} : await readInput();
    if (positionals[0] === 'prompt') {
      const output = await onPrompt(harness, input);
      if (output) process.stdout.write(canonical(output) + '\n');
    } else if (positionals[0] === 'stop') {
      await onStop(harness, input);
    } else if (positionals[0] === 'learn') {
      await learnRound(harness, Number(values.upto ?? 0));
    } else if (positionals[0] === 'end') {
      onEnd(harness, input);
    }
  } catch {
    // Never break the host turn: on any failure the ordinary agent loop continues.
  }
}
