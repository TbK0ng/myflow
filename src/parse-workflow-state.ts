import { readFileSync } from 'node:fs';

/**
 * Parse workflow-state blocks from a `workflow.md` file.
 *
 * Blocks are delimited by `[workflow-state:STATUS]` and `[/workflow-state:STATUS]`.
 * STATUS charset is `[A-Za-z0-9_-]+` (per the book, Chapter 4).
 *
 * Returns a map from status to the trimmed block content.
 * If a status appears more than once, the last occurrence wins.
 */
export function parseWorkflowStateBlocks(workflowText: string): Map<string, string> {
  const blocks = new Map<string, string>();
  const regex = /\[workflow-state:([A-Za-z0-9_-]+)\]\r?\n([\s\S]*?)\[\/workflow-state:\1\]/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(workflowText)) !== null) {
    blocks.set(match[1], match[2].trim());
  }
  return blocks;
}

/**
 * Read and parse `workflow.md` from the project root.
 * Returns an empty map if the file does not exist.
 */
export function loadWorkflowStates(projectRoot: string): Map<string, string> {
  const path = `${projectRoot}/.myflow/workflow.md`;
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch {
    return new Map();
  }
  return parseWorkflowStateBlocks(text);
}
