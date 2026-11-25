// Words as Ask compares them: lowercased letters and digits, with possessives and punctuation
// gone ("Goa's beaches!" → ["goa", "beaches"]).
export const wordsOf = (text: string): string[] =>
  text.toLowerCase().replace(/['’]s(?![\p{L}\p{N}])/gu, "").match(/[\p{L}\p{N}]+/gu) ?? [];

// Whether `words` has `run` in it, word for word and in order.
export const hasRun = (words: string[], run: string[]): boolean =>
  run.length > 0 && words.some((_, i) => run.every((w, j) => words[i + j] === w));
