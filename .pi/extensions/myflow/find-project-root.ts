import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

/**
 * Find the project root — the directory that contains a `.myflow/` folder with
 * a `workflow.md` in it. Walks up from `start` (default: current working
 * directory). Returns null if no project is found.
 *
 * The `workflow.md` check matters: `.myflow` alone is a marker any stray
 * directory can carry, and treating one above the project (for example in a
 * home directory) as the root would silently redirect the harness there.
 */
export function findProjectRoot(start: string = process.cwd()): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(resolve(dir, '.myflow', 'workflow.md'))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
