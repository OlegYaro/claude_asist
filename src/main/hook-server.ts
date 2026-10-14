import http from 'node:http'
import { randomBytes } from 'node:crypto'
import { enabledPluginsSetting } from '../shared/plugins.ts'

/** Вход хуков — то, что Claude Code присылает POST-запросом. */
export interface PermissionRequestInput {
  session_id: string
  hook_event_name: 'PermissionRequest' | 'PreToolUse' | 'Stop' | 'UserPromptSubmit' | string
  tool_name: string
  tool_input: unknown
  tool_use_id?: string
  permission_mode?: string
  /** Stop: предыдущий Stop-хук уже не дал закончить. */
  stop_hook_active?: boolean
  /** Stop: последний ответ Claude текстом. */
  last_assistant_message?: string
}

/**
 * Решение по хуку; null — не решаем, Claude Code поступит как обычно.
 * `block` — только для Stop: не дать закончить, `reason` уходит Claude как задание.
 * `updatedInput` у `allow` — вход инструмента с ответом (AskUserQuestion: `answers`).
 */
export type PermissionDecision =
  | { behavior: 'allow'; updatedInput?: Record<string, unknown> }
  | { behavior: 'deny'; message: string }
  | { behavior: 'block'; reason: string }
  | null

export type PermissionHandler = (input: PermissionRequestInput) => Promise<PermissionDecision>

/** Лимиты подписки из JSON статус-строки Claude Code (`rate_limits`); окна может не быть. */
export interface RateLimitsStatus {
  sessionId: string
  fiveHour: { usedPercentage: number; resetsAt: number } | null
}

export type StatusHandler = (status: RateLimitsStatus) => void

/**
 * Принимает HTTP-хуки Claude Code. Запросы на разрешение приходят сюда, а не
 * в виде диалога в терминале, поэтому приложение может само дать согласие
 * (и показать, на что именно), не разбирая экран TUI.
 *
 * Слушаем только 127.0.0.1, в пути — случайный токен: другой процесс на машине
 * не сможет выдать себя за Claude Code и получить «allow» на свою команду.
 */
export class HookServer {
  private server: http.Server | null = null
  private port = 0
  private readonly token = randomBytes(16).toString('hex')
  private readonly handlers = new Map<string, PermissionHandler>()
  private statusHandler: StatusHandler | null = null

