import { EventEmitter } from 'node:events'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import { ClaudeSession, ClaudeNotFoundError } from './claude-runtime'
import { TerminalBridge, TerminalAutomationDeniedError } from './terminal-bridge'
import { TranscriptTailer, findTranscript } from './transcript'
import { HookServer } from './hook-server'
import { Assistant } from './assistant'
import { loadSettings, rememberProject } from './settings'
import { fileDiff, projectChanges, projectOverview } from './project-info'
import { listSessions, sessionTranscript } from './history'
import type {
  AppError,
  AssistantState,
  ChatMessage,
  HistorySession,
  ProjectChanges,
  ProjectOverview,
  SessionInfo,
  SessionStatus,
  TranscriptEvent
} from '../shared/types'

const IDLE_ASSISTANT: AssistantState = {
  phase: 'starting',
  plan: null,
  question: null,
  permission: null,
  needsInit: false,
  checkpoint: null,
  lastPlan: null,
  checks: [],
  review: null
}

/**
 * Единая точка владения активной сессией: PTY, мост до Terminal.app, tailer
 * транскрипта, сервер хуков и ассистент, который ведёт Claude Code.
 *
 * События:
 *   `session`    — SessionInfo изменился
 *   `transcript` — TranscriptEvent для чата и панели действий
 *   `history`    — TranscriptEvent (chat) из прошлой части продолженной сессии: только для окна
 *   `say`        — короткая фраза, которую стоит озвучить
 *   `error`      — AppError для показа в UI
 */
export class SessionManager extends EventEmitter {
  private session: ClaudeSession | null = null
  private bridge: TerminalBridge | null = null
  private tailer: TranscriptTailer | null = null
  private assistant: Assistant | null = null
  private unregisterHook: (() => void) | null = null
  private readonly hooks = new HookServer()

  private status: SessionStatus = 'stopped'
  private title: string | null = null
  private permissionMode: string | null = null
  private model: string | null = null
  private transcriptPath: string | null = null

  get info(): SessionInfo | null {
    if (!this.session) return null
    return {
      sessionId: this.session.sessionId,
      projectDir: this.session.projectDir,
      title: this.title,
      status: this.status,
      transcriptPath: this.transcriptPath,
      permissionMode: this.permissionMode,
      model: this.model,
      terminalAttached: (this.bridge?.attachedCount ?? 0) > 0,
      assistant: this.assistant?.state ?? IDLE_ASSISTANT
    }
  }

