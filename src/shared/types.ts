/**
 * Контракт между main и renderer. Единственный источник истины для формы данных,
 * которые пересекают границу IPC.
 */

// ─────────────────────────── Сессия ───────────────────────────

export type SessionStatus =
  | 'idle' // сессия запущена, Claude ждёт ввода
  | 'working' // Claude выполняет задачу
  | 'needs-permission' // Claude спрашивает разрешение — ответить надо в терминале
  | 'stopped' // процесс завершился

export interface SessionInfo {
  sessionId: string
  projectDir: string
  /** Заголовок, который Claude Code сам придумал для сессии (`ai-title` в транскрипте). */
  title: string | null
  status: SessionStatus
  /** Путь к JSONL транскрипта; null пока файл не найден. */
  transcriptPath: string | null
  /** Активный permission-mode, как его сообщает транскрипт. */
  permissionMode: string | null
  model: string | null
  /** Открыто ли сейчас хотя бы одно окно Terminal.app, присоединённое к PTY. */
  terminalAttached: boolean
  assistant: AssistantState
}

// ─────────────────────────── Ассистент ───────────────────────────

/**
 * Этап работы ассистента над задачей:
 *  starting   — Claude Code запускается (или отвечаем на вопрос о доверии к папке)
 *  ready      — ждём новую задачу
 *  planning   — Claude сам решил начать с плана (EnterPlanMode) и составляет его
 *  plan-ready — план готов, ждём «выполняй» или замечания
 *  executing  — Claude работает: отвечает на вопрос или выполняет задачу
 *  checking   — приложение запускает проверки проекта (тесты, типы, линтер)
 *  question   — Claude задал вопрос с вариантами
 *  permission — опасная команда ждёт вашего согласия
 */
export type AssistantPhase =
  | 'starting'
  | 'ready'
  | 'planning'
  | 'plan-ready'
  | 'executing'
  | 'checking'
  | 'question'
  | 'permission'

/** Текущий вопрос Claude; если он задал несколько, они идут по одному. */
export interface PendingQuestion {
  question: string
  options: string[]
  /** Можно выбрать несколько вариантов. */
  multiSelect?: boolean
  /** Номер вопроса с нуля и сколько их всего. */
  index?: number
  total?: number
}

export interface PendingPermission {
  tool: string
  summary: string
}

export interface AssistantState {
  phase: AssistantPhase
  /** Текст плана, пока он ждёт одобрения. */
  plan: string | null
  question: PendingQuestion | null
  permission: PendingPermission | null
  /** В проекте нет CLAUDE.md — стоит предложить изучить проект (/init). */
  needsInit: boolean
  /** Короткий хеш последней точки отката (git), если она есть. */
  checkpoint: string | null
  /** Последний план — остаётся доступным и после одобрения. */
  lastPlan: PlanRecord | null
  /** Итоги последних проверок проекта. */
  checks: CheckRecord[]
  /** Итог последнего независимого ревью. */
  review: ReviewRecord | null
}

export interface PlanRecord {
  text: string
  status: 'waiting' | 'approved' | 'revising' | 'cancelled'
  at: number
}

export interface CheckRecord {
  name: string
  command: string
  status: 'ok' | 'failed' | 'skipped'
  ms: number
  at: number
}

export interface ReviewRecord {
  ok: boolean
  issues: { file: string; problem: string }[]
  at: number
}

// ─────────────────────── Сведения о проекте ───────────────────────

export interface ProjectOverview {
  dir: string
  /** Содержимое CLAUDE.md — описание, команды, архитектура. */
  claudeMd: string | null
  /** Языки, фреймворки и инструменты, найденные по файлам проекта. */
  stack: string[]
  /** Команды проекта (скрипты package.json, Makefile…). */
  commands: { name: string; command: string }[]
  git: { branch: string; lastCommit: string } | null
}

export interface ChangedFile {
  path: string
  added: number
  removed: number
  /** new — новый файл, deleted — удалён, modified — изменён. */
  status: 'new' | 'deleted' | 'modified'
}

export interface ProjectChanges {
  /** С какой точки считаются изменения (короткий хеш); null — без git. */
  base: string | null
  files: ChangedFile[]
}

// ─────────────────────── История сессий ───────────────────────

/**
 * Чем закончился запрос: answer — ответ без правок, plan — Claude составил план,
 * edits — правил файлы, interrupted — прервано, rollback — откат к точке.
 */
export type RequestOutcome = 'answer' | 'plan' | 'edits' | 'interrupted' | 'rollback'

/** Один ваш запрос в сессии. */
export interface HistoryRequest {
  text: string
  at: number
  outcome: RequestOutcome
  /** Сколько разных файлов правил Claude по этому запросу. */
  files: number
}

