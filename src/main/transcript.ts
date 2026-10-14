import { EventEmitter } from 'node:events'
import { createReadStream, existsSync, statSync, watch, type FSWatcher } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { join, relative, isAbsolute } from 'node:path'
import { claudeProjectsDir } from './paths'
import { promptText } from './history-logic'
import { parseQuestions } from './questions'
import { ModelTracker } from './model-tracker'
import type { ChatMessage, TodoItem, ToolTask, TranscriptEvent } from '../shared/types'

/**
 * Читает JSONL-транскрипт, который Claude Code пишет параллельно работе в TUI,
 * и превращает его в события для UI.
 *
 * Почему так, а не парсингом вывода терминала: транскрипт — структурированный,
 * в нём есть tool_use/tool_result с идентификаторами, тексты ответов и смена режимов,
 * тогда как поток PTY это ANSI-графика TUI, из которой ничего надёжно не достать.
 *
 * Формат внутренний и может меняться между версиями CLI, поэтому парсер намеренно
 * терпимый: неизвестные `type` и неизвестные инструменты игнорируются, а не ломают разбор.
 */

const POLL_INTERVAL_MS = 250
const FIND_RETRY_INTERVAL_MS = 250
/** Полный перебор папок проектов — раз в столько попыток (≈2 с). */
const FULL_SCAN_EVERY = 8


/**
 * Ищет файл транскрипта по sessionId.
 *
 * Слаг каталога проекта намеренно не вычисляем из пути: правила замены символов
 * недокументированы и неочевидны (например, `/Users/name/Projects/my_app` становится
 * `-Users-name-Projects-my-app`: в `-` превращаются и `/`, и `_`). Вместо этого перебираем
 * каталоги проектов и ищем файл с известным именем.
 */
/**
 * Ждём без таймаута, пока жива сессия: Claude Code создаёт файл только с первым
 * сообщением, а до него может пройти сколько угодно времени. Прежний таймаут
 * в 5 минут молча оставлял панель задач пустой навсегда.
 */
export async function findTranscript(
  sessionId: string,
  projectDir: string,
  isAlive: () => boolean
): Promise<string | null> {
  const root = claudeProjectsDir()
  const fileName = `${sessionId}.jsonl`
  // Обычно файл в папке, названной по пути проекта (всё, кроме латиницы и цифр, — `-`).
  const likely = join(root, projectDir.replace(/[^a-zA-Z0-9]/g, '-'), fileName)

  for (let attempt = 0; ; attempt++) {
    if (existsSync(likely)) return likely
    // Полный перебор всех проектов — реже: имя папки лишь подсказка
    // (длинные пути CLI обрезает и дописывает хеш).
    if (attempt % FULL_SCAN_EVERY === 0) {
      try {
        const entries = await readdir(root, { withFileTypes: true })
        for (const entry of entries) {
          if (!entry.isDirectory()) continue
          const candidate = join(root, entry.name, fileName)
          if (existsSync(candidate)) return candidate
        }
      } catch {
        // каталога может ещё не быть — просто ждём следующей попытки
      }
    }
    if (!isAlive()) return null
    await new Promise((r) => setTimeout(r, FIND_RETRY_INTERVAL_MS))
  }
}

// ─────────────────────── Сводки входов инструментов ───────────────────────

function truncate(value: string, max = 120): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

function shortPath(filePath: string, projectDir: string): string {
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(projectDir, filePath)
  return rel && !rel.startsWith('..') ? rel : filePath
}

/** Человекочитаемая сводка вызова инструмента для строки в панели задач. */
export function summarizeToolInput(
  name: string,
  input: unknown,
  projectDir: string
): string {
  if (typeof input !== 'object' || input === null) return ''
  const i = input as Record<string, unknown>
  const str = (key: string): string | null =>
    typeof i[key] === 'string' ? (i[key] as string) : null

  switch (name) {
    case 'Read':
    case 'Write':
    case 'Edit':
    case 'NotebookEdit': {
      const p = str('file_path')
      return p ? shortPath(p, projectDir) : ''
    }
    case 'Bash':
      return truncate(str('command') ?? '')
    case 'Glob':
      return truncate(str('pattern') ?? '')
    case 'Grep': {
      const pattern = str('pattern') ?? ''
      const path = str('path')
      return truncate(path ? `${pattern} в ${shortPath(path, projectDir)}` : pattern)
    }
    case 'WebSearch':
      return truncate(str('query') ?? '')
    case 'WebFetch':
      return truncate(str('url') ?? '')
    case 'Agent':
    case 'Task':
      return truncate(str('description') ?? str('prompt') ?? '')
    case 'TodoWrite':
      return 'план обновлён'
    case 'ExitPlanMode': {
      // Первая содержательная строка плана — обычно его заголовок.
      const plan = str('plan') ?? ''
      const title = plan.split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '') ?? ''
      return truncate(title || 'план')
    }
    case 'TaskCreate':
      return truncate(str('subject') ?? '')
    case 'TaskUpdate':
      return truncate(`${str('taskId') ?? ''} ${str('status') ?? ''}`)
    case 'AskUserQuestion': {
      const questions = i['questions']
      if (Array.isArray(questions) && questions.length > 0) {
        const first = questions[0] as Record<string, unknown> | undefined
        if (first && typeof first['question'] === 'string') return truncate(first['question'])
      }
      return 'вопрос пользователю'
    }
    default:
      return truncate(JSON.stringify(i), 80)
  }
}