  async start(): Promise<void> {
    if (this.server) return
    const server = http.createServer((req, res) => void this.onRequest(req, res))
    // Ответ на план может ждать вас долго; таймауты Node (5 мин по умолчанию) обрывали бы его.
    server.requestTimeout = 0
    server.timeout = 0
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', () => resolve())
    })
    const addr = server.address()
    this.port = typeof addr === 'object' && addr ? addr.port : 0
    this.server = server
  }

  /** Получатель данных статус-строки (процент лимита); один на приложение. */
  onStatus(handler: StatusHandler | null): void {
    this.statusHandler = handler
  }

  /** Обработчик для конкретной сессии Claude (по session_id). */
  register(sessionId: string, handler: PermissionHandler): () => void {
    this.handlers.set(sessionId, handler)
    return () => this.handlers.delete(sessionId)
  }

  /**
   * Фрагмент настроек для `claude --settings`.
   *
   *  - PermissionRequest — когда Claude Code собирается спросить разрешение:
   *    приложение отвечает за вас (и держит план до «выполняй»);
   *  - PreToolUse — перед КАЖДОЙ командой и правкой, даже разрешёнными правилами
   *    (у вас в настройках `allow: ["Bash"]`): только так рискованную команду
   *    можно остановить до запуска, а точку отката — сделать до первой правки.
   *    Сюда же EnterPlanMode: Claude сам решил начать с плана; и Agent — какому
   *    субагенту и на какой модели отдан шаг (хуки его инструментов приходят
   *    с тем же session_id, так что правки субагентов тоже под контролем);
   *  - Stop — Claude хочет закончить: приложение запускает проверки проекта и
   *    ревью. Для Stop HTTP-хук не задокументирован, поэтому команда: curl
   *    пересылает вход сюда же и печатает наш ответ.
   *
   *  `plugins` — id плагинов из shared/plugins.ts, включённых на эту сессию.
   *
   * Таймаут большой: план, опасная команда и проверки ждут сколько нужно.
   */
  settingsJson(plugins: Iterable<string> = []): string {
    const url = `http://127.0.0.1:${this.port}/hook/${this.token}`
    const hook = { type: 'http', url, timeout: 3600 }
    const viaCurl = {
      type: 'command',
      command: `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- --max-time 3500 ${url}`,
      timeout: 3600
    }
    // Статус-строка нужна не для показа: Claude Code передаёт ей процент лимита подписки.
    // Ответ пустой, так что строка в терминале остаётся пустой.
    const statusLine = {
      type: 'command',
      command: `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- --max-time 5 http://127.0.0.1:${this.port}/status/${this.token}`
    }
    return JSON.stringify({
      // Серая подсказка следующей фразы в поле ввода склеивалась с нашим текстом,
      // Claude Code видел невидимый символ и вместо отправки просил «review and
      // press Enter» — команда стояла неотправленной. Советы под спиннером — шум.
      promptSuggestionEnabled: false,
      spinnerTipsEnabled: false,
      statusLine,
      // Плагины, выключенные в пользовательских настройках, включаются точечно на сессию.
      enabledPlugins: enabledPluginsSetting(plugins),
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [hook] }],
        PreToolUse: [
          { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode|Agent', hooks: [hook] }
        ],
        Stop: [{ hooks: [viaCurl] }],
        // Подтверждение, что сообщение действительно отправлено, а не застряло в поле.
        UserPromptSubmit: [{ hooks: [{ ...hook, timeout: 10 }] }]
      }
    })
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const isStatus = req.url === `/status/${this.token}`
    if (req.method !== 'POST' || (req.url !== `/hook/${this.token}` && !isStatus)) {
      res.writeHead(404).end()
      return
    }

    let body = ''
    req.setEncoding('utf8')
    for await (const chunk of req) {
      body += chunk
      if (body.length > 1_000_000) {
        res.writeHead(413).end()
        return
      }
    }

    if (isStatus) {
      try {
        const status = parseRateLimits(JSON.parse(body))
        if (status) this.statusHandler?.(status)
      } catch {
        // Не JSON — игнорируем: строка статуса всё равно пустая.
      }
      res.writeHead(200).end('')
      return
    }

    let decision: PermissionDecision = null
    let event = ''
    try {
      const input = JSON.parse(body) as PermissionRequestInput
      event = input.hook_event_name
      const handler = this.handlers.get(input.session_id)
      if (handler) decision = await handler(input)
    } catch {
      decision = null
    }

    // Пустой ответ 200 — «без решения»: Claude Code поступит как обычно.
    res.writeHead(200, { 'Content-Type': 'application/json' })
    if (!decision) {
      res.end('')
    } else if (decision.behavior === 'block') {
      // Stop: верхнеуровневое решение, а не hookSpecificOutput.
      res.end(event === 'Stop' ? JSON.stringify({ decision: 'block', reason: decision.reason }) : '')
    } else if (event === 'PreToolUse') {
      res.end(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: 'PreToolUse',
            permissionDecision: decision.behavior,
            ...(decision.behavior === 'deny' ? { permissionDecisionReason: decision.message } : {})
          }
        })
      )
    } else {
      res.end(JSON.stringify({ hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } }))
    }
  }

  stop(): void {
    this.server?.close()
    this.server = null
  }
}

/** Достаёт из JSON статус-строки id сессии и 5-часовое окно лимита; чужую форму отбрасывает. */
export function parseRateLimits(raw: unknown): RateLimitsStatus | null {
  if (typeof raw !== 'object' || raw === null) return null
  const r = raw as Record<string, unknown>
  if (typeof r['session_id'] !== 'string') return null
  const limits = r['rate_limits']
  const five = typeof limits === 'object' && limits !== null ? (limits as Record<string, unknown>)['five_hour'] : null
  let fiveHour: RateLimitsStatus['fiveHour'] = null
  if (typeof five === 'object' && five !== null) {
    const f = five as Record<string, unknown>
    if (typeof f['used_percentage'] === 'number' && typeof f['resets_at'] === 'number') {
      fiveHour = { usedPercentage: f['used_percentage'], resetsAt: f['resets_at'] }
    }
  }
  return { sessionId: r['session_id'], fiveHour }
}
