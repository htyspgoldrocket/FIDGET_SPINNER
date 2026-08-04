#!/usr/bin/env node
// 번들 사이즈 예산 게이트 — CLAUDE.md 성능 예산 집행
import { readdir, readFile, stat } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';
import { join } from 'node:path';

const BUDGET_BYTES = 60 * 1024; // 60KB gzip
const DIST = 'dist';

async function walk(dir) {
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(p)));
    else out.push(p);
  }
  return out;
}

try {
  await stat(DIST);
} catch {
  console.error(`[bundle] ${DIST}/ 가 없다. 먼저 npm run build 를 실행할 것.`);
  process.exit(1);
}

const files = (await walk(DIST)).filter((f) => f.endsWith('.js'));

let total = 0;
const rows = [];
for (const f of files) {
  const gz = gzipSync(await readFile(f)).length;
  total += gz;
  rows.push([f, gz]);
}

rows.sort((a, b) => b[1] - a[1]);
console.log('\n[bundle] gzip 크기');
for (const [f, gz] of rows) {
  console.log(`  ${(gz / 1024).toFixed(1).padStart(7)} KB  ${f}`);
}

const totalKb = (total / 1024).toFixed(1);
const budgetKb = (BUDGET_BYTES / 1024).toFixed(0);
const pct = ((total / BUDGET_BYTES) * 100).toFixed(0);
console.log(`\n[bundle] 합계 ${totalKb} KB / 예산 ${budgetKb} KB  (${pct}%)`);

if (total > BUDGET_BYTES) {
  console.error(
    `\n::error::번들 예산 초과 — ${totalKb} KB > ${budgetKb} KB. 의존성 추가 여부를 먼저 확인할 것.`,
  );
  process.exit(1);
}

console.log('[bundle] OK\n');