  /**
   * Запускает сессию в указанной папке, поднимает мост и (опционально) окно Terminal.
   * С `resumeId` продолжает прошлую сессию этого проекта: её переписка уходит в чат.
   */
  async start(projectDir: string, resumeId?: string): Promise<SessionInfo> {
    // Размер транскрипта — до запуска: всё, что CLI допишет после, уже не история.
    let historyBytes = 0
    if (resumeId) {
      const path = await sessionTranscript(projectDir, resumeId)
      const size = path ? await stat(path).then((s) => s.size, () => null) : null
      if (size === null) {
        this.fail({
          code: 'unknown',
          message: 'Не нашёл эту сессию',
          hint: 'Её транскрипт удалён или перенесён. Текущая сессия продолжает работать.'
        })
        throw new Error(`Транскрипт сессии ${resumeId} не найден`)
      }
      historyBytes = size
    }

    await this.stop()

    const settings = loadSettings()

    // Хуки — способ давать согласие без диалогов в терминале. Не поднялся
    // сервер — работаем без них: Claude Code просто спросит в терминале.
    let extraArgs: string[] = []
    try {
      await this.hooks.start()
      extraArgs = ['--settings', this.hooks.settingsJson()]
    } catch {
      extraArgs = []
    }

    const session = new ClaudeSession({
      projectDir,
      // Не авто-режим из глобальных настроек: его классификатор сам одобряет
      // план без вашего «выполняй». Согласия даёт хук приложения — по своим
      // правилам и с записью каждого в панель действий.
      permissionMode: settings.permissionMode ?? 'default',
      claudeBinPath: settings.claudeBinPath,
      extraArgs,
      ...(resumeId ? { resumeId } : {})
    })
    this.session = session
    this.permissionMode = settings.permissionMode
    this.title = null
    this.model = null
    this.transcriptPath = null

    // Ассистент подписывается на вывод PTY до старта, чтобы не пропустить
    // вопрос о доверии к папке, который появляется в первые секунды.
    const assistant = new Assistant(session, extraArgs.length > 0)
    this.assistant = assistant
    assistant.on('state', () => this.pushSession())
    assistant.on('action', (event: TranscriptEvent) => this.emit('transcript', event))
    assistant.on('say', (text: string) => this.emit('say', text))
    this.unregisterHook = this.hooks.register(session.sessionId, (input) =>
      assistant.onPermissionRequest(input)
    )

    try {
      await session.start()
    } catch (err) {
      this.disposeAssistant()
      this.session = null
      if (err instanceof ClaudeNotFoundError) {
        this.fail({
          code: 'claude-not-found',
          message: 'Не удалось найти исполняемый файл claude',
          hint: 'Укажите путь к нему вручную в настройках приложения.'
        })
      } else {
        this.fail({
          code: 'unknown',
          message: err instanceof Error ? err.message : 'Не удалось запустить Claude Code'
        })
      }
      throw err
    }

    this.setStatus('idle')
    rememberProject(projectDir)

    session.on('exit', () => {
      if (this.session !== session) return
      if (this.assistant?.state.phase === 'starting') {
        this.fail({
          code: 'unknown',
          message: 'Claude Code закрылся сразу после запуска',
          hint: 'Попробуйте открыть папку ещё раз. Если повторится — откройте терминал и посмотрите, что пишет Claude Code.'
        })
      }
      // Процесса больше нет: опрос транскрипта и придержанные хуки только висят.
      // Ассистента не обнуляем: точка отката, план, проверки и изменения задачи
      // должны оставаться видны в окне. Ввод после выхода не пройдёт — submit()
      // проверяет isRunning.
      this.tailer?.stop()
      this.tailer = null
      this.unregisterHook?.()
      this.unregisterHook = null
      this.assistant?.dispose()
      this.setStatus('stopped')
    })

    // Транскрипт подключаем раньше моста: без него в окне нет ни ответов, ни
    // действий, и он не должен зависеть от того, поднялся ли терминал.
    void this.attachTranscript(session, historyBytes)

    const bridge = new TerminalBridge(session)
    this.bridge = bridge
    bridge.on('attach', () => this.pushSession())
    bridge.on('detach', () => this.pushSession())
    try {
      await bridge.listen()
      if (settings.autoOpenTerminal) {
        // Окно терминала — удобство, а не обязательное условие.
        void this.openTerminal()
      }
    } catch (err) {
      this.bridge = null
      this.fail({
        code: 'unknown',
        message: 'Не удалось подготовить окно терминала',
        hint: err instanceof Error ? err.message : undefined
      })
    }

    const info = this.info
    if (!info) throw new Error('Сессия исчезла сразу после запуска')
    this.pushSession()
    return info
  }

  /** Открывает (или переоткрывает) окно Terminal.app, присоединённое к текущей сессии. */
  async openTerminal(): Promise<void> {
    if (!this.bridge || !this.session) return
    const label = `Claude — ${basename(this.session.projectDir)}`
    try {
      await this.bridge.openTerminalWindow(label)
    } catch (err) {
      if (err instanceof TerminalAutomationDeniedError) {
        const command = await this.bridge.attachCommand()
        this.fail({
          code: 'terminal-automation-denied',
          message: 'macOS запретил приложению открывать Terminal.app',
          hint: `Разрешите доступ в Системные настройки → Конфиденциальность и безопасность → Автоматизация, либо выполните в терминале вручную: ${command}`
        })
      } else {
        this.fail({
          code: 'unknown',
          message: err instanceof Error ? err.message : 'Не удалось открыть Terminal.app'
        })
      }
    }
  }

