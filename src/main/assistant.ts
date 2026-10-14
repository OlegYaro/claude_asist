import { EventEmitter } from 'node:events'
import type { ClaudeSession } from './claude-runtime'
import type { PermissionDecision, PermissionRequestInput } from './hook-server'
import { summarizeToolInput } from './transcript'
import { loadSettings } from './settings'
import { hasApiKey } from './secrets'
import { buildPrompt } from './prompt-builder'
import {
  commitAll,
  commitMessage,
  createCheckpoint,
  detectChecks,
  ensureRepo,
  hasClaudeMd,
  isEmptyProject,
  runCheck,
  worktreeFingerprint,
  type CommitResult,
  type RepoInit
} from './quality'
import { checkCompletion, reviewChanges } from './reviewer'
import { completionReason, parsePlanModels, planEscalations, type StepModel } from './model-routing'
import { ROLLBACK_PROMPT_PREFIX } from './history-logic'
import {
  isApprove,
  isCancel,
  isInit,
  isRollback,
  isStop,
  parseOrdinal,
  parseOrdinals,
  parsePlanOverride
} from '../shared/intents'
import { answerFor, parseQuestions, type QuestionItem } from './questions'
import { parsePluginRequest } from '../shared/plugins'
import { isTuiReady } from './tui-ready'
import type {
  ActionKind,
  AssistantPhase,
  AssistantState,
  CheckRecord,
  PlanRecord,
  ReviewRecord,
  TokenUsage,
  TranscriptEvent
} from '../shared/types'

/** Сколько хвоста экрана TUI держим для распознавания диалогов. */
const SCREEN_TAIL = 8000
/** Сколько ждём, пока `/plan` включит режим планирования, прежде чем слать задачу. */
const PLAN_SWITCH_TIMEOUT_MS = 4000
/** Ответ держим не дольше таймаута хука (3600 с) — с запасом. */
const HOLD_TIMEOUT_MS = 3_500_000
/** Сколько ждём диалог на экране после того, как отпустили хук. */
const DIALOG_TIMEOUT_MS = 8000
/** Сколько ждём, что Claude Code принял отказ хука, прежде чем отвечать клавишами. */
const DENY_CONFIRM_MS = 3000
/** Сколько ждём подтверждения, что Claude Code принял сообщение. */
const SUBMIT_CONFIRM_MS = 2500
/** Сколько раз подряд проверки могут вернуть Claude к работе за одну задачу. */
const MAX_GATE_ROUNDS = 3
/** Сколько раз за задачу недоделанное по плану отдаётся модели сильнее. */
const MAX_ESCALATIONS = 2

/** Тип строки в «Действиях» для записей самого приложения. */
const ACTION_KIND: Record<string, ActionKind> = {
  Задача: 'task',
  Изучение: 'task',
  Согласие: 'approval',
  Проверка: 'check',
  Проверки: 'check',
  Ревью: 'review',
  План: 'plan',
  'Точка отката': 'checkpoint',
  Откат: 'checkpoint',
  Git: 'checkpoint',
  Ответ: 'question'
}

/** Инструменты, которые меняют файлы: после них нужны проверки и точка отката. */
const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])

/** Команды Bash, которые точно ничего не меняют, — проверки после них не нужны. */
const READONLY_BASH =
  /^\s*(ls|cat|head|tail|less|grep|rg|find|fd|pwd|echo|printf|wc|which|whoami|date|tree|file|stat|du|df|env|node\s+-v|npm\s+(ls|view|-v)|git\s+(status|log|diff|show|branch|remote|rev-parse|blame))\b[^;&|>]*$/

/**
 * Команды, на которые согласие автоматически не даём: их последствия трудно
 * откатить. Приложение озвучит запрос и подождёт вашего «да».
 */
const DANGEROUS_BASH = [
  /\brm\s+(-\w*\s+)*-\w*[rR]\w*f|\brm\s+(-\w*\s+)*-\w*f\w*[rR]/,
  /\bsudo\b/,
  /\bgit\s+push\b.*(--force|\s-f\b)/,
  /\bgit\s+reset\s+--hard\b/,
  /\bgit\s+clean\s+-\w*f/,
  /\bmkfs\b|\bdd\s+if=/,
  /\bchmod\s+-R\s+777\b/,
  /\b(curl|wget)\b[^|]*\|\s*(sudo\s+)?(ba|z)?sh\b/,
  /\bdrop\s+(table|database)\b/i
]

function isDangerous(tool: string, input: unknown): boolean {
  if (tool !== 'Bash') return false
  const command = (input as { command?: unknown } | null)?.command
  return typeof command === 'string' && DANGEROUS_BASH.some((re) => re.test(command))
}

/** Без ANSI и пробелов: TUI рисует текст кусками, а нам нужно лишь найти фразу. */
function flatten(text: string): string {
  return text
    .replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-9;?<>=]*[ -/]*[@-~]/g, '')
    .replace(/\x1b[()][A-Z0-9]/g, '')
    .replace(/\s+/g, '')
}

function questionHint(item: QuestionItem): string {
  return item.multiSelect ? 'Назовите номера вариантов.' : 'Назовите номер варианта.'
}

/**
 * Придержанный хук ExitPlanMode / AskUserQuestion: Claude Code ждёт его ответа,
 * а приложение — вашего. `since` копит экран с момента, как хук пришёл: TUI
 * перерисовывает только изменения, поэтому однажды нарисованный диалог больше
 * не приходит текстом — искать его надо во всём, что пришло после.
 */
interface Gate {
  tool: string
  since: string
  resolve: (decision: PermissionDecision) => void
}

/**
 * Ведёт сессию Claude Code вместо человека за клавиатурой.
 *
 * Задача → `/plan` → оформленный промт → Claude исследует и вызывает ExitPlanMode →
 * хук приносит план сразу, и приложение держит его, пока вы не ответите:
 * «выполняй» — отпускаем и жмём «1» в диалоге одобрения, замечание — отказ хука
 * с текстом замечания (Claude дорабатывает план). Остальные запросы разрешений
 * одобряются хуком автоматически, кроме опасных команд.
 *
 * События: `state` (AssistantState), `action` (TranscriptEvent для панели действий), `say` (string).
 */
