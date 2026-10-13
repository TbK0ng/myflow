import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Find the project root — the directory that contains a `.myflow/` folder.
 * Walks up from `start` (default: current working directory).
 * Returns null if no `.myflow/` is found.
 */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, '.myflow'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
