import type { TokenUsage } from './types.ts'

/**
 * Оценка доли 5-часового лимита, которую съела эта сессия.
 *
 * Сервер отдаёт только общий процент аккаунта (`rate_limits.five_hour` в статус-строке
 * Claude Code), по сессиям его не делит. Поэтому: расход сессии берём из её транскрипта
 * и взвешиваем по ценам API (кэш дёшев, выход и сильные модели дороги), а перевод в
 * проценты калибруем по приросту общего процента. Чужие терминалы не учитываются, пока
 * в нашей сессии за тот же интервал нет расхода, а редкие выбросы гасит медиана.
 */

/** Цена токенов в долларах за миллион. */
export interface ModelPrice {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

const FABLE: ModelPrice = { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 }
const OPUS: ModelPrice = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }
const OPUS_OLD: ModelPrice = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 }
const SONNET: ModelPrice = { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 }
const SONNET_OLD: ModelPrice = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 }
const HAIKU: ModelPrice = { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 }
const HAIKU_OLD: ModelPrice = { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 }

/**
 * Цена по id или алиасу модели. Неизвестная модель считается как Sonnet: масштаб всё
 * равно выправляет калибровка, а ошибка цены сдвигает только сравнение моделей.
 */
export function priceFor(model: string | null | undefined): ModelPrice {
  const id = (model ?? '').toLowerCase()
  const old = /-(?:[1-4])(?:-|$)/.test(id) // claude-opus-4-8, claude-haiku-4-5 …
  if (/fable|mythos/.test(id)) return FABLE
  if (id.includes('opus')) return old ? OPUS_OLD : OPUS
  if (id.includes('haiku')) return old ? HAIKU_OLD : HAIKU
  if (id.includes('sonnet')) return old ? SONNET_OLD : SONNET
  return SONNET
}

/** Токены, умноженные на цену, в микродолларах (целые — их удобно делить по категориям). */
export function weightUsage(usage: TokenUsage, model: string | null | undefined): TokenUsage {
  const p = priceFor(model)
  return {
    input: Math.round(usage.input * p.input),
    cacheWrite: Math.round(usage.cacheWrite * p.cacheWrite),
    cacheRead: Math.round(usage.cacheRead * p.cacheRead),
    output: Math.round(usage.output * p.output)
  }
}

/** Стоимость расхода по ценам API, в долларах. */
export function usageCostUsd(usage: TokenUsage, model: string | null | undefined): number {
  const w = weightUsage(usage, model)
  return (w.input + w.cacheWrite + w.cacheRead + w.output) / 1_000_000
}

export const WINDOW_SEC = 5 * 60 * 60
const MAX_RATIOS = 20
const MAX_ENTRIES = 5000

export interface LimitsSnapshot {
  /** Оценка доли лимита, съеденной этой сессией; null, пока нет калибровки. */
  sessionPct: number | null
  /** Общий процент 5-часового лимита по данным CLI; null — CLI его не отдаёт. */
  totalPct: number | null
  /** Когда окно лимита сбросится, Unix-секунды. */
  resetsAt: number | null
  /** Расход сессии в текущем окне по ценам API, в долларах. */
  costUsd: number
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

export class LimitTracker {
  /** Стоимость по id ответа: транскрипт дописывает usage тому же id, запись заменяется. */
  private readonly entries = new Map<string, { usd: number; at: number }>()
  private windowEnd: number | null = null
  private totalPct: number | null = null
  private anchor: { pct: number; usd: number } | null = null

  private ratios: number[]

  /** `ratios` — проценты лимита на доллар, накопленные раньше (из настроек). */
  constructor(ratios: number[] = []) {
    this.ratios = ratios.filter((r) => Number.isFinite(r) && r > 0).slice(-MAX_RATIOS)
  }

  get calibration(): number[] {
    return [...this.ratios]
  }

  /** Расход одного ответа; `at` — миллисекунды. */
  addUsage(id: string, usd: number, at: number): void {
    this.entries.delete(id)
    this.entries.set(id, { usd, at })
    if (this.entries.size > MAX_ENTRIES) {
      const oldest = this.entries.keys().next().value
      if (oldest !== undefined) this.entries.delete(oldest)
    }
  }

  /** Новая сессия: расход старой в оценку не входит, калибровка остаётся. */
  resetSession(): void {
    this.entries.clear()
    this.anchor = this.totalPct === null ? null : { pct: this.totalPct, usd: 0 }
  }

  private windowCost(): number {
    if (this.windowEnd === null) return 0
    const from = (this.windowEnd - WINDOW_SEC) * 1000
    let sum = 0
    for (const e of this.entries.values()) if (e.at >= from) sum += e.usd
    return sum
  }

  /** Новые данные статус-строки: общий процент и время сброса окна. */
  observe(pct: number, resetsAt: number): void {
    if (!Number.isFinite(pct) || !Number.isFinite(resetsAt)) return
    const usd = this.windowCost()
    if (this.windowEnd !== resetsAt || this.anchor === null || pct < this.anchor.pct) {
      // Новое окно (или процент упал): точка отсчёта.
      this.windowEnd = resetsAt
      this.totalPct = pct
      this.anchor = { pct, usd: this.windowCost() }
      return
    }
    this.totalPct = pct
    const delta = pct - this.anchor.pct
    if (delta < 1) return
    const spent = usd - this.anchor.usd
    // Процент вырос, а наша сессия ничего не потратила — это чужие терминалы.
    if (spent > 0) this.ratios = [...this.ratios, delta / spent].slice(-MAX_RATIOS)
    this.anchor = { pct, usd }
  }

  snapshot(): LimitsSnapshot {
    const usd = this.windowCost()
    const ratio = median(this.ratios)
    let sessionPct = ratio === null ? null : usd * ratio
    if (sessionPct !== null && this.totalPct !== null) sessionPct = Math.min(sessionPct, this.totalPct)
    return {
      sessionPct,
      totalPct: this.totalPct,
      resetsAt: this.windowEnd,
      costUsd: usd
    }
  }
}
