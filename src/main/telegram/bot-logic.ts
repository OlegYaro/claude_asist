import { randomInt, timingSafeEqual } from 'node:crypto'
import type { AssistantPhase, HistorySession, SessionInfo } from '../../shared/types'
import { dateLabel, outcomeText, plural, timeLabel } from '../../shared/history-format.ts'
// С расширением: этот модуль запускают и тесты прямо в Node, без сборщика.
import { isApprove, isCancel, isStop, parseOrdinal, parseOrdinals } from '../../shared/intents.ts'

/**
 * Чистая логика Telegram-бота: без Electron и сети, чтобы её можно было
 * проверить тестами. Сетевая часть и подписки на сессию — в telegram-bot.ts.
 */

/** Лимит длины одного сообщения в Telegram. */
export const MESSAGE_LIMIT = 4096
/** Сколько частей длинного ответа слать максимум — дальше смотреть в приложении. */
export const MAX_PARTS = 3

/**
 * Код привязки живёт сутки и выдерживает 5 неверных попыток: подбор шестизначного
 * кода упирается в лимит попыток, а не в срок, так что длинный срок безопасен.
 */
export const PAIR_CODE_TTL_MS = 24 * 60 * 60 * 1000
export const PAIR_CODE_MAX_ATTEMPTS = 5

export type BotCommand =
  | { kind: 'start'; code: string | null }
  | { kind: 'status' }
  | { kind: 'projects' }
  | { kind: 'stop' }
  | { kind: 'help' }
  | { kind: 'history' }
  | { kind: 'unknown'; name: string }
  | { kind: 'text'; text: string }

/** `/cmd@BotName аргументы` или обычный текст. */
export function parseCommand(raw: string): BotCommand | null {
  const text = raw.trim()
  if (!text) return null
  const m = /^\/([a-z_]+)(?:@\w+)?(?:\s+([\s\S]*))?$/i.exec(text)
  if (!m) return { kind: 'text', text }
  const name = m[1]!.toLowerCase()
  const arg = m[2]?.trim() || null
  switch (name) {
    case 'start':
      return { kind: 'start', code: arg }
    case 'status':
      return { kind: 'status' }
    case 'projects':
      return { kind: 'projects' }
    case 'stop':
      return { kind: 'stop' }
    case 'help':
      return { kind: 'help' }
    case 'history':
      return { kind: 'history' }
    default:
      return { kind: 'unknown', name }
  }
}

// ─────────────────────────── Привязка ───────────────────────────

export interface PairCode {
  code: string
  expiresAt: number
  attemptsLeft: number
}

export function newPairCode(now: number): PairCode {
  return {
    code: String(randomInt(0, 1_000_000)).padStart(6, '0'),
    expiresAt: now + PAIR_CODE_TTL_MS,
    attemptsLeft: PAIR_CODE_MAX_ATTEMPTS
  }
}

/**
 * Проверяет код и расходует попытку. Возвращает обновлённый код (null — код
 * исчерпан, истёк или использован) и итог проверки.
 */
export function checkPairCode(
  pair: PairCode | null,
  given: string | null,
  now: number
): { ok: boolean; next: PairCode | null } {
  if (!pair || now > pair.expiresAt) return { ok: false, next: null }
  const a = Buffer.from(given?.trim() ?? '')
  const b = Buffer.from(pair.code)
  const ok = a.length === b.length && timingSafeEqual(a, b)
  if (ok) return { ok: true, next: null }
  const attemptsLeft = pair.attemptsLeft - 1
  return { ok: false, next: attemptsLeft > 0 ? { ...pair, attemptsLeft } : null }
}

// ─────────────────────────── Текст ───────────────────────────

/**
 * Режет длинный текст на сообщения по лимиту Telegram, предпочитая границы
 * абзацев и строк. Больше `maxParts` частей не отдаёт — последняя помечается.
 */
export function splitMessage(text: string, limit = MESSAGE_LIMIT, maxParts = MAX_PARTS): string[] {
  const tail = '\n\n…продолжение — в приложении.'
  const parts: string[] = []
  let rest = text.trim()
  while (rest.length > 0) {
    if (parts.length === maxParts - 1 && rest.length > limit) {
      parts.push(rest.slice(0, limit - tail.length).trimEnd() + tail)
      break
    }
    if (rest.length <= limit) {
      parts.push(rest)
      break
    }
    const window = rest.slice(0, limit)
    let cut = window.lastIndexOf('\n\n')
    if (cut < limit / 2) cut = window.lastIndexOf('\n')
    if (cut < limit / 2) cut = window.lastIndexOf(' ')
    if (cut < limit / 2) cut = limit
    parts.push(rest.slice(0, cut).trimEnd())
    rest = rest.slice(cut).trimStart()
  }
  return parts
}