export class Assistant extends EventEmitter {
  private phase: AssistantPhase = 'starting'
  private plan: string | null = null
  private planToolId: string | null = null
  /**
   * Вопросы Claude идут по одному; ответы копятся и уходят хуком все сразу.
   * `input` — вход инструмента для ответа хуком; null — вопрос пришёл из
   * транскрипта (хука нет), отвечаем клавишами в диалоге.
   */
  private question: {
    id: string
    items: QuestionItem[]
    index: number
    answers: Record<string, string>
    input: Record<string, unknown> | null
  } | null = null
  private phaseBeforeQuestion: AssistantPhase = 'planning'
  private gate: Gate | null = null
  private held: {
    tool: string
    summary: string
    resolve: (d: PermissionDecision) => void
  } | null = null

  private screen = ''
  private trustAnswered = false
  /** Пока идёт ответ на диалог доверия, экран с его рамкой не считается готовым. */
  private trustPending = false
  private queue: string[] = []
  private actionSeq = 0
  private reviewSeq = 0
  private busy = false
  /** Сколько сообщений Claude Code подтвердил хуком UserPromptSubmit. */
  private submitted = 0

  /**
   * Состояние текущей задачи. Живёт от вашей команды до следующей, а не до конца
   * хода: ход может продолжиться (результат субагента, повтор после проверок), и
   * точка отката должна остаться той, что была ДО задачи.
   */
  private task = newTask()
  /** Точка отката последней задачи с правками — для «откати». */
  private checkpoint: string | null = null
  /** Файлы, которые правил Claude в последней задаче с правками (для проектов без git). */
  private lastChangedFiles: string[] = []
  private lastPlan: PlanRecord | null = null
  private checks: CheckRecord[] = []
  private review: ReviewRecord | null = null
  private needsInit = false
  /** Отмена идущих проверок и ревью по «стоп». */
  private gateAbort: AbortController | null = null
  /** Сколько раз прерывали — задача, которая ещё готовилась, по нему видит «стоп». */
  private interrupts = 0
  /** Создание репозитория при открытии проекта: отпечаток и точка отката ждут его. */
  private repoReady: Promise<void> = Promise.resolve()

  /**
   * @param hooks сессия запущена с HTTP-хуком: план и вопросы приходят через него,
   *   а транскрипт (он пишется с задержкой) для них не нужен — иначе дубли.
   */
  constructor(
    private readonly session: ClaudeSession,
    private readonly hooks: boolean
  ) {
    super()
    session.on('data', (buf: Buffer) => this.onScreen(buf.toString('utf8')))
  }

  get state(): AssistantState {
    return {
      phase: this.phase,
      plan: this.plan,
      question: this.currentQuestion
        ? {
            question: this.currentQuestion.question,
            options: this.currentQuestion.options,
            multiSelect: this.currentQuestion.multiSelect,
            index: this.question?.index ?? 0,
            total: this.question?.items.length ?? 1
          }
        : null,
      permission: this.held ? { tool: this.held.tool, summary: this.held.summary } : null,
      needsInit: this.needsInit,
      checkpoint: this.checkpoint ? this.checkpoint.slice(0, 8) : null,
      lastPlan: this.lastPlan,
      checks: this.checks,
      review: this.review
    }
  }

  private get currentQuestion(): QuestionItem | null {
    return this.question?.items[this.question.index] ?? null
  }

  /** Для панели «Проект»: с какой точки считать изменения и какие файлы правились. */
  get changesBase(): { sha: string | null; files: string[] } {
    return { sha: this.checkpoint, files: this.lastChangedFiles }
  }

  // ───────────────────── Ввод пользователя ─────────────────────

  /** Всё, что пользователь сказал или напечатал, приходит сюда. */
  async handleUserText(raw: string): Promise<void> {
    const text = raw.trim()
    if (!text) return

    if (isStop(text) && this.phase !== 'ready' && this.phase !== 'starting') {
      this.interrupt()
      return
    }

    switch (this.phase) {
      case 'starting':
        // Claude ещё запускается — отправим, как только он будет готов.
        this.queue.push(text)
        return

      case 'plan-ready':
        if (isApprove(text)) return this.approvePlan()
        if (isCancel(text)) {
          this.interrupt()
          return
        }
        return this.sendPlanFeedback(text)

      case 'question': {
        const item = this.currentQuestion
        if (!item) return
        if (!this.question?.input) {
          // Без хука отвечаем в диалоге TUI; последний номер там — «свой вариант».
          const n = parseOrdinal(text)
          if (n !== null && n <= item.options.length + 1) return this.answerQuestionByKeys(n)
        } else {
          const single = parseOrdinal(text)
          const nums = item.multiSelect ? parseOrdinals(text) : single === null ? null : [single]
          const answer = nums && answerFor(item, nums)
          if (answer) return this.answerQuestion(item, answer)
        }
        this.say(questionHint(item))
        return
      }

      case 'permission':
        if (isApprove(text)) return this.resolveHeld(true)
        if (isCancel(text)) return this.resolveHeld(false)
        this.say('Скажите «да» или «нет».')
        return

      case 'planning':
      case 'executing':
        // Задача ещё готовится (промт, /plan) — эта фраза уйдёт следом за ней.
        if (this.busy) {
          this.queue.push(text)
          return
        }
        // Claude Code сам поставит сообщение в очередь и учтёт его по ходу работы.
        void this.sendPrompt(text)
        return

      case 'checking':
        this.say('Идут проверки — подождите или скажите «стоп».')
        return

      case 'ready':
        if (isInit(text)) return this.runInit()
        if (isRollback(text)) return this.rollback()
        return this.startTask(text)
    }
  }

