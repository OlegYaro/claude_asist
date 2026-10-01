import type { SessionManager } from '../session-manager'
import { loadSettings, saveSettings } from '../settings'
import { SttError, getProvider, toWav16k } from '../stt'
import {
  clearTelegramToken,
  getTelegramToken,
  isEncryptionAvailable,
  setTelegramToken
} from '../secrets'
import {
  HELP_TEXT,
  NOTHING_SEEN,
  VOICE_MAX_BYTES,
  checkPairCode,
  formatHistory,
  formatStatus,
  messageInput,
  newPairCode,
  parseCallback,
  parseCommand,
  permissionKeyboard,
  planKeyboard,
  projectName,
  projectsKeyboard,
  questionKeyboard,
  replyFor,
  sessionNotes,
  splitMessage,
  type InlineKeyboard,
  type PairCode,
  type SeenSession,
  type SessionNote,
  type VoiceInfo
} from './bot-logic'
import type { AppError, SessionInfo, TelegramStatus, TranscriptEvent } from '../../shared/types'

/**
 * Управление приложением с телефона через Telegram-бота.
 *
 * Бот — ещё один источник фраз для ассистента (как голос) и канал уведомлений:
 * план, вопрос, рискованная команда, ответ Claude. Работает через long polling,
 * без вебхуков и открытых портов. Команды принимаются только из чата, привязанного
 * одноразовым кодом из настроек.
 */

const API = 'https://api.telegram.org'
const POLL_TIMEOUT_S = 50
/** Запрос long polling держится до POLL_TIMEOUT_S; сверху — запас на сеть. */
const POLL_REQUEST_MS = (POLL_TIMEOUT_S + 15) * 1000
const REQUEST_MS = 15_000
const VOICE_DOWNLOAD_MS = 60_000
const MAX_BACKOFF_MS = 60_000
/**
 * Ассистент сопровождает план, вопрос и согласие фразой «План готов…» — бот
 * уже прислал их с кнопками, так что фразу сразу после такого сообщения не дублируем.
 */
const SAY_AFTER_NOTE_MS = 1500
const TOKEN_FORMAT = /^\d{5,}:[A-Za-z0-9_-]{30,}$/

interface TgChat {
  id: number
  type: string
}

interface TgMessage {
  message_id: number
  chat: TgChat
  text?: string
  voice?: VoiceInfo
}

interface TgCallbackQuery {
  id: string
  data?: string
  message?: TgMessage
}

interface TgUpdate {
  update_id: number
  message?: TgMessage
  callback_query?: TgCallbackQuery
}

class TelegramApiError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    readonly retryAfter: number | null
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}

