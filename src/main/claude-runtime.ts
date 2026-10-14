import { EventEmitter } from 'node:events'
import { randomUUID } from 'node:crypto'
import * as pty from 'node-pty'
import { getLoginShellEnv, resolveClaudeBin } from './paths'
import { sessionProtocol } from './protocol'
import { APP_SESSION_NAME } from './history-logic'

/**
 * Размер PTY по умолчанию. Используется, пока ни одно окно Terminal.app
 * не сообщило свой реальный размер (или когда клиент — raw `nc` без SIGWINCH).
 */
export const DEFAULT_COLS = 120
export const DEFAULT_ROWS = 34

/** Сколько байт вывода держим для повторной отдачи при переприсоединении окна. */
const SCROLLBACK_BYTES = 512 * 1024

export interface ClaudeSessionOptions {
  projectDir: string
  /** Передаётся как `--permission-mode`; null — флаг не передаём вообще. */
  permissionMode: string | null
  /** Явный путь к бинарю из настроек. */
  claudeBinPath: string | null
  /** Дополнительные аргументы (например `--settings` с хуками). */
  extraArgs?: string[]
  /** Id плагинов, включённых на эту сессию (см. shared/plugins.ts). */
  enabledPlugins?: string[]
  /** Продолжить прошлую сессию с этим id (`--resume`) вместо новой. */
  resumeId?: string
  /** Передаётся как `--model`; null — модель по умолчанию из настроек Claude Code. */
  model: string | null
  /**
   * Автовыбор модели: в протоколе — правила распределения шагов по моделям, а
   * субагенты работают синхронно (`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS`): в фоне
   * Claude заканчивал бы ход раньше них, и проверки шли бы по недоделанной задаче.
   */
  autoModel: boolean
}

export class ClaudeNotFoundError extends Error {
  constructor() {
    super('Не найден бинарь claude')
    this.name = 'ClaudeNotFoundError'
  }
}

/**
 * Владелец PTY, в котором живёт интерактивный Claude Code.
 *
 * Ключевой момент архитектуры: PTY принадлежит приложению, а окна Terminal.app —
 * лишь клиенты, подключённые к нему через TerminalBridge. Поэтому отправка промта
 * это обычный `write()`, без AppleScript-инъекции нажатий клавиш.
 *
 * События: `data` (Buffer), `exit` ({ code, signal }).
 */
export class ClaudeSession extends EventEmitter {
  readonly sessionId: string
  readonly projectDir: string

  private proc: pty.IPty | null = null
  private scrollback: Buffer[] = []
  private scrollbackBytes = 0
  private cols = DEFAULT_COLS
  private rows = DEFAULT_ROWS
  private exited = false

  constructor(private readonly opts: ClaudeSessionOptions) {
    super()
    this.projectDir = opts.projectDir
    this.sessionId = opts.resumeId ?? randomUUID()
  }

  /** Режим автовыбора модели, с которым сессия запущена (настройка меняет только следующую). */
  get autoModel(): boolean {
    return this.opts.autoModel
  }

  get isRunning(): boolean {
    return this.proc !== null && !this.exited
  }