  /**
   * Новая задача. Обёртки нет: как действовать (ответить, сделать сразу или
   * начать с плана), Claude решает сам по протоколу из системного промта сессии.
   * Приложение вмешивается, только если вы сказали явно («с планом» / «просто сделай»)
   * или в настройках выбрано «план всегда» / «никогда».
   */
  private async startTask(raw: string): Promise<void> {
    // Прошлая задача ещё готовится (например, её прервали «стоп») — эта фраза
    // станет новой задачей, как только та отпустит.
    if (this.busy) {
      this.queue.push(raw)
      return
    }
    this.busy = true
    // Сразу видно, что задача принята, — до подготовки (отпечаток git, промт).
    this.setPhase('executing')
    const interrupts = this.interrupts
    const cancelled = (): boolean => this.interrupts !== interrupts
    try {
      this.logAction('Задача', raw)
      const settings = loadSettings()
      const override = parsePlanOverride(raw)
      const mode = override.mode ?? (settings.planMode === 'always' ? 'plan' : settings.planMode === 'never' ? 'direct' : null)

      // Отпечаток дерева и уточнение формулировки друг от друга не зависят.
      let [, task] = await Promise.all([this.beginTask(raw), this.refinePrompt(override.rest)])
      // «Стоп», пока готовились: задачу не отправляем.
      if (cancelled()) return

      if (mode === 'plan') {
        this.setPhase('planning')
        const switched = this.waitForScreen(
          (s) => s.includes('planmodeon') || s.includes('Enabledplanmode'),
          PLAN_SWITCH_TIMEOUT_MS
        )
        this.session.write('/plan')
        await delay(300)
        this.session.write('\r')
        await switched
        await delay(500)
        if (cancelled()) return
        this.logAction('План', 'по вашей просьбе — сначала план')
      } else {
        this.setPhase('executing')
        if (mode === 'direct') task = `Без плана — сделай сразу. ${task}`
      }

      await this.sendPrompt(task)
    } finally {
      this.busy = false
      // Сказанное, пока задача готовилась, — по текущей фазе: следом за задачей
      // или, если её прервали, новой задачей. Сказанное до «стоп» тот уже выбросил.
      const queued = this.queue.splice(0)
      if (queued.length) void this.handleUserText(queued.join('. '))
    }
  }

  /** С API-ключом чистим расшифровку моделью от оговорок распознавания. */
  private async refinePrompt(text: string): Promise<string> {
    if (!hasApiKey()) return text
    this.logAction('Промт', 'уточняю формулировку')
    try {
      return (await buildPrompt({ transcript: text, projectDir: this.session.projectDir, todos: [], recentMessages: [] }))
        .prompt
    } catch {
      return text
    }
  }

  /** «Изучи проект» — встроенная команда /init: Claude пишет CLAUDE.md проекта. */
  private runInit(): void {
    void this.beginTask('изучи проект и создай CLAUDE.md')
    this.setPhase('executing')
    this.needsInit = false
    this.logAction('Изучение', 'изучи проект — Claude пишет CLAUDE.md, память проекта')
    this.session.write('/init')
    setTimeout(() => this.session.write('\r'), 300)
  }

  /** «Откати» — Claude возвращает файлы к точке отката, показав, что удалит. */
  private rollback(): void {
    if (!this.checkpoint) {
      this.say('Точки отката нет.')
      this.logAction('Откат', 'точки отката нет — в проекте нет git или ещё не было правок', true)
      return
    }
    const sha = this.checkpoint
    // Откат — тоже задача с правками: проверки пусть будут, ревью не нужно.
    void this.beginTask('откат к точке').then(() => (this.task.reviewed = true))
    this.setPhase('executing')
    this.logAction('Задача', `откатить изменения к точке ${sha.slice(0, 8)}`)
    void this.sendPrompt(
      `${ROLLBACK_PROMPT_PREFIX} ${sha}: выполни git restore --source=${sha} --staged --worktree -- . и удали неотслеживаемые файлы, созданные после неё (сначала покажи их список). Потом коротко скажи, что вернул.`
    )
  }

  /** Новая задача: сбросить состояние и запомнить, как выглядело дерево до неё. */
  private async beginTask(text: string): Promise<void> {
    this.task = newTask()
    this.task.text = text
    await this.repoReady
    this.task.fingerprint = await worktreeFingerprint(this.session.projectDir)
  }

  /**
   * Папка без git получает репозиторий и первый коммит — до первой задачи,
   * иначе у неё не было бы ни точки отката, ни диффа для ревью.
   */
  prepareRepo(): void {
    if (!loadSettings().autoGit) return
    this.repoReady = ensureRepo(this.session.projectDir).then(
      (result) => this.logRepo(result),
      (err: unknown) => console.error('[assistant] git init:', err)
    )
  }

  private logRepo(result: RepoInit): void {
    if (result.kind === 'exists') return
    if (result.kind !== 'created') {
      this.logAction('Git', result.note, result.kind === 'failed')
      return
    }
    this.logAction('Git', `создан репозиторий${result.gitignore ? ' и .gitignore' : ''}`)
    if (result.commit) this.logCommit(result.commit)
  }

  /** Задача с правками прошла проверки и ревью — её результат уходит в коммит. */
  private async commitTask(): Promise<void> {
    if (!this.task.commitReady || this.task.committed || this.task.fingerprint === null) return
    if (!loadSettings().autoGit) return
    this.task.committed = true
    this.logCommit(await commitAll(this.session.projectDir, commitMessage(this.task.text)))
  }

  private logCommit(result: CommitResult): void {
    if (result.kind === 'committed') this.logAction('Git', `коммит ${result.sha}`)
    else if (result.kind === 'failed') this.logAction('Git', `не закоммитил: ${result.note}`, true)
    else if (result.kind === 'too-many') {
      this.logAction(
        'Git',
        `не закоммитил: ${result.count} новых файлов — та ли это папка? Лишнее добавьте в .gitignore`,
        true
      )
    }
    else if (result.kind === 'secrets') {
      this.logAction('Git', `не закоммитил: похоже на ключ или токен в ${result.files.join(', ')}`, true)
      this.say('Не стал коммитить: в изменениях похоже на секретный ключ.')
    }
  }