/** Токен входит в URL, поэтому в ошибки и логи URL не попадает никогда. */
async function callApi<T>(token: string, method: string, body: object, signal: AbortSignal): Promise<T> {
  const res = await fetch(`${API}/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal
  })
  let data: {
    ok?: boolean
    result?: T
    description?: string
    error_code?: number
    parameters?: { retry_after?: number }
  }
  try {
    data = (await res.json()) as typeof data
  } catch {
    throw new TelegramApiError(`Telegram ответил ${res.status}`, res.status, null)
  }
  if (!data.ok) {
    throw new TelegramApiError(
      data.description ?? `Telegram ответил ${res.status}`,
      data.error_code ?? res.status,
      data.parameters?.retry_after ?? null
    )
  }
  return data.result as T
}

/** Скачивание файла по `file_path` из getFile; размер проверяется и по ходу чтения. */
async function downloadFile(token: string, filePath: string, signal: AbortSignal): Promise<Buffer> {
  const res = await fetch(`${API}/file/bot${token}/${filePath}`, { signal })
  if (!res.ok || !res.body) throw new Error(`Telegram ответил ${res.status} при скачивании файла`)
  const chunks: Uint8Array[] = []
  let size = 0
  for await (const chunk of res.body) {
    size += chunk.byteLength
    if (size > VOICE_MAX_BYTES) throw new Error('файл слишком большой')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function within(signal: AbortSignal, ms: number): AbortSignal {
  return AbortSignal.any([signal, AbortSignal.timeout(ms)])
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done)
  })
}

function describe(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export class TelegramBot {
  private controller: AbortController | null = null
  private token: string | null = null
  private state: TelegramStatus['state'] = 'off'
  private botName: string | null = null
  private error: string | null = null
  private pair: PairCode | null = null

  private seen: SeenSession = NOTHING_SEEN
  private lastAnswer: { id: string; text: string } | null = null
  private sentAnswerId: string | null = null
  private lastNoteAt = 0
  /** Сообщение с кнопками ответа — принимаем нажатия только с самого свежего. */
  private answerMessageId: number | null = null
  /** Список проектов, по которому построены кнопки последнего /projects. */
  private projects: { messageId: number | null; dirs: string[] } = { messageId: null, dirs: [] }
  /** Отправка по очереди — чтобы части длинного ответа и уведомления не перемешались. */
  private outbox: Promise<unknown> = Promise.resolve()

  constructor(private readonly sessions: SessionManager) {
    sessions.on('session', (info: SessionInfo | null) => this.onSession(info))
    sessions.on('transcript', (event: TranscriptEvent) => this.onTranscript(event))
    sessions.on('say', (text: string) => this.onSay(text))
    sessions.on('error', (error: AppError) =>
      void this.send(`⚠️ ${error.message}${error.hint ? `\n${error.hint}` : ''}`)
    )
  }

  // ───────────────────── Управление из настроек ─────────────────────

  status(): TelegramStatus {
    const settings = loadSettings()
    const pairValid = this.pair && Date.now() <= this.pair.expiresAt
    return {
      hasToken: getTelegramToken() !== null,
      canStore: isEncryptionAvailable(),
      enabled: settings.telegramEnabled,
      state: this.state,
      botName: this.botName,
      error: this.error,
      chatBound: settings.telegramChatId !== null,
      pairCode: pairValid ? this.pair!.code : null,
      pairExpiresAt: pairValid ? this.pair!.expiresAt : null
    }
  }

  /** Поднимает бота, если он включён и токен задан; иначе останавливает. */
  start(): void {
    this.stop()
    const token = getTelegramToken()
    if (!token || !loadSettings().telegramEnabled) return
    const controller = new AbortController()
    this.controller = controller
    this.token = token
    this.state = 'connecting'
    this.error = null
    void this.run(token, controller.signal)
  }

  stop(): void {
    this.controller?.abort()
    this.controller = null
    this.token = null
    this.state = 'off'
    this.error = null
  }

  /** Проверяет токен у Telegram и только потом сохраняет. */
  async setToken(value: string): Promise<TelegramStatus> {
    const token = value.trim()
    if (!TOKEN_FORMAT.test(token)) {
      throw new Error('Это не похоже на токен бота. Он выглядит так: 123456789:AA…')
    }
    try {
      await callApi(token, 'getMe', {}, AbortSignal.timeout(REQUEST_MS))
    } catch (err) {
      if (err instanceof TelegramApiError && err.code === 401) {
        throw new Error('Telegram не принял токен — проверьте, что скопировали его целиком.')
      }
      throw new Error(`Не удалось связаться с Telegram: ${describe(err)}`)
    }
    setTelegramToken(token)
    this.start()
    return this.status()
  }

  clearToken(): TelegramStatus {
    this.stop()
    this.botName = null
    clearTelegramToken()
    return this.status()
  }

  setEnabled(enabled: boolean): TelegramStatus {
    saveSettings({ telegramEnabled: enabled })
    this.start()
    return this.status()
  }

  pairCode(): TelegramStatus {
    this.pair = newPairCode(Date.now())
    return this.status()
  }

  unbind(): TelegramStatus {
    saveSettings({ telegramChatId: null })
    this.pair = null
    return this.status()
  }

  // ───────────────────── Опрос Telegram ─────────────────────

  private async run(token: string, signal: AbortSignal): Promise<void> {
    let backoff = 1000
    let offset: number | null = null

    while (!signal.aborted) {
      try {
        if (offset === null) {
          const me = await callApi<{ username?: string }>(token, 'getMe', {}, within(signal, REQUEST_MS))
          this.botName = me.username ?? null
          // Сообщения, накопившиеся, пока приложение было закрыто, не исполняем:
          // задача, отправленная час назад, могла уже потерять смысл.
          const last = await callApi<TgUpdate[]>(
            token,
            'getUpdates',
            { offset: -1, timeout: 0 },
            within(signal, REQUEST_MS)
          )
          offset = (last[0]?.update_id ?? -1) + 1
          this.markRunning(signal)
          void this.send(`🟢 Claude Voice Desk на связи.\n\n${formatStatus(this.sessions.info)}`)
        }

        const updates: TgUpdate[] = await callApi<TgUpdate[]>(
          token,
          'getUpdates',
          { offset, timeout: POLL_TIMEOUT_S, allowed_updates: ['message', 'callback_query'] },
          within(signal, POLL_REQUEST_MS)
        )
        this.markRunning(signal)
        backoff = 1000
        for (const update of updates) {
          offset = update.update_id + 1
          if (signal.aborted) return
          try {
            await this.handleUpdate(update)
          } catch (err) {
            console.error('[telegram] не удалось обработать сообщение:', describe(err))
          }
        }
      } catch (err) {
        if (signal.aborted) return
        if (err instanceof TelegramApiError && err.code === 401) {
          this.fail(signal, 'Telegram не принял токен — задайте его заново в настройках.')
          return
        }
        if (err instanceof TelegramApiError && err.code === 409) {
          this.fail(signal, 'Этого бота уже опрашивает другая копия приложения — закройте её.')
        } else {
          this.fail(signal, `Нет связи с Telegram, повторяю… (${describe(err)})`)
        }
        const retryAfter = err instanceof TelegramApiError ? err.retryAfter : null
        await sleep(retryAfter !== null ? retryAfter * 1000 : backoff, signal)
        backoff = Math.min(backoff * 2, MAX_BACKOFF_MS)
      }
    }
  }

  // Остановленный цикл ещё может договорить запрос — его итог статус не трогает.
  private markRunning(signal: AbortSignal): void {
    if (signal.aborted) return
    this.state = 'running'
    this.error = null
  }

  private fail(signal: AbortSignal, message: string): void {
    if (signal.aborted) return
    this.state = 'error'
    this.error = message
  }

  private async handleUpdate(update: TgUpdate): Promise<void> {
    if (update.callback_query) return this.handleCallback(update.callback_query)
    const msg = update.message
    if (!msg || msg.chat.type !== 'private') return

    const bound = loadSettings().telegramChatId
    if (msg.chat.id !== bound) {
      // Чат уже привязан к другому человеку — посторонним не отвечаем вовсе.
      if (bound !== null) return
      return this.handlePairing(msg)
    }

    const input = messageInput(msg)
    if (input.kind === 'rejected') {
      await this.send(input.reply)
      return
    }
    if (input.kind === 'voice') {
      const text = await this.transcribeVoice(input.fileId)
      if (text === null) return
      await this.send(`🎙 ${text}`)
      await this.forward(text, true)
      return
    }
    const command = parseCommand(input.text)
    if (!command) return

    switch (command.kind) {
      case 'start':
      case 'help':
        await this.send(HELP_TEXT)
        return
      case 'status':
        await this.send(formatStatus(this.sessions.info))
        return
      case 'projects':
        await this.sendProjects()
        return
      case 'history': {
        const info = this.sessions.info
        if (!info) {
          await this.send('Проект не открыт. Выберите его: /projects')
          return
        }
        let sessions
        try {
          sessions = await this.sessions.history()
        } catch {
          await this.send('Не удалось прочитать историю.')
          return
        }
        await this.send(formatHistory(info.projectDir, sessions, info.sessionId))
        return
      }
      case 'stop': {
        const info = this.sessions.info
        if (!info || info.status === 'stopped' || info.assistant.phase === 'ready') {
          await this.send('Сейчас нечего останавливать.')
          return
        }
        this.sessions.interrupt()
        await this.send('Останавливаю.')
        return
      }
      case 'unknown':
        await this.send(`Не знаю команду /${command.name}.\n\n${HELP_TEXT}`)
        return
      case 'text':
        await this.forward(command.text, true)
        return
    }
  }

  /** Привязка: отвечаем только на `/start <код>` из настроек приложения. */
  private async handlePairing(msg: TgMessage): Promise<void> {
    const chatId = msg.chat.id
    const command = msg.text !== undefined ? parseCommand(msg.text) : null
    if (command?.kind !== 'start' || command.code === null) {
      await this.send(
        'Чтобы управлять Claude Voice Desk, откройте настройки приложения, получите код привязки и отправьте сюда /start <код>.',
        undefined,
        chatId
      )
      return
    }
    const { ok, next } = checkPairCode(this.pair, command.code, Date.now())
    this.pair = next
    if (!ok) {
      await this.send('Код неверный или устарел. Получите новый в настройках приложения.', undefined, chatId)
      return
    }
    saveSettings({ telegramChatId: chatId })
    await this.send(`✅ Бот привязан к этому чату.\n\n${HELP_TEXT}`)
    await this.send(formatStatus(this.sessions.info))
  }

  private async handleCallback(query: TgCallbackQuery): Promise<void> {
    const chatId = query.message?.chat.id
    const messageId = query.message?.message_id ?? null
    const action = parseCallback(query.data)
    const token = this.token
    if (!token || chatId === undefined || chatId !== loadSettings().telegramChatId || !action) {
      if (token) await this.answerCallback(token, query.id)
      return
    }

    if (action.kind === 'open') {
      const dir = this.projects.messageId === messageId ? this.projects.dirs[action.index] : undefined
      if (!dir) {
        await this.answerCallback(token, query.id, 'Список устарел — отправьте /projects')
        return
      }
      await this.answerCallback(token, query.id, `Открываю ${projectName(dir)}`)
      await this.dropKeyboard(token, chatId, messageId)
      // Ошибку запуска SessionManager сам пришлёт событием `error` — она дойдёт и сюда.
      void this.sessions.start(dir).catch(() => undefined)
      return
    }

    const phase = this.sessions.info?.assistant.phase
    if (messageId !== this.answerMessageId || phase !== action.phase) {
      await this.answerCallback(token, query.id, 'Уже неактуально')
      await this.dropKeyboard(token, chatId, messageId)
      return
    }
    this.answerMessageId = null
    await this.answerCallback(token, query.id, `«${action.text}»`)
    await this.dropKeyboard(token, chatId, messageId)
    await this.forward(action.text, false)
  }

  /**
   * Фраза с телефона — ассистенту, как сказанная голосом. `ack` — ответить, принят
   * ли текст (у кнопок вместо этого всплывающая подсказка).
   */
  private async forward(text: string, ack: boolean): Promise<void> {
    const info = this.sessions.info
    if (!info) {
      await this.send('Проект не открыт — выберите его:')
      await this.sendProjects()
      return
    }
    if (info.status === 'stopped') {
      await this.send('Claude Code завершился. Откройте проект заново: /projects')
      return
    }
    const { submit, reply } = replyFor(info.assistant.phase, text)
    if (submit) this.sessions.submit(text)
    if (reply && (ack || !submit)) await this.send(reply)
  }

  /**
   * Скачивает голосовое и распознаёт тем же движком, что и микрофон в приложении.
   * Возвращает текст или null, если пользователю уже сообщено об ошибке.
   */
  private async transcribeVoice(fileId: string): Promise<string | null> {
    const token = this.token
    const signal = this.controller?.signal
    if (!token || !signal) return null
    try {
      const file = await callApi<{ file_path?: string; file_size?: number }>(
        token,
        'getFile',
        { file_id: fileId },
        within(signal, REQUEST_MS)
      )
      if (!file.file_path) throw new Error('Telegram не отдал файл')
      if ((file.file_size ?? 0) > VOICE_MAX_BYTES) throw new Error('файл слишком большой')
      const audio = await downloadFile(token, file.file_path, within(signal, VOICE_DOWNLOAD_MS))
      const settings = loadSettings()
      const wav = await toWav16k(audio, 'ogg')
      const { text } = await getProvider(settings.sttProvider).transcribeWav(wav, settings.sttLocale)
      if (signal.aborted) return null
      if (!text.trim()) {
        await this.send('Не расслышал — в голосовом не нашлось речи.')
        return null
      }
      return text.trim()
    } catch (err) {
      if (signal.aborted) return null
      const hint = err instanceof SttError ? err.appError.hint : undefined
      console.error('[telegram] не удалось распознать голосовое:', describe(err))
      await this.send(`⚠️ Не удалось распознать голосовое: ${describe(err)}${hint ? `\n${hint}` : ''}`)
      return null
    }
  }

  private async sendProjects(): Promise<void> {
    const dirs = loadSettings().recentProjects
    if (dirs.length === 0) {
      await this.send('Недавних проектов нет — откройте папку в приложении на Mac.')
      return
    }
    const messageId = await this.send('Какой проект открыть?', projectsKeyboard(dirs))
    this.projects = { messageId, dirs }
  }

  // ───────────────────── События сессии ─────────────────────

  private onSession(info: SessionInfo | null): void {
    const { seen, notes } = sessionNotes(this.seen, info)
    this.seen = seen
    for (const note of notes) void this.announce(note)
  }

  private async announce(note: SessionNote): Promise<void> {
    switch (note.kind) {
      case 'opened':
        this.lastAnswer = null
        this.answerMessageId = null
        await this.send(`📂 Открыт проект ${projectName(note.dir)}. Пишите задачу.`)
        return
      case 'exited':
        await this.send('⏹ Claude Code завершился. Открыть проект: /projects')
        return
      case 'plan':
        await this.sendAnswerRequest(`📋 План\n\n${note.text}`, planKeyboard())
        return
      case 'question': {
        const options = note.options.map((o, i) => `${i + 1}. ${o}`).join('\n')
        const head = note.position ? `❓ ${note.position}\n\n${note.question}` : `❓ ${note.question}`
        const hint = note.multiSelect ? '\n\nМожно несколько — пришлите номера, например: 1 3' : ''
        await this.sendAnswerRequest(
          `${head}${options ? `\n\n${options}` : ''}${hint}`,
          note.multiSelect ? undefined : questionKeyboard(note.options)
        )
        return
      }
      case 'permission':
        await this.sendAnswerRequest(`⚠️ Рискованная команда — разрешить?\n\n${note.summary}`, permissionKeyboard())
        return
    }
  }

  private onTranscript(event: TranscriptEvent): void {
    if (event.kind === 'chat' && event.message.role === 'assistant') {
      this.lastAnswer = { id: event.message.id, text: event.message.text }
    } else if (event.kind === 'turn-end') {
      const answer = this.lastAnswer
      if (!answer || answer.id === this.sentAnswerId) return
      this.sentAnswerId = answer.id
      void this.send(`💬 ${answer.text}`)
    }
  }

  private onSay(text: string): void {
    if (Date.now() - this.lastNoteAt < SAY_AFTER_NOTE_MS) return
    void this.send(`🔔 ${text}`)
  }

  // ───────────────────── Отправка ─────────────────────

  private async sendAnswerRequest(text: string, keyboard?: InlineKeyboard): Promise<void> {
    this.lastNoteAt = Date.now()
    this.answerMessageId = null
    const id = await this.send(text, keyboard)
    if (id !== null) this.answerMessageId = id
  }

  /** Сообщение в привязанный чат (или в `chatId`); молчит, если бот остановлен. Возвращает id последней части или null. */
  private send(
    text: string,
    keyboard?: InlineKeyboard,
    chatId: number | null = loadSettings().telegramChatId
  ): Promise<number | null> {
    const token = this.token
    const signal = this.controller?.signal
    if (!token || !signal || chatId === null) return Promise.resolve(null)

    const task = this.outbox.then(async () => {
      const parts = splitMessage(text)
      let id: number | null = null
      for (const [i, part] of parts.entries()) {
        const markup = i === parts.length - 1 && keyboard ? { inline_keyboard: keyboard } : undefined
        id = await this.sendOne(token, chatId, part, markup, signal)
      }
      return id
    })
    this.outbox = task.catch(() => undefined)
    return task.catch((err: unknown) => {
      if (!signal.aborted) console.error('[telegram] не удалось отправить сообщение:', describe(err))
      return null
    })
  }

  private async sendOne(
    token: string,
    chatId: number,
    text: string,
    markup: { inline_keyboard: InlineKeyboard } | undefined,
    signal: AbortSignal
  ): Promise<number> {
    const body = {
      chat_id: chatId,
      text,
      link_preview_options: { is_disabled: true },
      ...(markup ? { reply_markup: markup } : {})
    }
    try {
      const msg = await callApi<TgMessage>(token, 'sendMessage', body, within(signal, REQUEST_MS))
      return msg.message_id
    } catch (err) {
      // Слишком часто — Telegram говорит, сколько подождать; повторяем один раз.
      if (!(err instanceof TelegramApiError) || err.retryAfter === null) throw err
      await sleep(err.retryAfter * 1000, signal)
      const msg = await callApi<TgMessage>(token, 'sendMessage', body, within(signal, REQUEST_MS))
      return msg.message_id
    }
  }

  private async answerCallback(token: string, queryId: string, text?: string): Promise<void> {
    const signal = this.controller?.signal ?? AbortSignal.timeout(REQUEST_MS)
    await callApi(token, 'answerCallbackQuery', { callback_query_id: queryId, ...(text ? { text } : {}) }, within(signal, REQUEST_MS)).catch(
      (err: unknown) => console.error('[telegram] answerCallbackQuery:', describe(err))
    )
  }

  /** Убирает кнопки, чтобы одно и то же нельзя было нажать дважды. */
  private async dropKeyboard(token: string, chatId: number, messageId: number | null): Promise<void> {
    if (messageId === null) return
    const signal = this.controller?.signal ?? AbortSignal.timeout(REQUEST_MS)
    await callApi(
      token,
      'editMessageReplyMarkup',
      { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
      within(signal, REQUEST_MS)
    ).catch((err: unknown) => console.error('[telegram] editMessageReplyMarkup:', describe(err)))
  }
}
