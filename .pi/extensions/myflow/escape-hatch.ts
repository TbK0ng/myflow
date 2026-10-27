export const DEFAULT_PROMPT_INJECTION_SKIP_KEYWORD = "no-myflow";

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