  /**
   * Были ли в задаче правки. Правка файла инструментом — точно да. Остальное
   * (команды Bash) — по факту: изменился ли отпечаток git-дерева. Без git —
   * по догадке о команде.
   */
  private async taskChangedFiles(): Promise<boolean> {
    if (this.task.edited) return true
    if (!this.task.bashRan) return false
    if (this.task.fingerprint === null) return this.task.bashMaybeChanged
    return (await worktreeFingerprint(this.session.projectDir)) !== this.task.fingerprint
  }

  /** Ход закончен: Stop-хук отпустил Claude (транскрипт об этом пишет с задержкой). */
  private finishTurn(quiet = false): void {
    // Ход не закончен, только если диалог (план, вопрос, согласие) реально ждёт ответа.
    if (this.gate || this.held) return
    if (this.phase === 'ready' || this.phase === 'starting') return
    this.plan = null
    this.question = null
    this.setPhase('ready')
    if (!quiet) this.say('Готово.')
  }

  /** План остаётся в чате отдельной карточкой и в панели «Проект» — и после одобрения. */
  private recordPlan(text: string): void {
    const at = Date.now()
    this.lastPlan = { text, status: 'waiting', at }
    this.emit('action', {
      kind: 'chat',
      message: { id: `plan:${at}`, role: 'assistant', text, at, variant: 'plan' }
    } satisfies TranscriptEvent)
  }

  private setPlanStatus(status: PlanRecord['status']): void {
    if (!this.lastPlan) return
    this.lastPlan = { ...this.lastPlan, status }
    this.emit('state', this.state)
  }

  /** Claude Code сообщил хуком UserPromptSubmit, что принял сообщение. */
  onPromptSubmitted(): void {
    this.submitted++
  }

  /**
   * Отправить сообщение и убедиться, что Claude Code его принял. Иногда TUI не
   * принимает Enter (поле было занято, шёл перерисовка после хука), и команда
   * стояла в поле, пока человек не нажмёт Enter сам. Подтверждение — хук
   * UserPromptSubmit; нет его — жмём Enter, потом вводим заново.
   */
  private async sendPrompt(text: string): Promise<void> {
    const multiline = /\n/.test(text)
    const before = this.submitted
    this.session.submitPrompt(text, multiline)
    if (!this.hooks) return

    const accepted = (): Promise<boolean> => this.poll(() => this.submitted > before, SUBMIT_CONFIRM_MS)
    if (await accepted()) return
    // Повторяем только Enter: повторный ввод дописал бы текст ко второму экземпляру.
    for (let attempt = 0; attempt < 2; attempt++) {
      this.session.write('\r')
      if (await accepted()) {
        this.logAction('Отправка', 'Claude Code принял сообщение со второй попытки')
        return
      }
    }
    this.logAction('Отправка', 'Claude Code не принял сообщение — посмотрите окно терминала', true)
    this.say('Сообщение не ушло. Посмотрите терминал.')
  }

  // ───────────────────── План ─────────────────────

  private async approvePlan(): Promise<void> {
    this.task.plan = this.plan
    this.setPlanStatus('approved')
    this.plan = null
    this.setPhase('executing')
    this.logAction('План', 'одобрен — выполняю')
    // Хук для ExitPlanMode решение «allow» не принимает — подтверждает только диалог.
    // Выбираем «Yes, manually approve edits», а не «use auto mode»: в авто-режиме
    // классификатор Claude Code сам разрешает даже rm -rf, минуя приложение.
    // В ручном режиме каждое разрешение идёт через наш хук — с вашими правилами.
    const gate = this.gate?.tool === 'ExitPlanMode' ? this.gate : null
    if (await this.openDialog('ExitPlanMode', 'Wouldyouliketoproceed')) {
      const seen = gate ? gate.since : this.screen
      const manual = /(\d)\.Yes,manuallyapprove/.exec(seen)?.[1] ?? '2'
      this.session.write(manual)
    }
  }

  private async sendPlanFeedback(text: string): Promise<void> {
    this.setPlanStatus('revising')
    this.plan = null
    this.setPhase('planning')
    this.logAction('План', `замечание: ${text}`)
    const message = `Пользователь просит изменить план: ${text}`

    const gate = this.takeGate('ExitPlanMode')
    if (gate) {
      // Отказ хука с текстом замечания — Claude получает его и дорабатывает план.
      gate.resolve({ behavior: 'deny', message })
      // Claude Code печатает «Denied by PermissionRequest hook».
      if (await this.waitIn(gate, (s) => s.includes('DeniedbyPermissionRequesthook'), DENY_CONFIRM_MS)) {
        return
      }
      // Отказ не сработал и диалог ждёт — отвечаем в нём клавишами.
      if (!(await this.waitIn(gate, (s) => s.includes('Wouldyouliketoproceed'), DIALOG_TIMEOUT_MS))) return
    }
    // «3» — «Tell Claude what to change»: дальше поле для замечания.
    this.session.write('3')
    await delay(500)
    this.session.write(text.replace(/\s*\r?\n\s*/g, ' '))
    await delay(200)
    this.session.write('\r')
  }

  /**
   * Ответ на текущий вопрос. Пока есть следующие — показываем их; ответ на
   * последний отпускает хук со всеми ответами: диалог в терминале не появляется.
   */
  private answerQuestion(item: QuestionItem, answer: string): void {
    const q = this.question
    if (!q?.input) return
    q.answers[item.question] = answer
    this.logAction('Ответ', `${item.question} — ${answer}`)
    if (q.index + 1 < q.items.length) {
      q.index++
      this.emit('state', this.state)
      const next = this.currentQuestion
      if (next) this.say(`Следующий вопрос. ${questionHint(next)}`)
      return
    }
    const gate = this.takeGate('AskUserQuestion')
    this.question = null
    this.setPhase(this.phaseBeforeQuestion === 'question' ? 'executing' : this.phaseBeforeQuestion)
    if (gate) {
      gate.resolve({ behavior: 'allow', updatedInput: { ...q.input, answers: q.answers } })
    } else {
      // Хук отпущен по таймауту — диалог уже в терминале.
      this.logAction('Ответ', 'вопрос ждал слишком долго — ответьте в окне терминала', true)
    }
  }

