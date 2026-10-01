import type { HistoryRequest, HistorySession } from '../shared/types'

/**
 * Разбор транскрипта Claude Code в сводку для панели «История» — без Electron и fs,
 * чтобы проверяться тестами. Формат транскрипта внутренний, поэтому разбор, как и
 * в transcript.ts, терпимый: неизвестные записи просто пропускаются.
 */

/** Имя, которое приложение даёт своим сессиям (`--name`); как название его не показываем. */
export const APP_SESSION_NAME = 'Voice Desk'

/** Начало промта отката из assistant.ts — по нему запрос помечается как откат. */
export const ROLLBACK_PROMPT_PREFIX = 'Откати изменения последней задачи к точке отката'

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
const INTERRUPTED_PREFIX = '[Request interrupted'
const MAX_REQUEST_CHARS = 500
const MAX_TITLE_CHARS = 80

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : null
}

function oneLine(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function timestamp(r: Record<string, unknown>): number | null {
  if (typeof r['timestamp'] !== 'string') return null
  const at = Date.parse(r['timestamp'])
  return Number.isNaN(at) ? null : at
}

/** Текст пользовательской записи: строка или текстовые блоки. Результаты инструментов — null. */
function userText(r: Record<string, unknown>): string | null {
  if (r['type'] !== 'user' || r['isSidechain'] === true) return null
  const content = asRecord(r['message'])?.['content']
  if (typeof content === 'string') return content.trim()
  if (!Array.isArray(content)) return null
  const parts: string[] = []
  for (const block of content) {
    const b = asRecord(block)
    if (!b) continue
    if (b['type'] === 'tool_result') return null
    if (b['type'] === 'text' && typeof b['text'] === 'string') parts.push(b['text'])
  }
  return parts.join('\n').trim()
}

/**
 * Запрос, который написал (или сказал) человек. Не запросы: служебные записи
 * (`isMeta` — обратная связь хуков, предупреждения CLI), слеш-команды и их вывод
 * (`<command-name>…`, `<local-command-stdout>…`), отметка о прерывании.
 */
export function promptText(record: unknown): string | null {
  const r = asRecord(record)
  if (!r || r['isMeta'] === true) return null
  const text = userText(r)
  if (!text || text.startsWith('<') || text.startsWith(INTERRUPTED_PREFIX)) return null
  return text
}

/** Сводка одного транскрипта; записи подаются по одной, чтобы не держать файл в памяти. */
export class TranscriptSummarizer {
  cwd: string | null = null
  private customTitle: string | null = null
  private aiTitle: string | null = null
  private fromApp = false
  private startedAt: number | null = null
  private updatedAt: number | null = null
  private readonly requests: HistoryRequest[] = []
  private current: { request: HistoryRequest; files: Set<string>; plan: boolean } | null = null

  add(record: unknown): void {
    const r = asRecord(record)
    if (!r) return

    const at = timestamp(r)
    if (at !== null) {
      this.startedAt ??= at
      this.updatedAt = at
    }
    if (this.cwd === null && typeof r['cwd'] === 'string') this.cwd = r['cwd']

    switch (r['type']) {
      case 'custom-title':
        if (typeof r['customTitle'] === 'string') this.customTitle = r['customTitle']
        return
      case 'ai-title':
        if (typeof r['aiTitle'] === 'string') this.aiTitle = r['aiTitle']
        return
      case 'agent-name':
        if (r['agentName'] === APP_SESSION_NAME) this.fromApp = true
        return
      case 'user':
        this.addUser(r, at)
        return
      case 'assistant':
        this.addAssistant(r)
        return
      default:
        return
    }
  }

  /** null — в транскрипте нет ни одного запроса (сессию открыли и закрыли). */
  result(id: string): HistorySession | null {
    this.closeCurrent()
    if (this.requests.length === 0) return null
    const first = this.requests[0]!
    const named = this.customTitle && this.customTitle !== APP_SESSION_NAME ? this.customTitle : null
    return {
      id,
      title: oneLine(named ?? this.aiTitle ?? first.text, MAX_TITLE_CHARS),
      startedAt: this.startedAt ?? first.at,
      updatedAt: this.updatedAt ?? first.at,
      fromApp: this.fromApp,
      requests: [...this.requests]
    }
  }

  private addUser(r: Record<string, unknown>, at: number | null): void {
    if (r['isSidechain'] === true) return
    const raw = userText(r)
    if (raw?.startsWith(INTERRUPTED_PREFIX)) {
      if (this.current) this.current.request.outcome = 'interrupted'
      return
    }
    const text = promptText(r)
    if (!text) return

    this.closeCurrent()
    this.current = {
      request: {
        text: text.length > MAX_REQUEST_CHARS ? `${text.slice(0, MAX_REQUEST_CHARS - 1)}…` : text,
        at: at ?? this.updatedAt ?? 0,
        outcome: text.startsWith(ROLLBACK_PROMPT_PREFIX) ? 'rollback' : 'answer',
        files: 0
      },
      files: new Set(),
      plan: false
    }
  }

  private addAssistant(r: Record<string, unknown>): void {
    if (r['isSidechain'] === true || !this.current) return
    const content = asRecord(r['message'])?.['content']
    if (!Array.isArray(content)) return
    for (const block of content) {
      const b = asRecord(block)
      if (!b || b['type'] !== 'tool_use' || typeof b['name'] !== 'string') continue
      if (b['name'] === 'ExitPlanMode') this.current.plan = true
      if (EDIT_TOOLS.has(b['name'])) {
        const input = asRecord(b['input'])
        const path = input?.['file_path'] ?? input?.['notebook_path']
        if (typeof path === 'string') this.current.files.add(path)
      }
    }
  }

  private closeCurrent(): void {
    const c = this.current
    if (!c) return
    this.current = null
    c.request.files = c.files.size
    // Откат и прерывание важнее остального: по ним видно, что результата нет.
    if (c.request.outcome === 'answer') {
      c.request.outcome = c.files.size > 0 ? 'edits' : c.plan ? 'plan' : 'answer'
    }
    this.requests.push(c.request)
  }
}
