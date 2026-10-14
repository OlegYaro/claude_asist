import { modelLabel } from '../shared/model-label.ts'

/**
 * Какая модель работает сейчас. Записи субагентов лежат не в основном транскрипте, а
 * в `<сессия>/subagents/agent-*.jsonl`, поэтому модель шага берём из вызова Agent в
 * основной цепочке (`input.model`) и возвращаем модель сессии, когда он вернул результат.
 * Каждый метод возвращает модель для шапки или null, если показывать нечего менять.
 * Чистая логика без Electron — с тестами.
 */
export class ModelTracker {
  private main: string | null = null
  private agents = new Map<string, string>()

  /** Запись основной цепочки; служебный `<synthetic>` модель не затирает. */
  setMain(model: unknown): string | null {
    if (typeof model !== 'string' || !modelLabel(model)) return null
    this.main = model
    return this.current()
  }

  /** Субагент запущен; без `model` он идёт на модели сессии — показывать нечего. */
  agentStart(toolUseId: string, model: unknown): string | null {
    if (typeof model !== 'string' || !modelLabel(model)) return null
    this.agents.set(toolUseId, model)
    return this.current()
  }

  agentEnd(toolUseId: string): string | null {
    return this.agents.delete(toolUseId) ? this.current() : null
  }

  /** Ход прерван — субагенты больше не работают. */
  reset(): string | null {
    if (this.agents.size === 0) return null
    this.agents.clear()
    return this.current()
  }

  private current(): string | null {
    let last: string | null = null
    for (const model of this.agents.values()) last = model
    return last ?? this.main
  }
}