/** Прошлая (или текущая) сессия Claude Code в папке проекта. */
export interface HistorySession {
  id: string
  /** Название от пользователя или Claude; иначе первая фраза. */
  title: string
  startedAt: number
  updatedAt: number
  /** Сессия запущена приложением, а не вручную в терминале. */
  fromApp: boolean
  requests: HistoryRequest[]
}

// ─────────────────────── События транскрипта ───────────────────────

export type TaskState = 'running' | 'ok' | 'error'

/**
 * Тип строки в «Действиях» — для значка, цвета и фильтров.
 * task — ваша новая задача (заголовок группы); остальное — что происходило по ней.
 */
export type ActionKind =
  | 'task'
  | 'edit'
  | 'command'
  | 'read'
  | 'approval'
  | 'check'
  | 'review'
  | 'plan'
  | 'checkpoint'
  | 'question'
  | 'agent'
  | 'system'

/** Один вызов инструмента: строка в панели Tasks. */
export interface ToolTask {
  /** `tool_use.id` из транскрипта — по нему сопоставляем результат. */
  id: string
  name: string
  /** Короткая человекочитаемая сводка входа: путь файла, команда bash, запрос поиска. */
  summary: string
  state: TaskState
  startedAt: number
  endedAt: number | null
  /** Первая строка ошибки, если инструмент упал. */
  error: string | null
  /** Тип строки; у действий Claude выводится из имени инструмента. */
  kind?: ActionKind
  /** Полный вход действия (команда целиком, diff правки), не сокращённый до summary. */
  detail?: string
}

/** Токены одного ответа модели (поле `usage` в транскрипте). */
export interface TokenUsage {
  input: number
  cacheWrite: number
  cacheRead: number
  output: number
}

/** Элемент списка TodoWrite — канонический план, который ведёт сам Claude. */
export interface TodoItem {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm?: string
}

export type ChatRole = 'user' | 'assistant' | 'system'

export interface ChatMessage {
  id: string
  role: ChatRole
  text: string
  at: number
  /** true для последнего ассистентского сообщения в ходе — «финальный текст». */
  final?: boolean
  /** Пометка, что это сообщение — расшифровка голоса, а не набранный текст. */
  fromVoice?: boolean
  /** Особое сообщение: план Claude — показывается отдельной карточкой. */
  variant?: 'plan'
}

/** Всё, что main шлёт в renderer по мере разбора транскрипта. */
export type TranscriptEvent =
  | { kind: 'chat'; message: ChatMessage }
  | { kind: 'task-start'; task: ToolTask }
  | { kind: 'task-end'; id: string; state: Exclude<TaskState, 'running'>; error: string | null }
  | { kind: 'todos'; items: TodoItem[] }
  | { kind: 'title'; title: string }
  | { kind: 'mode'; permissionMode: string | null; model: string | null }
  | { kind: 'turn-end' }
  /** Claude вызвал ExitPlanMode: план готов и ждёт одобрения. */
  | { kind: 'plan'; id: string; plan: string }
  /** Claude задал вопрос с вариантами (AskUserQuestion). */
  | { kind: 'question'; id: string; question: string; options: string[] }
  /**
   * Расход токенов одного ответа. tools — имена его инструментов (пустой список —
   * ответ без инструментов); у ревью и проверок приложения — служебные имена вроде 'Ревью'.
   */
  | { kind: 'usage'; messageId: string; tools: string[]; usage: TokenUsage; at: number }

// ───────────────────────── Настройки ─────────────────────────

export type SttProviderId = 'apple-speech'

/** `always` — микрофон слушает постоянно; `push` — по удержанию кнопки или пробела. */
export type ListenMode = 'always' | 'push'

export type PlanMode = 'auto' | 'always' | 'never'

/** Модель сессии при ручном выборе: алиас для `claude --model`; `default` — флаг не передаём. */
export type SessionModel = 'default' | 'opus' | 'sonnet' | 'haiku' | 'fable'

