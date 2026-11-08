// Downloads the pinned τ²-bench databases and checks their SHA-256. Data only: nothing here is executed.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { SOURCES } from './tau2-service.mjs';

const directory = new URL('./data/tau2/', import.meta.url);
mkdirSync(directory, { recursive: true });
for (const [name, { url, sha256 }] of Object.entries(SOURCES)) {
  const target = new URL(name, directory);
  if (existsSync(target) && createHash('sha256').update(readFileSync(target)).digest('hex') === sha256) {
    console.log(`${name}: present`);
    continue;
  }
  const response = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  const hash = createHash('sha256').update(bytes).digest('hex');
  if (hash !== sha256) throw new Error(`${name}: checksum mismatch`);
  writeFileSync(target, bytes);
  console.log(`${name}: downloaded (${bytes.length} bytes)`);
}