  /** Команда для присоединения вручную — UI показывает её как фолбэк. */
  async attachCommand(): Promise<string | null> {
    return this.bridge ? this.bridge.attachCommand() : null
  }

  /** Сказанное или напечатанное — решает ассистент: новая задача, «выполняй», замечание, стоп. */
  submit(text: string): void {
    if (!this.session?.isRunning || !this.assistant) return
    void this.assistant.handleUserText(text)
  }

  // ─── Панель «Проект» ───

  async overview(): Promise<ProjectOverview | null> {
    return this.session ? projectOverview(this.session.projectDir) : null
  }

  async changes(): Promise<ProjectChanges | null> {
    if (!this.session || !this.assistant) return null
    const base = this.assistant.changesBase
    return projectChanges(this.session.projectDir, base.sha, base.files)
  }

  // ─── Панель «История» ───

  async history(): Promise<HistorySession[]> {
    return this.session ? listSessions(this.session.projectDir) : []
  }

  /** Продолжить прошлую сессию того же проекта; текущая закрывается. */
  async resume(id: string): Promise<SessionInfo> {
    if (!this.session) throw new Error('Нет открытого проекта')
    const current = this.info
    if (current && id === current.sessionId) return current
    return this.start(this.session.projectDir, id)
  }

  async diff(path: string): Promise<string> {
    if (!this.session || !this.assistant) return ''
    return fileDiff(this.session.projectDir, this.assistant.changesBase.sha, path)
  }

  answerPermission(allow: boolean): void {
    this.assistant?.answerPermission(allow)
  }

  interrupt(): void {
    this.assistant?.interrupt()
  }

  async stop(): Promise<void> {
    this.tailer?.stop()
    this.tailer = null
    this.disposeAssistant()
    this.bridge?.shutdown()
    this.bridge = null
    this.session?.kill()
    this.session = null
    this.transcriptPath = null
    this.setStatus('stopped')
  }

  private disposeAssistant(): void {
    this.unregisterHook?.()
    this.unregisterHook = null
    this.assistant?.dispose()
    this.assistant = null
  }

  private async attachTranscript(session: ClaudeSession, historyBytes: number): Promise<void> {
    const alive = (): boolean => this.session === session && session.isRunning
    const path = await findTranscript(session.sessionId, session.projectDir, alive)
    // Сессия могла быть перезапущена или завершиться, пока мы ждали появления файла.
    if (!path || !alive()) return

    this.transcriptPath = path
    const tailer = new TranscriptTailer(path, session.projectDir, true, historyBytes)
    this.tailer = tailer

    // История — только в чат окна: ни ассистент, ни статус, ни Telegram-бот (он
    // слушает `transcript` и выдал бы старый ответ за новый) её видеть не должны.
    tailer.on('history', (message: ChatMessage) => this.emit('history', { kind: 'chat', message }))

    tailer.on('event', (event: TranscriptEvent) => {
      switch (event.kind) {
        case 'title':
          this.title = event.title
          this.pushSession()
          break
        case 'mode':
          if (event.permissionMode !== null) this.permissionMode = event.permissionMode
          if (event.model !== null) this.model = event.model
          this.pushSession()
          break
        case 'task-start':
          this.setStatus('working')
          break
        case 'turn-end':
          this.setStatus('idle')
          break
        default:
          break
      }
      this.assistant?.onTranscript(event)
      this.emit('transcript', event)
    })

    tailer.start()
    this.pushSession()
  }

  private setStatus(next: SessionStatus): void {
    if (this.status === next) return
    this.status = next
    this.pushSession()
  }

  private pushSession(): void {
    this.emit('session', this.info)
  }

  private fail(error: AppError): void {
    this.emit('error', error)
  }
}