/** Достаёт текст из `content` блока tool_result — он бывает строкой или массивом блоков. */
function toolResultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((b) =>
        typeof b === 'object' && b !== null && typeof (b as { text?: unknown }).text === 'string'
          ? ((b as { text: string }).text)
          : ''
      )
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Разбирает вход TodoWrite. Форма не проверена на реальных данных (в доступных
 * транскриптах этот инструмент не встречался), поэтому парсер терпимый:
 * не подошло — возвращаем null, и панель просто не показывает план.
 */
function parseTodos(input: unknown): TodoItem[] | null {
  if (typeof input !== 'object' || input === null) return null
  const raw = (input as { todos?: unknown }).todos ?? input
  if (!Array.isArray(raw)) return null

  const items: TodoItem[] = []
  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue
    const e = entry as Record<string, unknown>
    const content = typeof e['content'] === 'string' ? e['content'] : null
    if (!content) continue
    const status = e['status']
    items.push({
      content,
      status:
        status === 'in_progress' || status === 'completed' || status === 'pending'
          ? status
          : 'pending',
      ...(typeof e['activeForm'] === 'string' ? { activeForm: e['activeForm'] } : {})
    })
  }
  return items.length ? items : null
}

/** Первый вопрос AskUserQuestion: текст и подписи вариантов. */
function parseQuestion(input: unknown): { question: string; options: string[] } | null {
  const first = parseQuestions(input)[0]
  return first ? { question: first.question, options: first.options } : null
}

// ─────────────────────────── Tailer ───────────────────────────

/**
 * Инкрементально читает транскрипт и эмитит события `event` (TranscriptEvent).
 *
 * `fs.watch` на macOS может пропускать быстрые дозаписи, поэтому дополнительно
 * работает опрос по таймеру — он же страхует случай, когда watch вообще не сработал.
 */
export class TranscriptTailer extends EventEmitter {
  private offset = 0
  private tail = ''
  /** Байтовое смещение начала `tail` в файле — чтобы знать, где кончается история. */
  private tailStart = 0
  private watcher: FSWatcher | null = null
  private poll: NodeJS.Timeout | null = null
  private draining = false
  private stopped = false

  /** Открытые вызовы инструментов: tool_use.id → задача, для сопоставления с результатом. */
  private openTasks = new Map<string, ToolTask>()
  /** Накопленный план из TaskCreate/TaskUpdate — этот CLI использует их вместо TodoWrite. */
  private taskPlan = new Map<string, TodoItem>()
  private models = new ModelTracker()

  constructor(
    private readonly filePath: string,
    private readonly projectDir: string,
    /** true — прочитать существующее содержимое; false — только новые строки. */
    private readonly replayExisting = false,
    /**
     * Строки до этого байта — история продолженной сессии: они уходят событием
     * `history` (ChatMessage, включая ваши реплики) только для показа и не
     * становятся событиями `event`, иначе старый план снова ждал бы одобрения.
     */
    private readonly historyBytes = 0
  ) {
    super()
  }

  start(): void {
    if (!this.replayExisting) {
      try {
        this.offset = statSync(this.filePath).size
      } catch {
        this.offset = 0
      }
      this.tailStart = this.offset
    }

    try {
      this.watcher = watch(this.filePath, () => void this.drain())
    } catch {
      // watch может быть недоступен — остаётся опрос
    }
    this.poll = setInterval(() => void this.drain(), POLL_INTERVAL_MS)
    void this.drain()
  }

  stop(): void {
    this.stopped = true
    this.watcher?.close()
    this.watcher = null
    if (this.poll) clearInterval(this.poll)
    this.poll = null
  }