  /** Запасной путь без хука: номер варианта в диалоге TUI. */
  private async answerQuestionByKeys(n: number): Promise<void> {
    if (!this.question) return
    this.logAction('Ответ', `вариант ${n}`)
    const first = flatten(this.currentQuestion?.options[0] ?? '')
    if (await this.openDialog('AskUserQuestion', first || 'Entertoselect')) {
      this.session.write(String(n))
    }
    // Не ждём подтверждения из транскрипта (он пишется с задержкой): вопрос закрыт.
    this.question = null
    this.setPhase(this.phaseBeforeQuestion === 'question' ? 'executing' : this.phaseBeforeQuestion)
  }

  /**
   * Отпускает придержанный хук без решения и ждёт, пока диалог будет на экране.
   * Без хука (сервер не поднялся) диалог уже на экране — жмём сразу.
   */
  private async openDialog(tool: string, marker: string): Promise<boolean> {
    const gate = this.takeGate(tool)
    if (!gate) return true
    gate.resolve(null)
    const ok = await this.waitIn(gate, (s) => s.includes(marker), DIALOG_TIMEOUT_MS)
    if (!ok) {
      this.logAction('Диалог', 'не появился на экране — ответьте в окне терминала', true)
      return false
    }
    await delay(300)
    return true
  }

  interrupt(): void {
    this.interrupts++
    // Фразы, ждавшие подготовки прерванной задачи, относились к ней.
    this.queue.length = 0
    this.gateAbort?.abort()
    if (this.held) this.resolveHeld(false)
    if (this.lastPlan?.status === 'waiting') this.setPlanStatus('cancelled')
    const gate = this.gate
    this.gate = null
    gate?.resolve({ behavior: 'deny', message: 'Пользователь отменил задачу.' })
    // Esc с паузой: после отказа хука Claude Code ещё дорисовывает экран.
    setTimeout(() => this.session.interrupt(), gate ? 600 : 0)
    this.plan = null
    this.question = null
    this.logAction('Стоп', 'прервано по вашей команде')
    this.setPhase('ready')
  }

  // ───────────────────── Разрешения (HTTP-хук) ─────────────────────

  async onPermissionRequest(input: PermissionRequestInput): Promise<PermissionDecision> {
    const tool = input.tool_name
    const summary = summarizeToolInput(tool, input.tool_input, this.session.projectDir)

    if (input.hook_event_name === 'Stop') return this.onStop(input.last_assistant_message)
    if (input.hook_event_name === 'UserPromptSubmit') {
      this.onPromptSubmitted()
      return null
    }
    if (input.hook_event_name === 'PreToolUse') return this.onPreToolUse(tool, input.tool_input, summary)

    if (tool === 'ExitPlanMode') return this.holdForPlan(input)
    if (tool === 'AskUserQuestion') return this.holdForQuestion(input)
    if (!loadSettings().autoApprove) return null

    // Рискованную Bash-команду вы уже одобрили в PreToolUse — здесь только запись.
    this.logAction('Согласие', `${tool}: ${summary}`)
    return { behavior: 'allow' }
  }

  /**
   * Перед каждой правкой и командой: Claude сам решил начать с плана; задача
   * меняет файлы — запомнить и до первой правки сделать точку отката; рискованная
   * команда — держать до вашего «да». Остальным решения не даём.
   */
  private async onPreToolUse(tool: string, input: unknown, summary: string): Promise<PermissionDecision> {
    if (tool === 'EnterPlanMode') {
      this.setPhase('planning')
      this.logAction('План', 'Claude решил сначала составить план')
      return null
    }
    if (tool === 'Agent') {
      const agent = input as { description?: unknown; model?: unknown } | null
      const what = typeof agent?.description === 'string' ? agent.description : 'шаг задачи'
      const model = typeof agent?.model === 'string' ? agent.model : 'модель сессии'
      this.logAction('Субагент', `${what} · ${model}`)
      return null
    }

    const command = (input as { command?: unknown } | null)?.command
    const readOnly = tool === 'Bash' && typeof command === 'string' && READONLY_BASH.test(command)
    if (EDIT_TOOLS.has(tool)) {
      this.task.edited = true
      const file = (input as { file_path?: unknown; notebook_path?: unknown } | null)
      const path = file?.file_path ?? file?.notebook_path
      if (typeof path === 'string') this.task.files.add(path)
    }
    if (tool === 'Bash') {
      this.task.bashRan = true
      if (!readOnly) this.task.bashMaybeChanged = true
    }
    // Точку отката делаем молча ДО первой команды, которая может что-то поменять;
    // показываем её, только когда правки в задаче подтвердятся.
    if (!readOnly && this.task.pendingCheckpoint === undefined) {
      await this.repoReady
      this.task.pendingCheckpoint = await createCheckpoint(this.session.projectDir)
    }

    return isDangerous(tool, input) ? this.holdDangerous(tool, summary) : null
  }

  /**
   * Claude хочет закончить. Если в задаче были правки — запускаем проверки проекта;
   * красные — не даём закончить и отдаём Claude вывод ошибок. Зелёные — один раз
   * просим независимое ревью субагентом. Так «готово» значит «проверено».
   */
  private async onStop(lastMessage?: string): Promise<PermissionDecision> {
    // Claude просит подключить плагин и закончил ход: задача продолжится после
    // перезапуска, так что ни проверки, ни ревью, ни коммит сейчас не нужны.
    if (lastMessage && parsePluginRequest(lastMessage).plugin) {
      this.finishTurn(true)
      return null
    }
    const decision = await this.qualityGate()
    if (!decision) {
      await this.commitTask()
      this.finishTurn()
    }
    return decision
  }

