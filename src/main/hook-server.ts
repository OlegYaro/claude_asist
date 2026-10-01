import http from 'node:http'
import { randomBytes } from 'node:crypto'

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
   *    Сюда же EnterPlanMode: Claude сам решил начать с плана;
   *  - Stop — Claude хочет закончить: приложение запускает проверки проекта и
   *    ревью. Для Stop HTTP-хук не задокументирован, поэтому команда: curl
   *    пересылает вход сюда же и печатает наш ответ.
   *
   * Таймаут большой: план, опасная команда и проверки ждут сколько нужно.
   */
  settingsJson(): string {
    const url = `http://127.0.0.1:${this.port}/hook/${this.token}`
    const hook = { type: 'http', url, timeout: 3600 }
    const viaCurl = {
      type: 'command',
      command: `curl -s -X POST -H 'Content-Type: application/json' --data-binary @- --max-time 3500 ${url}`,
      timeout: 3600
    }
    return JSON.stringify({
      // Серая подсказка следующей фразы в поле ввода склеивалась с нашим текстом,
      // Claude Code видел невидимый символ и вместо отправки просил «review and
      // press Enter» — команда стояла неотправленной. Советы под спиннером — шум.
      promptSuggestionEnabled: false,
      spinnerTipsEnabled: false,
      hooks: {
        PermissionRequest: [{ matcher: '*', hooks: [hook] }],
        PreToolUse: [
          { matcher: 'Bash|Edit|Write|MultiEdit|NotebookEdit|EnterPlanMode', hooks: [hook] }
        ],
        Stop: [{ hooks: [viaCurl] }],
        // Подтверждение, что сообщение действительно отправлено, а не застряло в поле.
        UserPromptSubmit: [{ hooks: [{ ...hook, timeout: 10 }] }]
      }
    })
  }

  private async onRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== `/hook/${this.token}`) {
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