  private async drain(): Promise<void> {
    if (this.draining || this.stopped) return
    this.draining = true
    try {
      let size: number
      try {
        size = statSync(this.filePath).size
      } catch {
        return
      }
      // Файл усечён или пересоздан — начинаем сначала, иначе будем читать мусор.
      if (size < this.offset) {
        this.offset = 0
        this.tail = ''
        this.tailStart = 0
      }
      if (size === this.offset) return

      const chunk = await this.readRange(this.offset, size - 1)
      this.offset = size

      const text = this.tail + chunk
      const lines = text.split('\n')
      // Последний фрагмент может быть незавершённой строкой — придержим до следующего чтения.
      this.tail = lines.pop() ?? ''

      let lineStart = this.tailStart
      for (const line of lines) {
        const lineEnd = lineStart + Buffer.byteLength(line, 'utf8') + 1
        const isHistory = lineEnd <= this.historyBytes
        lineStart = lineEnd
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const record: unknown = JSON.parse(trimmed)
          if (isHistory) this.handleHistoryRecord(record)
          else this.handleRecord(record)
        } catch {
          // битая строка — пропускаем, не роняя разбор остальных
        }
      }
      this.tailStart = lineStart
    } finally {
      this.draining = false
    }
  }

  private readRange(start: number, end: number): Promise<string> {
    return new Promise((resolve, reject) => {
      const chunks: Buffer[] = []
      const stream = createReadStream(this.filePath, { start, end })
      stream.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)))
      stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
      stream.on('error', reject)
    })
  }

  private emitModel(model: string | null): void {
    if (model !== null) this.emitEvent({ kind: 'mode', permissionMode: null, model })
  }

  private emitEvent(event: TranscriptEvent): void {
    this.emit('event', event)
  }

  private handleRecord(record: unknown): void {
    if (typeof record !== 'object' || record === null) return
    const r = record as Record<string, unknown>

    // Трафик субагентов не смешиваем с основным чатом — иначе UI заливает
    // сообщениями, которых пользователь не отправлял.
    if (r['isSidechain'] === true) return

    const at = typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : Date.now()
    const ts = Number.isNaN(at) ? Date.now() : at

    switch (r['type']) {
      case 'assistant':
        this.handleAssistant(r, ts)
        break
      case 'user':
        this.handleUser(r)
        break
      case 'ai-title':
        if (typeof r['aiTitle'] === 'string') {
          this.emitEvent({ kind: 'title', title: r['aiTitle'] })
        }
        break
      case 'permission-mode':
        this.emitEvent({
          kind: 'mode',
          permissionMode: typeof r['permissionMode'] === 'string' ? r['permissionMode'] : null,
          model: null
        })
        break
      case 'system':
        // subtype `turn_duration` — самый надёжный признак «ход завершён»:
        // приходит ровно один раз в конце хода.
        if (r['subtype'] === 'turn_duration') this.emitEvent({ kind: 'turn-end' })
        break
      default:
        break
    }
  }

  /** Запись из истории продолженной сессии: только реплики для чата и название. */
  private handleHistoryRecord(record: unknown): void {
    if (typeof record !== 'object' || record === null) return
    const r = record as Record<string, unknown>
    if (r['isSidechain'] === true) return
    if (r['type'] === 'ai-title') return this.handleRecord(r)

    const at = typeof r['timestamp'] === 'string' ? Date.parse(r['timestamp']) : NaN
    const ts = Number.isNaN(at) ? Date.now() : at
    const uuid = typeof r['uuid'] === 'string' ? r['uuid'] : String(ts)

    const prompt = promptText(r)
    if (prompt) {
      const message: ChatMessage = { id: uuid, role: 'user', text: prompt, at: ts }
      this.emit('history', message)
      return
    }
    if (r['type'] !== 'assistant') return
    const m = r['message']
    if (typeof m !== 'object' || m === null) return
    const content = (m as Record<string, unknown>)['content']
    if (!Array.isArray(content)) return
    let textIndex = 0
    for (const block of content) {
      const b = block as Record<string, unknown> | null
      if (b?.['type'] !== 'text' || typeof b['text'] !== 'string' || !b['text'].trim()) continue
      const message: ChatMessage = {
        id: `${uuid}:${textIndex++}`,
        role: 'assistant',
        text: b['text'],
        at: ts,
        final: (m as Record<string, unknown>)['stop_reason'] === 'end_turn'
      }
      this.emit('history', message)
    }
  }

  private handleAssistant(r: Record<string, unknown>, ts: number): void {
    const message = r['message']
    if (typeof message !== 'object' || message === null) return
    const m = message as Record<string, unknown>

    this.emitModel(this.models.setMain(m['model']))

    const content = m['content']
    if (!Array.isArray(content)) return

    const uuid = typeof r['uuid'] === 'string' ? r['uuid'] : String(ts)
    let textIndex = 0

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>

      if (b['type'] === 'text' && typeof b['text'] === 'string' && b['text'].trim()) {
        const msg: ChatMessage = {
          id: `${uuid}:${textIndex++}`,
          role: 'assistant',
          text: b['text'],
          at: ts,
          // Финальность определяет UI по событию turn-end: на момент чтения
          // строки ещё неизвестно, последняя ли она в ходе.
          final: m['stop_reason'] === 'end_turn'
        }
        this.emitEvent({ kind: 'chat', message: msg })
        continue
      }

      if (b['type'] === 'tool_use' && typeof b['id'] === 'string' && typeof b['name'] === 'string') {
        const name = b['name']
        const task: ToolTask = {
          id: b['id'],
          name,
          summary: summarizeToolInput(name, b['input'], this.projectDir),
          state: 'running',
          startedAt: ts,
          endedAt: null,
          error: null
        }
        this.openTasks.set(task.id, task)
        this.emitEvent({ kind: 'task-start', task })
        if (name === 'Agent' || name === 'Task') {
          this.emitModel(this.models.agentStart(task.id, (b['input'] as { model?: unknown } | undefined)?.model))
        }

        if (name === 'ExitPlanMode') {
          const plan = (b['input'] as { plan?: unknown } | undefined)?.plan
          if (typeof plan === 'string' && plan.trim()) {
            this.emitEvent({ kind: 'plan', id: task.id, plan })
          }
        } else if (name === 'AskUserQuestion') {
          const q = parseQuestion(b['input'])
          if (q) this.emitEvent({ kind: 'question', id: task.id, ...q })
        } else if (name === 'TodoWrite') {
          const todos = parseTodos(b['input'])
          if (todos) this.emitEvent({ kind: 'todos', items: todos })
        } else if (name === 'TaskCreate' || name === 'TaskUpdate') {
          this.updateTaskPlan(name, b['input'])
        }
      }
    }
  }

  /**
   * Этот CLI ведёт план через TaskCreate/TaskUpdate, а не TodoWrite, поэтому
   * собираем список сами. TaskCreate не возвращает id в транскрипте, так что
   * ключом служит порядковый номер — он совпадает с id, который печатает инструмент.
   */
  private updateTaskPlan(name: string, input: unknown): void {
    if (typeof input !== 'object' || input === null) return
    const i = input as Record<string, unknown>

    if (name === 'TaskCreate') {
      const subject = typeof i['subject'] === 'string' ? i['subject'] : null
      if (!subject) return
      const id = String(this.taskPlan.size + 1)
      this.taskPlan.set(id, {
        content: subject,
        status: 'pending',
        ...(typeof i['activeForm'] === 'string' ? { activeForm: i['activeForm'] } : {})
      })
    } else {
      const id = typeof i['taskId'] === 'string' ? i['taskId'] : null
      if (!id) return
      const existing = this.taskPlan.get(id)
      if (!existing) return
      const status = i['status']
      if (status === 'deleted') {
        this.taskPlan.delete(id)
      } else if (status === 'pending' || status === 'in_progress' || status === 'completed') {
        this.taskPlan.set(id, { ...existing, status })
      }
      if (typeof i['subject'] === 'string') {
        const current = this.taskPlan.get(id)
        if (current) this.taskPlan.set(id, { ...current, content: i['subject'] })
      }
    }

    this.emitEvent({ kind: 'todos', items: [...this.taskPlan.values()] })
  }

  private handleUser(r: Record<string, unknown>): void {
    const message = r['message']
    if (typeof message !== 'object' || message === null) return
    const content = (message as Record<string, unknown>)['content']
    if (!Array.isArray(content)) return

    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue
      const b = block as Record<string, unknown>

      // После Esc CLI пишет «[Request interrupted by user…]», а turn_duration
      // приходит не всегда — без этого статус навсегда застревал бы в «работает».
      if (
        b['type'] === 'text' &&
        typeof b['text'] === 'string' &&
        b['text'].startsWith('[Request interrupted by user')
      ) {
        for (const [id] of this.openTasks) {
          this.emitEvent({ kind: 'task-end', id, state: 'error', error: 'прервано' })
        }
        this.openTasks.clear()
        this.emitModel(this.models.reset())
        this.emitEvent({ kind: 'turn-end' })
        continue
      }
      if (b['type'] !== 'tool_result' || typeof b['tool_use_id'] !== 'string') continue

      const id = b['tool_use_id']
      if (!this.openTasks.has(id)) continue
      this.openTasks.delete(id)
      this.emitModel(this.models.agentEnd(id))

      const isError = b['is_error'] === true
      const errorText = isError ? truncate(toolResultText(b['content']), 200) || 'ошибка' : null
      this.emitEvent({
        kind: 'task-end',
        id,
        state: isError ? 'error' : 'ok',
        error: errorText
      })
    }
  }
}