  /**
   * После «стоп» проверки и ревью отменяются (их процессы убиваются), а итог
   * отбрасывается: иначе красная проверка вернула бы Claude к работе.
   */
  private async qualityGate(): Promise<PermissionDecision> {
    this.gateAbort?.abort()
    const abort = new AbortController()
    this.gateAbort = abort
    try {
      return await this.runQualityGate(abort.signal)
    } finally {
      if (this.gateAbort === abort) this.gateAbort = null
    }
  }

  private async runQualityGate(signal: AbortSignal): Promise<PermissionDecision> {
    const settings = loadSettings()
    if (!(await this.taskChangedFiles()) || signal.aborted) return null

    // Правки подтвердились — теперь точка отката задачи доступна для «откати».
    if (this.task.pendingCheckpoint && !this.task.checkpointShown) {
      this.task.checkpointShown = true
      this.checkpoint = this.task.pendingCheckpoint
      this.lastChangedFiles = [...this.task.files]
      this.logAction('Точка отката', `${this.checkpoint.slice(0, 8)} — скажите «откати», чтобы вернуть`)
      this.emit('state', this.state)
    }
    if (!settings.qualityGate) {
      this.task.commitReady = true
      return null
    }

    if (this.task.gateRounds >= MAX_GATE_ROUNDS) {
      this.logAction('Проверки', `не позеленели за ${MAX_GATE_ROUNDS} попытки — посмотрите сами`, true)
      this.say('Проверки так и не прошли. Посмотрите отчёт.')
      return null
    }

    const prev = this.phase
    this.setPhase('checking')
    const dir = this.session.projectDir
    const checks = detectChecks(dir)
    const failed: string[] = []

    if (checks.length === 0) {
      if (this.task.gateRounds === 0) this.logAction('Проверки', 'в проекте не нашлось тестов, типов или линтера')
    }
    const records: CheckRecord[] = []
    for (const check of checks) {
      const result = await runCheck(dir, check, signal)
      if (signal.aborted) return null
      records.push({
        name: check.name,
        command: check.command,
        status: result.skipped ? 'skipped' : result.ok ? 'ok' : 'failed',
        ms: result.ms,
        at: Date.now()
      })
      const time = `${(result.ms / 1000).toFixed(1)} с`
      if (result.skipped) {
        this.logAction('Проверка', `${check.name}: ${check.command} — инструмент не установлен`)
      } else if (result.ok) {
        this.logAction('Проверка', `${check.name} ✓ ${check.command} · ${time}`)
      } else {
        this.logAction('Проверка', `${check.name} ✕ ${check.command} · ${time}`, true)
        failed.push(`$ ${check.command} (код ${result.code ?? '—'})\n${result.output}`)
      }
    }

    this.checks = records
    this.setPhase(prev === 'checking' ? 'executing' : prev)

    if (failed.length) {
      this.task.gateRounds++
      this.say('Проверки не прошли — Claude исправляет.')
      return {
        behavior: 'block',
        reason: `Проверки проекта не прошли:\n\n${failed.join('\n\n')}\n\nИсправь причину — не подавляй ошибки и не отключай проверки, — затем снова запусти эти проверки и убедись, что они зелёные.`
      }
    }

    if (this.session.autoModel && this.task.plan && !this.task.complete) {
      const decision = await this.checkPlanCompletion(this.task.plan, signal)
      if (signal.aborted) return null
      if (decision) return decision
    }

    if (settings.autoReview && !this.task.reviewed) {
      this.task.reviewed = true
      const before = this.phase
      this.setPhase('checking')
      this.logAction('Ревью', 'независимый ревьюер изучает изменения…')
      const { issues, usage, model } = await reviewChanges(
        {
          dir,
          task: this.task.text,
          plan: this.task.plan,
          baseSha: this.task.pendingCheckpoint ?? null,
          files: [...this.task.files]
        },
        signal
      )
      this.logUsage('Ревью', usage, model)
      if (signal.aborted) return null
      this.setPhase(before === 'checking' ? 'executing' : before)

      if (issues !== null) {
        this.review = { ok: issues.length === 0, issues: issues.map((i) => ({ file: i.file, problem: i.problem })), at: Date.now() }
        this.emit('state', this.state)
      }
      if (issues === null) {
        this.logAction('Ревью', 'не удалось провести — продолжаю без него', true)
      } else if (issues.length === 0) {
        this.logAction('Ревью', 'существенных замечаний нет ✓')
      } else {
        this.task.gateRounds++
        for (const issue of issues) this.logAction('Ревью', `${issue.file}: ${issue.problem}`, true)
        this.say('Ревью нашло замечания — Claude исправляет.')
        const list = issues.map((i) => `- ${i.file}: ${i.problem}\n  Как исправить: ${i.fix}`).join('\n')
        return {
          behavior: 'block',
          reason: `Независимое ревью нашло существенные проблемы:\n${list}\n\nИсправь их, затем снова запусти проверки проекта и коротко отчитайся.`
        }
      }
    }
    this.task.commitReady = true
    return null
  }

  /**
   * Автовыбор модели: перед ревью сверить результат с планом. Недоделанные шаги
   * Claude перезапускает субагентом на модели на ступень сильнее — не больше
   * MAX_ESCALATIONS раз, дальше полноту оценит ревью.
   */
  private async checkPlanCompletion(plan: string, signal: AbortSignal): Promise<PermissionDecision> {
    if (this.task.escalations >= MAX_ESCALATIONS) {
      this.task.complete = true
      this.logAction('Полнота', `уже ${MAX_ESCALATIONS} перезапуска на модели сильнее — дальше решит ревью`, true)
      return null
    }
    const before = this.phase
    this.setPhase('checking')
    this.logAction('Полнота', 'сверяю результат с планом…')
    const { missing, usage, model } = await checkCompletion(
      {
        dir: this.session.projectDir,
        task: this.task.text,
        plan,
        baseSha: this.task.pendingCheckpoint ?? null,
        files: [...this.task.files]
      },
      signal
    )
    this.logUsage('Проверка', usage, model)
    if (signal.aborted) return null
    this.setPhase(before === 'checking' ? 'executing' : before)

    if (missing === null) {
      this.task.complete = true
      this.logAction('Полнота', 'не удалось проверить — продолжаю без неё', true)
      return null
    }
    if (missing.length === 0) {
      this.task.complete = true
      this.logAction('Полнота', 'план выполнен целиком ✓')
      return null
    }
    this.task.escalations++
    const escalations = planEscalations(missing, parsePlanModels(plan), this.task.triedModels)
    for (const e of escalations) {
      this.logAction('Полнота', `${e.step > 0 ? `шаг ${e.step}` : 'вне шагов'}: ${e.what} → ${e.model}`, true)
    }
    this.say('По плану сделано не всё — перезапускаю на модели сильнее.')
    return { behavior: 'block', reason: completionReason(escalations) }
  }

