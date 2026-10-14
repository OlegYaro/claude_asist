import type {
  AppError,
  HistorySession,
  ProjectChanges,
  ProjectOverview,
  SessionInfo,
  Settings,
  SpeechClip,
  SttStatus,
  TelegramStatus,
  TranscriptEvent
} from './types'

/**
 * Поверхность, которую preload выставляет в `window.desk`.
 *
 * Живёт в shared, а не в preload, чтобы renderer не импортировал код из другого
 * tsconfig-проекта: оба просто ссылаются на один интерфейс, и любое расхождение
 * ловится компилятором на обеих сторонах.
 */
export interface DeskApi {
  settings: {
    get(): Promise<Settings>
    set(patch: Partial<Settings>): Promise<Settings>
    forgetProject(dir: string): Promise<Settings>
  }

  project: {
    pick(): Promise<string | null>
    /** Стек, команды, CLAUDE.md, git — для панели «Проект». */
    overview(): Promise<ProjectOverview | null>
    /** Что изменилось в последней задаче с правками. */
    changes(): Promise<ProjectChanges | null>
    /** Дифф одного файла относительно точки отката. */
    diff(path: string): Promise<string>
  }

  session: {
    start(dir: string): Promise<SessionInfo | null>
    /** Продолжить прошлую сессию текущего проекта; текущая закрывается. */
    resume(id: string): Promise<SessionInfo | null>
    info(): Promise<SessionInfo | null>
    /** Подключить плагин, о котором просит Claude, и перезапустить Claude Code в той же сессии. */
    enablePlugin(id: string): Promise<SessionInfo | null>
    /** Отказаться от просьбы подключить плагин. */
    dismissPlugin(): Promise<void>
    stop(): Promise<void>
    openTerminal(): Promise<void>
    /** Команда для присоединения вручную, если автооткрытие Terminal.app не сработало. */
    attachCommand(): Promise<string | null>
    /** Фраза пользователя: ассистент сам решит — новая задача, «выполняй», замечание или стоп. */
    submit(text: string): Promise<void>
    /** Ответ на запрос рискованной команды. */
    answerPermission(allow: boolean): Promise<void>
    interrupt(): Promise<void>
  }

  /** Панель «История»: сессии текущего проекта и запросы в них. */
  history: {
    list(): Promise<HistorySession[]>
  }

  claude: {
    probe(): Promise<{ bin: string | null; version: string | null }>
  }

  stt: {
    /** Готовность движка распознавания и языковой модели. */
    probe(locale?: string): Promise<SttStatus>
    /** WAV 16 кГц моно → текст. Распознавание идёт локально. */
    transcribe(wav: ArrayBuffer, locale?: string): Promise<{ text: string; engine: string }>
  }

  /** Озвучка: синтез и очередь в main, звук играет окно (`src/renderer/speech.ts`). */
  speech: {
    /** Замолчать сейчас: оборвать фразу и очередь. */
    stop(): Promise<void>
    /** Перечитать установленные русские голоса, лучшие первыми. */
    voices(): Promise<string[]>
    /** Сказать пробную фразу текущим голосом и скоростью. */
    preview(): Promise<void>
    /** Окно доиграло (или оборвало) фразу `id`. */
    ended(id: number): Promise<void>
  }

  /** Ключ никогда не покидает main-процесс — наружу только факт его наличия. */
  secrets: {
    status(): Promise<{ hasKey: boolean; source: 'stored' | 'env' | 'none'; canStore: boolean }>
    setKey(value: string): Promise<void>
    clearKey(): Promise<void>
  }

  /** Telegram-бот: токен, как и API-ключ, в renderer не попадает. */
  telegram: {
    status(): Promise<TelegramStatus>
    /** Проверяет токен у Telegram, сохраняет и запускает бота. */
    setToken(value: string): Promise<TelegramStatus>
    clearToken(): Promise<TelegramStatus>
    setEnabled(enabled: boolean): Promise<TelegramStatus>
    /** Новый одноразовый код привязки чата. */
    pair(): Promise<TelegramStatus>
    unbind(): Promise<TelegramStatus>
  }

  /** Подписки; каждая возвращает функцию отписки. */
  on: {
    transcriptEvent(cb: (event: TranscriptEvent) => void): () => void
    sessionUpdate(cb: (info: SessionInfo | null) => void): () => void
    appError(cb: (error: AppError) => void): () => void
    /** Приложение говорит (озвучка в main) — микрофон на это время глохнет. */
    speaking(cb: (speaking: boolean) => void): () => void
    /** Сыграть фразу: WAV от `say` и её текст (для отсева эха). */
    speechPlay(cb: (clip: SpeechClip) => void): () => void
    /** Оборвать фразу `id`. */
    speechCancel(cb: (id: number) => void): () => void
  }
}
