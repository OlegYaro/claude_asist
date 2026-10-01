import type { HistoryRequest, RequestOutcome } from './types'

/**
 * Подписи истории запросов — общие для панели «История» и Telegram-бота,
 * чтобы в приложении и на телефоне одно и то же называлось одинаково.
 */

export const OUTCOME_LABEL: Record<RequestOutcome, string> = {
  answer: 'ответ',
  plan: 'план',
  edits: 'правки',
  interrupted: 'прервано',
  rollback: 'откат'
}

export function outcomeText(r: HistoryRequest): string {
  return r.outcome === 'edits' ? `${OUTCOME_LABEL.edits}: ${r.files}` : OUTCOME_LABEL[r.outcome]
}

/** Русское множественное число: plural(3, 'запрос', 'запроса', 'запросов'). */
export function plural(n: number, one: string, few: string, many: string): string {
  const mod10 = n % 10
  const mod100 = n % 100
  if (mod10 === 1 && mod100 !== 11) return one
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few
  return many
}

export function timeLabel(at: number): string {
  return new Date(at).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
}

/** «сегодня, 12:30», «вчера, 09:05», «28 сент., 18:40». */
export function dateLabel(at: number, now = Date.now()): string {
  const day = new Date(at)
  const today = new Date(now)
  const yesterday = new Date(now)
  yesterday.setDate(today.getDate() - 1)
  const same = (a: Date, b: Date): boolean => a.toDateString() === b.toDateString()
  const prefix = same(day, today)
    ? 'сегодня'
    : same(day, yesterday)
      ? 'вчера'
      : day.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' })
  return `${prefix}, ${timeLabel(at)}`
}