export interface Settings {
  /** Недавние папки проектов, свежие первыми. */
  recentProjects: string[]
  sttProvider: SttProviderId
  /** Локаль распознавания речи, например `ru-RU`. */
  sttLocale: string
  /** Модель Claude API для генерации промта. */
  promptModel: string
  /** Передаётся в `claude --permission-mode`; null — не передавать флаг вообще. */
  permissionMode: string | null
  /** Явный путь к бинарю `claude`, если автопоиск не сработал. */
  claudeBinPath: string | null
  /** Автоматически открывать окно Terminal.app при старте сессии. */
  autoOpenTerminal: boolean
  listenMode: ListenMode
  /** Сколько секунд тишины ждать после фразы, прежде чем отправить: вдруг вы хотите добавить. */
  sendDelaySec: number
  /** Озвучивать короткие сообщения: «План готов», «Готово». */
  speak: boolean
  /** Читать вслух итоговый ответ Claude в конце хода; работает, только если включён `speak`. */
  speakReplies: boolean
  /** Голос macOS для озвучки; null — лучший установленный русский. */
  speechVoice: string | null
  /** Скорость речи, слов в минуту; null — системная. */
  speechRate: number | null
  /** Перебивать приложение голосом: во время речи микрофон слушает с повышенным порогом. */
  bargeIn: boolean
  /**
   * Когда составлять план: `auto` — Claude решает сам (вопросы и мелкие правки без
   * плана, сложные задачи — через план); `always` — всегда; `never` — никогда.
   */
  planMode: PlanMode
  /** После правок запускать проверки проекта и не давать закончить, пока они красные. */
  qualityGate: boolean
  /** Перед завершением задачи с правками — независимое ревью субагентом. */
  autoReview: boolean
  /**
   * Автовыбор модели: план — на Opus, шаги — субагентами на моделях из плана,
   * недоделанное — на модели сильнее. Выключено — вся сессия на `sessionModel`.
   * Применяется к новой сессии.
   */
  autoModel: boolean
  /** Модель сессии, когда автовыбор выключен. */
  sessionModel: SessionModel
  /** Git сам: репозиторий при открытии проекта без git, коммит после зелёных проверок. */
  autoGit: boolean
  /** Давать согласие на действия Claude автоматически (опасные команды всё равно спросят). */
  autoApprove: boolean
  /** Управление с телефона через Telegram-бота (работает, если задан токен). */
  telegramEnabled: boolean
  /** Чат, привязанный к боту кодом из настроек; сообщения из других чатов игнорируются. */
  telegramChatId: number | null
  /** Показывать слева панель «История» с прошлыми сессиями проекта. */
  historyOpen: boolean
}

export const DEFAULT_SETTINGS: Settings = {
  recentProjects: [],
  sttProvider: 'apple-speech',
  sttLocale: 'ru-RU',
  promptModel: 'claude-haiku-4-5',
  permissionMode: null,
  claudeBinPath: null,
  autoOpenTerminal: true,
  listenMode: 'always',
  sendDelaySec: 3,
  speak: true,
  speakReplies: false,
  speechVoice: null,
  speechRate: null,
  bargeIn: true,
  planMode: 'auto',
  qualityGate: true,
  autoReview: true,
  autoModel: true,
  sessionModel: 'default',
  autoGit: true,
  autoApprove: true,
  telegramEnabled: true,
  telegramChatId: null,
  historyOpen: true
}

// ───────────────────────── Озвучка ─────────────────────────

/** Фраза для воспроизведения в окне. */
export interface SpeechClip {
  id: number
  /** WAV, синтезированный `say`. */
  wav: Uint8Array
  text: string
}

// ───────────────────────── Telegram ─────────────────────────

export interface TelegramStatus {
  /** Токен бота сохранён. Сам токен в renderer не передаётся. */
  hasToken: boolean
  canStore: boolean
  enabled: boolean
  /** off — выключен или нет токена; connecting — подключается; running — принимает команды. */
  state: 'off' | 'connecting' | 'running' | 'error'
  /** Имя бота без @, известно после подключения. */
  botName: string | null
  error: string | null
  chatBound: boolean
  /** Действующий код привязки, если его запросили. */
  pairCode: string | null
  /** До какого момента (мс эпохи) действует `pairCode`. */
  pairExpiresAt: number | null
}

// ──────────────────── Генерация промта ────────────────────

export interface GeneratedPrompt {
  prompt: string
  title: string
}

export interface SttStatus {
  available: boolean
  /** Языковая модель уже скачана. Если нет — первое распознавание её дотянет. */
  installed: boolean
  /** Человекочитаемая деталь: движок и локаль, либо причина недоступности. */
  detail: string
}

export interface PromptContext {
  transcript: string
  projectDir: string
  todos: TodoItem[]
  /** Последние реплики чата для контекста, старые первыми. */
  recentMessages: { role: ChatRole; text: string }[]
}

// ─────────────────────── Ошибки для UI ───────────────────────

export type AppErrorCode =
  | 'claude-not-found'
  | 'terminal-automation-denied'
  | 'no-api-key'
  | 'api-auth'
  | 'api-rate-limit'
  | 'api-error'
  | 'stt-unavailable'
  | 'stt-failed'
  | 'voice-basic'
  | 'unknown'

export interface AppError {
  code: AppErrorCode
  message: string
  /** Подсказка, что пользователю сделать. */
  hint?: string
}

// ─────────────────────── Поверхность IPC ───────────────────────

/** Каналы main → renderer (push). */
export const PUSH_CHANNELS = {
  speaking: 'push:speaking',
  speechPlay: 'push:speech-play',
  speechCancel: 'push:speech-cancel',
  transcriptEvent: 'push:transcript-event',
  sessionUpdate: 'push:session-update',
  appError: 'push:app-error'
} as const