  /** Рискованная команда: озвучиваем и ждём «да» / «нет». */
  private holdDangerous(tool: string, summary: string): Promise<PermissionDecision> {
    // Одна рискованная за раз; вторую отклоняем — Claude спросит снова позже.
    if (this.held) {
      return Promise.resolve({ behavior: 'deny', message: 'Сначала дождитесь ответа на предыдущую команду.' })
    }
    const prev = this.phase
    return new Promise<PermissionDecision>((resolve) => {
      const timer = setTimeout(() => this.resolveHeld(false), HOLD_TIMEOUT_MS)
      this.held = {
        tool,
        summary,
        resolve: (d) => {
          clearTimeout(timer)
          this.held = null
          this.setPhase(prev === 'permission' ? 'executing' : prev)
          resolve(d)
        }
      }
      this.setPhase('permission')
      this.say('Нужно ваше согласие на рискованную команду.')
    })
  }

  /**
   * План готов: показываем его сразу (транскрипт Claude Code пишет с задержкой)
   * и держим хук, пока вы не ответите.
   */
  private holdForPlan(input: PermissionRequestInput): Promise<PermissionDecision> {
    const plan = (input.tool_input as { plan?: unknown } | null)?.plan
    this.plan =
      typeof plan === 'string' && plan.trim()
        ? plan
        : 'План сохранён в файл — откройте терминал, чтобы прочитать.'
    this.planToolId = input.tool_use_id ?? null
    this.recordPlan(this.plan)
    this.setPhase('plan-ready')
    this.say('План готов. Скажите «выполняй» или что изменить.')
    return this.holdGate('ExitPlanMode')
  }

  private holdForQuestion(input: PermissionRequestInput): Promise<PermissionDecision> {
    const items = parseQuestions(input.tool_input)
    const first = items[0]
    const toolInput = input.tool_input
    if (!first || typeof toolInput !== 'object' || toolInput === null) return Promise.resolve(null)
    this.question = {
      id: input.tool_use_id ?? '',
      items,
      index: 0,
      answers: {},
      input: toolInput as Record<string, unknown>
    }
    if (this.phase !== 'question') this.phaseBeforeQuestion = this.phase
    this.setPhase('question')
    // Фаза могла уже быть 'question' — состояние всё равно новое.
    this.emit('state', this.state)
    const count = items.length > 1 ? `У Claude ${items.length} вопроса.` : 'У Claude вопрос.'
    this.say(`${count} ${questionHint(first)}`)
    return this.holdGate('AskUserQuestion')
  }

