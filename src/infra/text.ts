/** Word counting and string formatting utilities for IM message limits and templates. */
const words = new Intl.Segmenter('zh', { granularity: 'word' })
export const IM_WORDS = 100
export const NOTE_WORDS = 30
/** Counts word-like segments across Chinese, English, and mixed text, ignoring punctuation. */
export function wordCount(text: string): number {
  let count = 0
  for (const segment of words.segment(text)) if (segment.isWordLike) count++
  return count
}
/** Validates that an outgoing IM Markdown message does not exceed `IM_WORDS` (link labels and URLs both count toward the limit). */
export function checkedImText(text: string): string {
  const count = wordCount(text)
  if (count > IM_WORDS) throw new Error(`IM message has ${count} words; maximum is ${IM_WORDS}. Rewrite as a short high-level update. Do not split it into multiple messages.`)
  return text
}
/** Shortens `text` to fit the IM limit for a mirrored copy: the whole text when it fits, else its first words and a pointer to the panel. */
export function imSummary(text: string, limit = IM_WORDS - 10, tail = '…（全文见本地面板）'): string {
  if (wordCount(text) <= IM_WORDS) return text
  let count = 0, out = ''
  for (const segment of words.segment(text)) {
    if (segment.isWordLike && ++count > limit) break
    out += segment.segment
  }
  return out.trimEnd() + tail
}
export const fill = (template: string, values: Record<string, string>): string => template.replace(/\{(\w+)\}/g, (_, name: string) => values[name] ?? '')
/** Case-insensitive comparison for GitHub logins and repository names. */
export const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
export const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Fits an outgoing IM message inside `IM_WORDS`: the text unchanged when it already fits, else a summary plus a pointer
 * to a file holding the full text. A review conclusion rarely fits in 100 words, and a refused message is worse than a
 * short one — it stays pending and the person sees nothing at all.
 * @param write persists the full text and returns the readable path, or `undefined` to summarize without one.
 */
export function imText(text: string, write?: (full: string) => string | undefined): string {
  const full = String(text ?? '')
  const count = wordCount(full)
  if (count <= IM_WORDS) return full
  const file = write?.(full)
  const summary = imSummary(full, IM_WORDS - 20, '')
  return file ? `${summary}\n\n（共 ${count} 个词，全文见 ${file}）` : imSummary(full)
}