  async start(): Promise<void> {
    const bin = await resolveClaudeBin(this.opts.claudeBinPath)
    if (!bin) throw new ClaudeNotFoundError()

    const env = await getLoginShellEnv()

    const args = [
      // Без --fork-session `--resume` дописывает тот же транскрипт под тем же id —
      // на этом держатся хуки (регистрируются по id) и поиск транскрипта.
      this.opts.resumeId ? '--resume' : '--session-id',
      this.sessionId,
      '--name',
      APP_SESSION_NAME,
      // Протокол голосовой работы: русский язык, сам выбирай — ответить, сделать
      // или начать с плана, стандарты продакшен-качества. См. protocol.ts.
      '--append-system-prompt',
      sessionProtocol({ autoModel: this.opts.autoModel, enabledPlugins: this.opts.enabledPlugins })
    ]
    if (this.opts.model) args.push('--model', this.opts.model)
    if (this.opts.permissionMode) args.push('--permission-mode', this.opts.permissionMode)
    if (this.opts.extraArgs?.length) args.push(...this.opts.extraArgs)

    this.proc = pty.spawn(bin, args, {
      name: 'xterm-256color',
      cwd: this.projectDir,
      cols: this.cols,
      rows: this.rows,
      env: {
        ...(env as Record<string, string>),
        ...(this.opts.autoModel ? { CLAUDE_CODE_DISABLE_BACKGROUND_TASKS: '1' } : {})
      }
    })

    this.proc.onData((chunk) => {
      const buf = Buffer.from(chunk, 'utf8')
      this.pushScrollback(buf)
      this.emit('data', buf)
    })

    this.proc.onExit(({ exitCode, signal }) => {
      this.exited = true
      this.emit('exit', { code: exitCode, signal: signal ?? null })
    })
  }

  /** Байты в PTY как есть — используется мостом для проброса ввода из терминала. */
  write(data: Buffer | string): void {
    if (!this.proc || this.exited) return
    this.proc.write(typeof data === 'string' ? data : data.toString('utf8'))
  }

  /**
   * Отправка промта в TUI Claude Code.
   *
   * Многострочный текст нельзя писать как есть: каждый \n TUI трактует как Enter,
   * то есть отправит первую строку и потеряет остальные. По умолчанию нормализуем
   * в одну строку — это работает всегда. `bracketedPaste` включает escape-последовательности
   * вставки (\e[200~ … \e[201~), которые TUI понимает как единый paste.
   */
  submitPrompt(text: string, bracketedPaste = false): void {
    // Невидимые символы (zero-width, BOM) Claude Code считает подозрительными
    // и не отправляет текст по Enter — вырезаем их.
    const trimmed = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '').trim()
    if (!trimmed) return
    // Не «чистим» поле через Ctrl+U: Claude Code вставляет его как невидимый
    // символ, вырезает и требует ручного Enter («review and press Enter to send»).

    if (bracketedPaste && /\r?\n/.test(trimmed)) {
      this.write(`\x1b[200~${trimmed.replace(/\r\n/g, '\n')}\x1b[201~`)
      // Enter отдельно и с паузой: он должен попасть уже после закрытия paste-режима.
      setTimeout(() => this.write('\r'), 150)
      return
    }

    const oneLine = trimmed.replace(/\s*\r?\n\s*/g, '. ')
    // Enter — отдельно и с паузой: текст вместе с Enter одним куском TUI принимает
    // за вставку, и Enter становится частью текста, а не отправкой.
    this.write(oneLine)
    setTimeout(() => this.write('\r'), 150)
  }

  /** Esc — то же, чем пользователь прерывает Claude Code вручную. */
  interrupt(): void {
    this.write('\x1b')
  }

  resize(cols: number, rows: number): void {
    if (cols < 20 || rows < 5) return
    this.cols = cols
    this.rows = rows
    if (this.proc && !this.exited) {
      try {
        this.proc.resize(cols, rows)
      } catch {
        // PTY мог закрыться между проверкой и вызовом — не роняем приложение
      }
    }
  }

  get size(): { cols: number; rows: number } {
    return { cols: this.cols, rows: this.rows }
  }

  /** Накопленный вывод для нового клиента, чтобы он увидел текущее состояние экрана. */
  getScrollback(): Buffer {
    return Buffer.concat(this.scrollback)
  }

  kill(): void {
    if (!this.proc || this.exited) return
    try {
      this.proc.kill()
    } catch {
      // процесс уже мог умереть
    }
  }

  private pushScrollback(buf: Buffer): void {
    this.scrollback.push(buf)
    this.scrollbackBytes += buf.length
    while (this.scrollbackBytes > SCROLLBACK_BYTES && this.scrollback.length > 1) {
      const dropped = this.scrollback.shift()
      this.scrollbackBytes -= dropped ? dropped.length : 0
    }
  }
}