  private holdGate(tool: string): Promise<PermissionDecision> {
    this.gate?.resolve(null)
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.takeGate(tool)?.resolve(null), HOLD_TIMEOUT_MS)
      this.gate = {
        tool,
        since: '',
        resolve: (decision) => {
          clearTimeout(timer)
          resolve(decision)
        }
      }
    })
  }

  private takeGate(tool: string): Gate | null {
    const gate = this.gate
    if (!gate || gate.tool !== tool) return null
    this.gate = null
    return gate
  }

  private resolveHeld(allow: boolean): void {
    const held = this.held
    if (!held) return
    this.logAction('Согласие', `${allow ? 'разрешено' : 'запрещено'}: ${held.summary}`, !allow)
    held.resolve(
      allow ? { behavior: 'allow' } : { behavior: 'deny', message: 'Пользователь запретил эту команду.' }
    )
  }

  /** Решение по кнопке из окна (то же, что голосом). */
  answerPermission(allow: boolean): void {
    this.resolveHeld(allow)
  }

  // ───────────────────── Транскрипт ─────────────────────

  onTranscript(event: TranscriptEvent): void {
    switch (event.kind) {
      case 'plan':
        // Транскрипт — запасной путь, только если хук не поднялся.
        if (this.hooks || this.phase !== 'planning') break
        this.plan = event.plan
        this.planToolId = event.id
        this.recordPlan(event.plan)
        this.setPhase('plan-ready')
        this.say('План готов. Скажите «выполняй» или что изменить.')
        break

      case 'question':
        if (this.hooks || this.question?.id === event.id) break
        this.question = {
          id: event.id,
          items: [{ question: event.question, options: event.options, multiSelect: false }],
          index: 0,
          answers: {},
          input: null
        }
        if (this.phase !== 'question') this.phaseBeforeQuestion = this.phase
        this.setPhase('question')
        this.say('У Claude вопрос. Назовите номер варианта.')
        break

      case 'task-end':
        if (event.id === this.planToolId) {
          this.planToolId = null
          if (this.phase === 'plan-ready') {
            // План закрыт не нами (например, ответили прямо в терминале).
            this.plan = null
            this.setPhase('executing')
          }
        }
        if (this.question && event.id === this.question.id) {
          this.question = null
          this.setPhase(this.phaseBeforeQuestion)
        }
        break

      case 'turn-end':
        // Обычно ход уже закрыл Stop-хук; это запасной путь.
        this.finishTurn()
        break

      default:
        break
    }
  }

  // ───────────────────── Экран TUI ─────────────────────

  private onScreen(chunk: string): void {
    const flat = flatten(chunk)
    this.screen = (this.screen + flat).slice(-SCREEN_TAIL)
    if (this.gate) this.gate.since = (this.gate.since + flat).slice(-SCREEN_TAIL)

    if (this.phase !== 'starting') return

    // Вы сами выбрали эту папку в приложении — это и есть согласие на доверие.
    if (!this.trustAnswered && this.screen.includes('Itrustthisfolder')) {
      this.trustAnswered = true
      this.trustPending = true
      void this.answerTrust().finally(() => {
        this.trustPending = false
        // Рамка закрытого диалога не должна сойти за поле ввода.
        this.screen = ''
      })
      return
    }

    if (!this.trustPending && isTuiReady(this.screen)) {
      const dir = this.session.projectDir
      this.needsInit = !hasClaudeMd(dir) && !isEmptyProject(dir)
      this.setPhase('ready')
      const queued = this.queue.splice(0)
      if (queued.length) void this.handleUserText(queued.join('. '))
    }
  }

  /**
   * Курсор в диалоге доверия стоит на «No, exit», и Enter не туда закрывает Claude.
   * Поэтому: даём меню дорисоваться, жмём стрелку вниз и Enter нажимаем, только
   * убедившись, что курсор на «Yes». Не вышло — оставляем вопрос вам в терминале.
   */
  private async answerTrust(): Promise<void> {
    await delay(1200)
    for (let attempt = 0; attempt < 3; attempt++) {
      const moved = this.waitForScreen((s) => s.includes('❯Yes,Itrustthisfolder'), 1500)
      this.session.write('\x1b[B')
      if (await moved) {
        await delay(200)
        this.session.write('\r')
        this.logAction('Доверие', 'папка отмечена как доверенная')
        return
      }
    }
    this.logAction('Доверие', 'не удалось ответить — ответьте в окне терминала', true)
  }

  /** Ждёт фразу в новом выводе экрана (с момента вызова). */
  private waitForScreen(test: (screen: string) => boolean, timeoutMs: number): Promise<boolean> {
    this.screen = ''
    return this.poll(() => test(this.screen), timeoutMs)
  }

  /** Ждёт фразу во всём выводе с момента, как пришёл хук. */
  private waitIn(gate: Gate, test: (screen: string) => boolean, timeoutMs: number): Promise<boolean> {
    // Ворота уже сняты, но экран продолжаем копить в них до конца ожидания.
    const feed = (buf: Buffer): void => {
      gate.since = (gate.since + flatten(buf.toString('utf8'))).slice(-SCREEN_TAIL)
    }
    this.session.on('data', feed)
    return this.poll(() => test(gate.since), timeoutMs).finally(() =>
      this.session.off('data', feed)
    )
  }

  private poll(check: () => boolean, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      if (check()) return resolve(true)
      const started = Date.now()
      const timer = setInterval(() => {
        if (check()) {
          clearInterval(timer)
          resolve(true)
        } else if (Date.now() - started > timeoutMs) {
          clearInterval(timer)
          resolve(false)
        }
      }, 100)
    })
  }

  // ───────────────────── Служебное ─────────────────────

  private setPhase(next: AssistantPhase): void {
    if (this.phase === next) return
    this.phase = next
    this.emit('state', this.state)
  }

  private say(text: string): void {
    this.emit('say', text)
  }

  /** Токены отдельного запуска `claude -p` (ревью, проверка полноты) — в статистику расхода. */
  private logUsage(tool: string, usage: TokenUsage | null, model: string | null): void {
    if (!usage) return
    this.emit('action', {
      kind: 'usage',
      messageId: `review:${++this.reviewSeq}`,
      tools: [tool],
      usage,
      at: Date.now(),
      // Фактическая модель запуска (modelUsage ответа); null — цена запасная.
      model
    } satisfies TranscriptEvent)
  }

  /** Строка в панели «Действия» — то, что ассистент сделал сам. */
  private logAction(name: string, summary: string, failed = false): void {
    const id = `assistant:${++this.actionSeq}`
    const now = Date.now()
    const kind = ACTION_KIND[name] ?? 'system'
    this.emit('action', {
      kind: 'task-start',
      task: { id, name, summary, state: 'running', startedAt: now, endedAt: null, error: null, kind }
    } satisfies TranscriptEvent)
    this.emit('action', {
      kind: 'task-end',
      id,
      state: failed ? 'error' : 'ok',
      error: null
    } satisfies TranscriptEvent)
  }

  dispose(): void {
    this.gateAbort?.abort()
    if (this.held) this.resolveHeld(false)
    this.gate?.resolve(null)
    this.gate = null
    this.removeAllListeners()
  }
}

interface TaskState {
  /** Что просил пользователь — для ревьюера. */
  text: string
  /** Одобренный план, если был. */
  plan: string | null
  /** Файлы, изменённые инструментами правки. */
  files: Set<string>
  /** Правка файла инструментом (Edit/Write…) — точно были изменения. */
  edited: boolean
  bashRan: boolean
  /** Была команда Bash, которая может что-то менять (для проектов без git). */
  bashMaybeChanged: boolean
  /** Отпечаток git-дерева до задачи; null — не git. */
  fingerprint: string | null
  /** Точка отката, сделанная до первой возможной правки; undefined — ещё не делали. */
  pendingCheckpoint?: string | null
  checkpointShown: boolean
  reviewed: boolean
  gateRounds: number
  /** Проверка полноты по плану пройдена (или её больше не делаем). */
  complete: boolean
  /** Сколько раз недоделанное отдавали модели сильнее. */
  escalations: number
  /** Шаг плана → модель последнего перезапуска; следующий круг поднимется выше. */
  triedModels: Map<number, StepModel>
  /** Правки прошли проверки (или они выключены) — результат можно коммитить. */
  commitReady: boolean
  committed: boolean
}

function newTask(): TaskState {
  return {
    text: '',
    plan: null,
    files: new Set(),
    edited: false,
    bashRan: false,
    bashMaybeChanged: false,
    fingerprint: null,
    checkpointShown: false,
    reviewed: false,
    gateRounds: 0,
    complete: false,
    escalations: 0,
    triedModels: new Map(),
    commitReady: false,
    committed: false
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
