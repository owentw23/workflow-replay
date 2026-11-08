#!/usr/bin/env node
// Phase 0: measure how much of your past Claude Code traffic the harness could replay, before deploying it.
//   node src/v2/hosts/analyze.mjs [--dir ~/.claude/projects] [--project TEXT] [--min 3] [--show-prompts] [--json]
// Reads transcripts locally and prints aggregates only (tool names, counts, tokens). Prompt text is shown only with
// --show-prompts, truncated. Nothing is sent anywhere.
//
// A turn is "replayable" when every tool call in it only reads (MCP tools classified read, or built-in read tools)
// and it fetches external data (at least one MCP or web call), and at least `min` turns share its call shape
// (same tool sequence, consecutive repeats collapsed). The token figure is the turn's real usage from the
// transcript; the savings ceiling applies the repeat-task saving measured in the v2 benchmark.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { classifyMcpTool } from './wrap.mjs';

const READ_BUILTINS = new Set(['Read', 'Grep', 'Glob', 'WebFetch', 'WebSearch', 'ToolSearch', 'LS', 'NotebookRead', 'TodoRead']);
const WEB = new Set(['WebFetch', 'WebSearch']);
const BENCH_REPEAT_SAVING = 0.68; // paired saving on repeat tasks, docs/v2-results.md (v2.1)

export function toolKind(name, input) {
  if (name.startsWith('mcp__')) {
    const tool = name.split('__').slice(2).join('__');
    return { external: true, read: classifyMcpTool({ name: tool, annotations: {} }).effect === 'read' };
  }
  if (WEB.has(name)) return { external: true, read: true };
  return { external: false, read: READ_BUILTINS.has(name) };
}

export function turnsFromTranscript(text) {
  const turns = [];
  const seenMessages = new Set();
  let current = null;
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const content = entry.message?.content;
    const isPrompt = entry.type === 'user' && (typeof content === 'string'
      || (Array.isArray(content) && content.some(block => block.type === 'text') && !content.some(block => block.type === 'tool_result')));
    if (isPrompt && !entry.isMeta) {
      const prompt = typeof content === 'string' ? content : content.filter(b => b.type === 'text').map(b => b.text).join('\n');
      if (/^<(command|local-command|system-reminder)/.test(prompt.trim())) continue;
      current = { prompt, calls: [], tokens: { input: 0, cacheRead: 0, cacheWrite: 0, output: 0 } };
      turns.push(current);
      continue;
    }
    if (!current || entry.type !== 'assistant') continue;
    const id = entry.message?.id;
    if (id && !seenMessages.has(id) && entry.message.usage) {
      seenMessages.add(id);
      const usage = entry.message.usage;
      current.tokens.input += usage.input_tokens ?? 0;
      current.tokens.cacheRead += usage.cache_read_input_tokens ?? 0;
      current.tokens.cacheWrite += usage.cache_creation_input_tokens ?? 0;
      current.tokens.output += usage.output_tokens ?? 0;
    }
    for (const block of Array.isArray(content) ? content : []) {
      if (block.type === 'tool_use') current.calls.push({ name: block.name, input: block.input ?? {} });
    }
  }
  return turns;
}

export function shapeOf(calls) {
  const names = [];
  for (const call of calls) {
    const label = call.name;
    if (names.at(-1) === label || names.at(-1) === `${label}[*]`) names[names.length - 1] = `${label}[*]`;
    else names.push(label);
  }
  return names.join(' → ');
}

const total = tokens => tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output;

export function analyze(turns, { min = 3 } = {}) {
  const withTools = turns.filter(turn => turn.calls.length);
  const candidates = withTools.filter(turn => {
    const kinds = turn.calls.map(call => toolKind(call.name, call.input));
    return kinds.every(kind => kind.read) && kinds.some(kind => kind.external);
  });
  const clusters = new Map();
  for (const turn of candidates) {
    const shape = shapeOf(turn.calls);
    if (!clusters.has(shape)) clusters.set(shape, []);
    clusters.get(shape).push(turn);
  }
  const repeated = [...clusters].filter(([, members]) => members.length >= min);
  const replayable = repeated.flatMap(([, members]) => members);
  const sum = list => list.reduce((acc, turn) => acc + total(turn.tokens), 0);
  const allTokens = sum(turns);
  const replayTokens = sum(replayable);
  return {
    turns: turns.length, turnsWithTools: withTools.length, readOnlyExternalTurns: candidates.length,
    replayableTurns: replayable.length, replayableShare: turns.length ? replayable.length / turns.length : 0,
    tokens: allTokens, replayableTokens: replayTokens, replayableTokenShare: allTokens ? replayTokens / allTokens : 0,
    estimatedSavingCeiling: allTokens ? (replayTokens * BENCH_REPEAT_SAVING) / allTokens : 0,
    clusters: repeated.sort((a, b) => b[1].length - a[1].length).slice(0, 15).map(([shape, members]) => ({
      shape, turns: members.length, meanTokens: Math.round(sum(members) / members.length), examples: members.slice(0, 3).map(turn => turn.prompt),
    })),
    breakEvenShare: 0.35,
  };
}

function transcriptFiles(directory, project) {
  if (!existsSync(directory)) return [];
  const files = [];
  for (const entry of readdirSync(directory)) {
    const path = join(directory, entry);
    if (statSync(path).isDirectory()) {
      if (project && !entry.toLowerCase().includes(project.toLowerCase())) continue;
      for (const file of readdirSync(path)) if (file.endsWith('.jsonl')) files.push(join(path, file));
    } else if (entry.endsWith('.jsonl') && (!project || entry.includes(project))) files.push(path);
  }
  return files;
}

if (process.argv[1]?.endsWith('analyze.mjs')) {
  const { values } = parseArgs({ options: {
    dir: { type: 'string', default: join(homedir(), '.claude', 'projects') }, project: { type: 'string' },
    min: { type: 'string', default: '3' }, 'show-prompts': { type: 'boolean' }, json: { type: 'boolean' } } });
  const files = transcriptFiles(values.dir, values.project);
  const turns = files.flatMap(file => { try { return turnsFromTranscript(readFileSync(file, 'utf8')); } catch { return []; } });
  const report = analyze(turns, { min: Number(values.min) });
  if (!values['show-prompts']) for (const cluster of report.clusters) delete cluster.examples;
  else for (const cluster of report.clusters) cluster.examples = cluster.examples.map(text => text.replace(/\s+/g, ' ').slice(0, 80));
  if (values.json) {
    console.log(JSON.stringify({ files: files.length, ...report }, null, 2));
  } else {
    const pct = value => `${(value * 100).toFixed(1)}%`;
    console.log(`Transcripts: ${files.length}   turns: ${report.turns}   turns using tools: ${report.turnsWithTools}`);
    console.log(`Read-only turns that fetch external data: ${report.readOnlyExternalTurns}`);
    console.log(`Replayable (repeated shape, ≥${values.min} turns): ${report.replayableTurns} turns = ${pct(report.replayableShare)} of turns, ${pct(report.replayableTokenShare)} of tokens`);
    console.log(`Estimated saving ceiling: ${pct(report.estimatedSavingCeiling)} of all tokens (break-even needs about 35% repeats among routed requests)`);
    if (report.clusters.length) console.log('\nTop repeated shapes:');
    for (const cluster of report.clusters) {
      console.log(`  ${String(cluster.turns).padStart(4)} turns  ~${cluster.meanTokens} tokens/turn  ${cluster.shape}`);
      for (const example of cluster.examples ?? []) console.log(`        e.g. ${example}`);
    }
  }
}