// ─────────────────────────── Голосовые ───────────────────────────

/** Длиннее — это уже не реплика, а распознавание займёт минуты. */
export const VOICE_MAX_SECONDS = 300
/** Opus в голосовых Telegram — около 4 КБ/с, 5 минут укладываются с запасом. */
export const VOICE_MAX_BYTES = 5 * 1024 * 1024

export interface VoiceInfo {
  file_id: string
  duration: number
  file_size?: number
}

export type MessageInput =
  | { kind: 'text'; text: string }
  | { kind: 'voice'; fileId: string }
  | { kind: 'rejected'; reply: string }

/** Что пришло в сообщении: текст, голосовое в пределах лимитов или то, что бот не принимает. */
export function messageInput(msg: { text?: string; voice?: VoiceInfo }): MessageInput {
  if (msg.text !== undefined) return { kind: 'text', text: msg.text }
  const voice = msg.voice
  if (!voice) return { kind: 'rejected', reply: 'Понимаю текст и голосовые сообщения.' }
  if (voice.duration > VOICE_MAX_SECONDS || (voice.file_size ?? 0) > VOICE_MAX_BYTES) {
    return {
      kind: 'rejected',
      reply: `Голосовое длиннее ${VOICE_MAX_SECONDS / 60} минут — разбейте на части покороче.`
    }
  }
  return { kind: 'voice', fileId: voice.file_id }
}

const PHASE_LABEL: Record<AssistantPhase, string> = {
  starting: 'запускается',
  ready: 'ждёт задачу',
  planning: 'составляет план',
  'plan-ready': 'план ждёт вашего ответа',
  executing: 'работает',
  checking: 'проверяет результат',
  question: 'ждёт ответа на вопрос',
  permission: 'ждёт согласия на команду'
}

export function projectName(dir: string): string {
  return dir.split('/').filter(Boolean).pop() ?? dir
}

export function formatStatus(info: SessionInfo | null): string {
  if (!info) return 'Проект не открыт. Выберите его: /projects'
  if (info.status === 'stopped') {
    return `Проект: ${projectName(info.projectDir)}\nClaude Code завершился. Откройте проект заново: /projects`
  }
  const lines = [
    `Проект: ${projectName(info.projectDir)}`,
    `Claude: ${PHASE_LABEL[info.assistant.phase]}`
  ]
  if (info.title) lines.push(`Сессия: ${info.title}`)
  if (info.assistant.checkpoint) lines.push(`Точка отката: ${info.assistant.checkpoint}`)
  return lines.join('\n')
}

/**
 * Что делать с текстом с телефона на текущем этапе: передавать ли ассистенту и
 * что ответить. «Принято» — только когда ассистент текст действительно возьмёт;
 * на неподходящий ответ (не номер варианта, не «да/нет») он сам пришлёт подсказку.
 * Повторяет ветки `Assistant.handleUserText`.
 */
export function replyFor(phase: AssistantPhase, text: string): { submit: boolean; reply: string | null } {
  if (isStop(text) && phase !== 'ready' && phase !== 'starting') return { submit: true, reply: 'Останавливаю.' }
  switch (phase) {
    case 'checking':
      return { submit: false, reply: 'Claude проверяет результат — напишите, когда закончит.' }
    case 'starting':
      return { submit: true, reply: 'Claude Code запускается — передам, как только будет готов.' }
    case 'question':
      return { submit: true, reply: parseOrdinal(text) !== null || parseOrdinals(text) !== null ? 'Принято.' : null }
    case 'permission':
      return { submit: true, reply: isApprove(text) || isCancel(text) ? 'Принято.' : null }
    case 'ready':
    case 'planning':
    case 'plan-ready':
    case 'executing':
      return { submit: true, reply: 'Принято.' }
  }
}

export const HELP_TEXT = [
  'Пишите задачу текстом или голосовым — она уйдёт Claude, как сказанная в приложении.',
  '«выполняй», «стоп», «откати», «с планом, …» работают так же, как в приложении.',
  '',
  '/status — что сейчас происходит',
  '/projects — открыть проект',
  '/history — ваши последние запросы и прошлые сессии',
  '/stop — прервать текущую задачу'
].join('\n')

