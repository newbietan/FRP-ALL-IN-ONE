import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { transformSync } from 'esbuild';

// Use the existing build dependency so tests do not require native TS support.
const source = readFileSync(new URL('../src/time.ts', import.meta.url), 'utf8');
const { code } = transformSync(source, { loader: 'ts', format: 'esm' });
const { formatLastSeen } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
process.env.TZ = 'UTC';

const seconds = 1704164645; // 2024-01-02 03:04:05 UTC

test('formats API Unix seconds instead of showing raw digits', () => {
  assert.equal(formatLastSeen(seconds), '2024-01-02 03:04:05');
  assert.equal(formatLastSeen(String(seconds)), '2024-01-02 03:04:05');
});

test('formats live event milliseconds and ISO dates consistently', () => {
  assert.equal(formatLastSeen(seconds * 1000), '2024-01-02 03:04:05');
  assert.equal(formatLastSeen('2024-01-02T03:04:05Z'), '2024-01-02 03:04:05');
});

test('uses local time rather than truncating a UTC ISO string', () => {
  process.env.TZ = 'Asia/Shanghai';
  try {
    assert.equal(formatLastSeen(seconds), '2024-01-02 11:04:05');
    assert.equal(formatLastSeen(seconds * 1000), '2024-01-02 11:04:05');
  } finally {
    process.env.TZ = 'UTC';
  }
});

test('shows a placeholder for missing, never-seen and invalid timestamps', () => {
  for (const value of [null, undefined, '', '  ', 0, '0', -1, NaN, Infinity, 1e20, 'invalid']) {
    assert.equal(formatLastSeen(value), '-', `value: ${value}`);
  }
});
