#!/usr/bin/env node
/**
 * Check that an Aholo API key works — without spending any credits.
 *
 *   node tools/check-key.mjs
 *
 * Calls the read-only generation-record listing (GET /lux3d/v1/generate/task/list),
 * which authenticates the key and returns nothing billable. Run this before
 * `npm run assets:generate` so a bad key is diagnosed as a bad key rather than
 * as fifteen mysterious task failures.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AholoClient, AholoError } from '../src/aholo/client.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function loadApiKey() {
  if (process.env.AHOLO_API_KEY) return { key: process.env.AHOLO_API_KEY.trim(), from: 'AHOLO_API_KEY' };
  for (const file of ['.env.local', '.env']) {
    const p = path.join(root, file);
    if (!fs.existsSync(p)) continue;
    const match = fs.readFileSync(p, 'utf8').match(/^\s*AHOLO_API_KEY\s*=\s*(.+)\s*$/m);
    if (match) return { key: match[1].trim().replace(/^["']|["']$/g, ''), from: file };
  }
  return { key: '', from: null };
}

/** Turn a platform error code into something actionable. */
function explain(code, message) {
  const hints = {
    '-1': 'the key was rejected or the request was malformed — re-copy the key from https://labs.aholo.ai/api-keys',
    'BIZ_11001': 'rate limited — wait a moment and retry',
    'BIZ_11003': 'insufficient credits on this account',
    'BIZ_24002': 'insufficient credits on this account',
    unauthorized: 'the key is not recognised — check you copied the whole value',
  };
  const hint = hints[code];
  return hint ? `\n  → ${hint}` : message ? `\n  → ${message}` : '';
}

async function main() {
  const { key, from } = loadApiKey();
  if (!key) {
    console.error(
      'No API key found.\n' +
        '  Set AHOLO_API_KEY, or create .env.local containing:\n' +
        '    AHOLO_API_KEY=your-key\n' +
        '  Get one at https://labs.aholo.ai/api-keys',
    );
    process.exit(2);
  }

  console.log(`key: ${key.slice(0, 4)}…${key.slice(-3)} (${key.length} chars, from ${from})`);
  const client = new AholoClient({ apiKey: key });

  try {
    const page = await client.listTasks({ page: 1, pageSize: 5 });
    console.log(`\n✓ authenticated — this account has ${page.total} generation task(s)`);
    if (page.items.length) {
      console.log('\n  most recent:');
      for (const task of page.items) {
        const when = new Date(task.created).toISOString().replace('T', ' ').slice(0, 19);
        console.log(`    #${String(task.taskId).padEnd(10)} status=${task.status}  ${when}`);
      }
    } else {
      console.log('  (no tasks yet — the first generation will appear here)');
    }
    console.log('\nNext: npm run assets:plan  →  npm run assets:generate');
  } catch (error) {
    const code = error instanceof AholoError ? error.code : 'unknown';
    console.error(`\n✗ key check failed (${code}): ${error instanceof Error ? error.message : error}`);
    console.error(explain(code, ''));
    process.exit(1);
  }
}

main();
