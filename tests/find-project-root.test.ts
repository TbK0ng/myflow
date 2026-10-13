import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findProjectRoot } from '../src/find-project-root.ts';

test('findProjectRoot returns the directory containing .myflow', () => {
  const root = mkdtempSync(join(tmpdir(), 'myflow-root-'));
  try {
    mkdirSync(join(root, '.myflow'));
    assert.equal(findProjectRoot(root), root);
    // From a nested directory, it walks up to the root.
    const nested = join(root, 'a', 'b');
    mkdirSync(nested, { recursive: true });
    assert.equal(findProjectRoot(nested), root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('findProjectRoot returns null or a valid ancestor when no .myflow exists', () => {
  const empty = mkdtempSync(join(tmpdir(), 'myflow-empty-'));
  try {
    const result = findProjectRoot(empty);
    if (result !== null) {
      assert.ok(result.length < empty.length, 'found root must be a strict ancestor');
    }
  } finally {
    rmSync(empty, { recursive: true, force: true });
  }
});
