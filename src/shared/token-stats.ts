import type { ActionKind, TokenUsage } from './types.ts'
import { categoryOfName } from './action-kind.ts'

export type TokenCategory = ActionKind | 'answer'

export interface TokenShare {
  category: TokenCategory
  usage: TokenUsage
  total: number
}

const ZERO: TokenUsage = { input: 0, cacheWrite: 0, cacheRead: 0, output: 0 }

function count(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? Math.floor(v) : 0
}

/** Терпимо разбирает поле `usage` записи транскрипта; не объект — null. */
export function parseUsage(raw: unknown): TokenUsage | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
  const u = raw as Record<string, unknown>
  return {
    input: count(u.input_tokens),
    cacheWrite: count(u.cache_creation_input_tokens),
    cacheRead: count(u.cache_read_input_tokens),
    output: count(u.output_tokens)
  }
}

export function totalTokens(usage: TokenUsage): number {
  return usage.input + usage.cacheWrite + usage.cacheRead + usage.output
}

/** Доля i из n от целого v: остаток от деления достаётся первым долям, сумма сохраняется. */
function part(v: number, i: number, n: number): number {
  return Math.floor(v / n) + (i < v % n ? 1 : 0)
}

/**
 * Сводит расход по категориям. Токены ответа с несколькими инструментами делятся
 * между ними поровну; ответ без инструментов — категория 'answer'.
 * Результат — по убыванию total, без нулевых категорий.
 */
export function aggregateTokens(entries: { tools: string[]; usage: TokenUsage }[]): TokenShare[] {
  const sums = new Map<TokenCategory, TokenUsage>()
  const add = (category: TokenCategory, usage: TokenUsage): void => {
    const acc = sums.get(category) ?? { ...ZERO }
    acc.input += usage.input
    acc.cacheWrite += usage.cacheWrite
    acc.cacheRead += usage.cacheRead
    acc.output += usage.output
    sums.set(category, acc)
  }
  for (const { tools, usage } of entries) {
    if (tools.length === 0) {
      add('answer', usage)
      continue
    }
    const n = tools.length
    tools.forEach((name, i) =>
      add(categoryOfName(name), {
        input: part(usage.input, i, n),
        cacheWrite: part(usage.cacheWrite, i, n),
        cacheRead: part(usage.cacheRead, i, n),
        output: part(usage.output, i, n)
      })
    )
  }
  return [...sums]
    .map(([category, usage]) => ({ category, usage, total: totalTokens(usage) }))
    .filter((s) => s.total > 0)
    .sort((a, b) => b.total - a.total)
}
