import { readFileSync } from "node:fs";
import { join } from "node:path";

export const DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-myflow";

/** Strip an inline YAML comment (` # ...`) that is not inside quotes. */
function stripInlineComment(value: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle) inDouble = !inDouble;
    else if (ch === "#" && !inSingle && !inDouble) {
      const prev = value[i - 1];
      if (prev === " " || prev === "\t" || i === 0) return value.slice(0, i);
    }
  }
  return value;
}

/** Remove matching surrounding quotes from a YAML scalar. */
function unquoteYaml(value: string): string {
  if (value.length >= 2) {
    const first = value[0];
    const last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return value.slice(1, -1);
    }
  }
  return value;
}

/** True if the scalar is a non-string YAML type (number, bool, null). */
function isYamlNonStringScalar(value: string): boolean {
  if (value === "" || value === "~" || value === "null") return true;
  if (/^[+-]?\d+(\.\d+)?$/.test(value)) return true;
  if (value === "true" || value === "false" || value === "True" || value === "False") return true;
  return false;
}

/**
 * Read the prompt-injection skip keyword from `.myflow/config.yaml`.
 * Falls back to the default keyword when the file or field is absent.
 */
export function readPromptInjectionSkipKeyword(projectRoot: string): string {
  let config = "";
  try {
    config = readFileSync(join(projectRoot, ".myflow", "config.yaml"), "utf-8");
  } catch {
    return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD;
  }

  let inSection = false;
  let sectionIndent = -1;
  for (const rawLine of config.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!inSection) {
      if (/^prompt_injection\s*:\s*(#.*)?$/.test(trimmed)) {
        inSection = true;
        sectionIndent = rawLine.length - rawLine.trimStart().length;
      }
      continue;
    }
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = rawLine.length - rawLine.trimStart().length;
    if (indent <= sectionIndent) break;
    const match = trimmed.match(/^skip_keyword\s*:\s*(.*)$/);
    if (!match) continue;
    const rawValue = stripInlineComment(match[1]!).trim();
    const unquoted = unquoteYaml(rawValue);
    if (unquoted === rawValue && isYamlNonStringScalar(rawValue)) {
      return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD;
    }
    return unquoted.trim();
  }
  return DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD;
}

/**
 * Check whether the user input contains the skip keyword at a word boundary.
 * An empty keyword never matches.
 */
export function shouldSkipWorkflowState(userInput: string, skipKeyword: string): boolean {
  if (!skipKeyword) return false;
  const escapedKeyword = skipKeyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp("(?<![\\w-])" + escapedKeyword + "(?![\\w-])", "i");
  return pattern.test(userInput);
}