// ─────────────────────────── История ───────────────────────────

/** Сколько последних запросов текущей сессии и прошлых сессий показывать в /history. */
export const HISTORY_REQUESTS = 10
export const HISTORY_SESSIONS = 5
const HISTORY_TEXT_CHARS = 90

function clip(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max - 1)}…` : clean
}

/** Короткая история для /history: запросы текущей сессии с итогами и прошлые сессии строкой. */
export function formatHistory(
  projectDir: string,
  sessions: HistorySession[],
  currentId: string,
  now = Date.now()
): string {
  const lines = [`История: ${projectName(projectDir)}`, '']
  const current = sessions.find((s) => s.id === currentId)

  if (!current || current.requests.length === 0) {
    lines.push('Сейчас — новая сессия, запросов пока нет.')
  } else {
    lines.push(`Сейчас — ${current.title}`)
    const recent = current.requests.slice(-HISTORY_REQUESTS)
    const hidden = current.requests.length - recent.length
    if (hidden > 0) lines.push(`…и ещё ${hidden} ${plural(hidden, 'запрос', 'запроса', 'запросов')} раньше`)
    for (const r of recent) {
      lines.push(`${timeLabel(r.at)} · ${outcomeText(r)} — ${clip(r.text, HISTORY_TEXT_CHARS)}`)
    }
  }

  const past = sessions.filter((s) => s.id !== currentId).slice(0, HISTORY_SESSIONS)
  if (past.length > 0) {
    lines.push('', 'Раньше:')
    for (const s of past) {
      const n = s.requests.length
      lines.push(
        `• ${dateLabel(s.updatedAt, now)} — ${clip(s.title, HISTORY_TEXT_CHARS)} (${n} ${plural(n, 'запрос', 'запроса', 'запросов')})`
      )
    }
    lines.push('', 'Продолжить прошлую сессию можно в приложении, в панели «История».')
  }

  const text = lines.join('\n')
  return text.length > MESSAGE_LIMIT ? `${text.slice(0, MESSAGE_LIMIT - 1)}…` : text
}

// ─────────────────────────── Уведомления ───────────────────────────

/** Что бот уже сообщил о сессии — чтобы не повторяться на каждом обновлении. */
export interface SeenSession {
  sessionId: string | null
  stopped: boolean
  plan: string | null
  question: string | null
  permission: string | null
  plugin: string | null
}

export const NOTHING_SEEN: SeenSession = {
  sessionId: null,
  stopped: false,
  plan: null,
  question: null,
  permission: null,
  plugin: null
}

export type SessionNote =
  | { kind: 'opened'; dir: string }
  | { kind: 'exited' }
  | { kind: 'plan'; text: string }
  | {
      kind: 'question'
      question: string
      options: string[]
      /** Несколько ответов — кнопками не выбрать, номера присылают текстом. */
      multiSelect: boolean
      /** «Вопрос 2 из 3»; у единственного вопроса — null. */
      position: string | null
    }
  | { kind: 'permission'; summary: string }
  | { kind: 'plugin'; id: string; title: string; purpose: string }

/**
 * Сравнивает новое состояние сессии с уже сообщённым и решает, о чём написать.
 * Ключ сбрасывается, когда этап закончился, — следующий план или вопрос
 * будет сообщён, даже если совпадёт текстом с прошлым.
 */
export function sessionNotes(
  seen: SeenSession,
  info: SessionInfo | null
): { seen: SeenSession; notes: SessionNote[] } {
  // info === null — сессию остановило само приложение (или перед перезапуском): молчим.
  if (!info) return { seen: { ...NOTHING_SEEN, sessionId: seen.sessionId }, notes: [] }

  const notes: SessionNote[] = []
  const fresh = info.sessionId !== seen.sessionId
  const base = fresh ? { ...NOTHING_SEEN, sessionId: info.sessionId } : seen
  if (fresh) notes.push({ kind: 'opened', dir: info.projectDir })

  const stopped = info.status === 'stopped'
  if (stopped && !base.stopped && !fresh) notes.push({ kind: 'exited' })

  const a = info.assistant
  const plan = a.phase === 'plan-ready' && a.plan ? a.plan : null
  if (plan && plan !== base.plan) notes.push({ kind: 'plan', text: plan })

  const q = a.phase === 'question' && a.question ? a.question : null
  // Номер в ключе: два вопроса подряд могут совпасть текстом.
  const questionKey = q ? `${q.index ?? 0}\n${q.question}\n${q.options.join('\n')}` : null
  if (q && questionKey !== base.question) {
    const total = q.total ?? 1
    notes.push({
      kind: 'question',
      question: q.question,
      options: q.options,
      multiSelect: q.multiSelect === true,
      position: total > 1 ? `Вопрос ${(q.index ?? 0) + 1} из ${total}` : null
    })
  }

  const p = a.phase === 'permission' && a.permission ? a.permission : null
  const permissionKey = p ? `${p.tool}\n${p.summary}` : null
  if (p && permissionKey !== base.permission) notes.push({ kind: 'permission', summary: p.summary })

  const pluginKey = info.pluginRequest?.id ?? null
  if (info.pluginRequest && pluginKey !== base.plugin) {
    const { id, title, purpose } = info.pluginRequest
    notes.push({ kind: 'plugin', id, title, purpose })
  }

  return {
    seen: {
      sessionId: info.sessionId,
      stopped,
      plan,
      question: questionKey,
      permission: permissionKey,
      plugin: pluginKey
    },
    notes
  }
}

// ─────────────────────────── Кнопки ───────────────────────────

export interface InlineButton {
  text: string
  callback_data: string
}
export type InlineKeyboard = InlineButton[][]

/** Этапы, на которых бот присылает кнопки ответа. */
export type AnswerPhase = Extract<AssistantPhase, 'plan-ready' | 'question' | 'permission'>
const ANSWER_PHASES: readonly string[] = ['plan-ready', 'question', 'permission']

/**
 * Нажатие кнопки: фраза для ассистента или открытие проекта из списка.
 * Фраза помнит этап, к которому относится: «выполняй» со старого плана не
 * должна уйти Claude новой задачей, когда план уже закрыт.
 */
export type CallbackAction =
  | { kind: 'say'; phase: AnswerPhase; text: string }
  | { kind: 'open'; index: number }
  /** Подключить плагин (`id`) или отказаться (`id` = null). */
  | { kind: 'plugin'; id: string | null }

/** callback_data ограничен 64 байтами. */
const CALLBACK_LIMIT = 64

function sayButton(phase: AnswerPhase, text: string, phrase: string): InlineButton {
  const data = `say:${phase}:${phrase}`
  if (Buffer.byteLength(data) > CALLBACK_LIMIT) throw new Error(`callback_data длиннее 64 байт: ${phrase}`)
  return { text, callback_data: data }
}

export function parseCallback(data: string | undefined): CallbackAction | null {
  if (!data) return null
  const say = /^say:([a-z-]+):(.+)$/s.exec(data)
  if (say) {
    const text = say[2]!.trim()
    if (!ANSWER_PHASES.includes(say[1]!) || !text) return null
    return { kind: 'say', phase: say[1] as AnswerPhase, text }
  }
  const open = /^open:(\d{1,2})$/.exec(data)
  if (open) return { kind: 'open', index: Number(open[1]) }
  const plugin = /^plugin:([a-z0-9-]{1,40}|no)$/.exec(data)
  if (plugin) return { kind: 'plugin', id: plugin[1] === 'no' ? null : plugin[1]! }
  return null
}

export function pluginKeyboard(id: string): InlineKeyboard {
  return [
    [
      { text: '🔌 Подключить и перезапустить', callback_data: `plugin:${id}` },
      { text: '✖️ Не надо', callback_data: 'plugin:no' }
    ]
  ]
}

export function planKeyboard(): InlineKeyboard {
  return [
    [sayButton('plan-ready', '▶️ Выполняй', 'выполняй'), sayButton('plan-ready', '✖️ Отмена', 'отмена')]
  ]
}

export function permissionKeyboard(): InlineKeyboard {
  return [[sayButton('permission', '✅ Да', 'да'), sayButton('permission', '⛔️ Нет', 'нет')]]
}

/** Вариант отправляется номером — ассистент понимает его так же, как «второй». */
export function questionKeyboard(options: string[]): InlineKeyboard {
  return options.map((label, i) => [
    sayButton('question', `${i + 1}. ${label.length > 60 ? `${label.slice(0, 57)}…` : label}`, String(i + 1))
  ])
}

export function projectsKeyboard(dirs: string[]): InlineKeyboard {
  return dirs.map((dir, i) => [{ text: projectName(dir), callback_data: `open:${i}` }])
}
