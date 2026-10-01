import { app, BrowserWindow, Menu, ipcMain, dialog, shell } from 'electron'
import { join } from 'node:path'
import { SessionManager } from './session-manager'
import { loadSettings, saveSettings, forgetProject } from './settings'
import { resolveClaudeBin, claudeVersion } from './paths'
import { getProvider, SttError } from './stt'
import { clearApiKey, hasApiKey, isEncryptionAvailable, keySource, setApiKey } from './secrets'
import { TelegramBot } from './telegram/telegram-bot'
import { Speaker, VoiceCatalog, WindowVoice, hasLiveVoice, type SpeechConfig } from './speaker'
import { speechPhrases } from './speech-text'
import {
  PUSH_CHANNELS,
  type AppError,
  type HistorySession,
  type SessionInfo,
  type Settings,
  type SpeechClip,
  type SttStatus,
  type TelegramStatus,
  type TranscriptEvent
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
const sessions = new SessionManager()
const telegram = new TelegramBot(sessions)
const voices = new VoiceCatalog()
const speechConfig = async (): Promise<SpeechConfig> => {
  const { speechVoice, speechRate } = loadSettings()
  return { voice: await voices.resolve(speechVoice), rate: speechRate }
}
// Звук играет окно: эхоподавление Chromium вычитает из микрофона только то,
// что играет само приложение, — иначе перебить речь голосом нельзя.
const windowVoice = new WindowVoice(
  {
    ready: () => !!mainWindow && !mainWindow.isDestroyed() && !mainWindow.webContents.isLoading(),
    play: (id, wav, text) => push<SpeechClip>(PUSH_CHANNELS.speechPlay, { id, wav, text }),
    cancel: (id) => push(PUSH_CHANNELS.speechCancel, id)
  },
  speechConfig
)
const speaker = new Speaker(windowVoice.run, windowVoice.hooks)

let basicVoiceWarned = false
/**
 * Установлены только компактные голоса — озвучка звучит как робот, и выбор в
 * настройках этого не исправит. Раз за запуск говорим, где скачать голос живее.
 */
async function warnBasicVoice(): Promise<void> {
  if (basicVoiceWarned || !loadSettings().speak) return
  const installed = await voices.voices()
  if (installed.length === 0 || hasLiveVoice(installed)) return
  basicVoiceWarned = true
  push<AppError>(PUSH_CHANNELS.appError, {
    code: 'voice-basic',
    message: 'Установлен только простой русский голос — озвучка звучит как робот',
    hint:
      'Системные настройки → Универсальный доступ → Устное содержимое → Системный голос → ' +
      'Управление голосами → Русский → «Милена (улучшенный)» или «(премиум)». ' +
      'Затем выберите его в настройках приложения.'
  })
}

// Русская локаль Chromium: системные диалоги, контекстное меню, проверка орфографии.
app.commandLine.appendSwitch('lang', 'ru')

/** Стандартное меню Electron английское — собираем своё, на русском. */
function buildMenu(): void {
  const name = app.name
  const template: Electron.MenuItemConstructorOptions[] = [
    {
      label: name,
      submenu: [
        { role: 'about', label: `О программе ${name}` },
        { type: 'separator' },
        { role: 'services', label: 'Службы' },
        { type: 'separator' },
        { role: 'hide', label: `Скрыть ${name}` },
        { role: 'hideOthers', label: 'Скрыть остальные' },
        { role: 'unhide', label: 'Показать все' },
        { type: 'separator' },
        { role: 'quit', label: `Завершить ${name}` }
      ]
    },
    {
      label: 'Правка',
      submenu: [
        { role: 'undo', label: 'Отменить' },
        { role: 'redo', label: 'Повторить' },
        { type: 'separator' },
        { role: 'cut', label: 'Вырезать' },
        { role: 'copy', label: 'Копировать' },
        { role: 'paste', label: 'Вставить' },
        { role: 'selectAll', label: 'Выбрать все' }
      ]
    },
    {
      label: 'Вид',
      submenu: [
        { role: 'reload', label: 'Перезагрузить' },
        { role: 'toggleDevTools', label: 'Инструменты разработчика' },
        { type: 'separator' },
        { role: 'resetZoom', label: 'Реальный размер' },
        { role: 'zoomIn', label: 'Увеличить' },
        { role: 'zoomOut', label: 'Уменьшить' },
        { type: 'separator' },
        { role: 'togglefullscreen', label: 'Полноэкранный режим' }
      ]
    },
    {
      label: 'Окно',
      submenu: [
        { role: 'minimize', label: 'Свернуть' },
        { role: 'zoom', label: 'Изменить масштаб' },
        { role: 'close', label: 'Закрыть окно' },
        { type: 'separator' },
        { role: 'front', label: 'Все окна — на передний план' }
      ]
    }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1080,
    height: 760,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'Claude Voice Desk',
    titleBarStyle: 'hiddenInset',
    backgroundColor: '#12100e',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // Постоянное прослушивание должно работать и в свёрнутом окне.
      backgroundThrottling: false,
      // Озвучка играет в окне без клика пользователя.
      autoplayPolicy: 'no-user-gesture-required'
    }
  })

  // CVD_HIDDEN=1 — для автотестов: окно не показываем, управление идёт через DevTools.
  if (process.env['CVD_HIDDEN'] !== '1') mainWindow.once('ready-to-show', () => mainWindow?.show())

  // Внешние ссылки — в браузер, а не в окно приложения.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  // Renderer знает «приложение говорит» только по push-событиям смены состояния.
  // После повторного открытия окна или перезагрузки посреди фразы он начал бы
  // с `false` и включил микрофон под собственную речь — сообщаем текущее состояние.
  mainWindow.webContents.on('did-finish-load', () => {
    push(PUSH_CHANNELS.speaking, speaker.isSpeaking)
    void warnBasicVoice()
  })
  // Перезагрузка или закрытие окна обрывают звук — не ждём, что оно доиграет.
  mainWindow.webContents.on('did-start-loading', () => windowVoice.endAll())
  mainWindow.on('closed', () => windowVoice.endAll())

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    void mainWindow.loadURL(devUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function push<T>(channel: string, payload: T): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

sessions.on('session', (info: SessionInfo | null) =>
  push(PUSH_CHANNELS.sessionUpdate, info)
)
sessions.on('transcript', (event: TranscriptEvent) =>
  push(PUSH_CHANNELS.transcriptEvent, event)
)
// Переписка продолженной сессии — в тот же чат окна, но отдельным событием,
// чтобы Telegram-бот (он слушает `transcript`) не принял её за новые ответы.
sessions.on('history', (event: TranscriptEvent) => push(PUSH_CHANNELS.transcriptEvent, event))
sessions.on('error', (error: AppError) => push(PUSH_CHANNELS.appError, error))
// Озвучка коротких событий: «План готов», «Готово», вопросы.
sessions.on('say', (text: string) => {
  if (loadSettings().speak) speaker.say(text)
})
speaker.on('speaking', (speaking: boolean) => push(PUSH_CHANNELS.speaking, speaking))

// Итоговый ответ Claude вслух — как в Telegram-боте: последнее сообщение хода
// читаем по turn-end, один раз. Переписка продолженной сессии идёт событием
// `history` и сюда не попадает.
let lastReply: { id: string; text: string } | null = null
let spokenReplyId: string | null = null
sessions.on('transcript', (event: TranscriptEvent) => {
  if (event.kind === 'chat' && event.message.role === 'assistant') {
    lastReply = { id: event.message.id, text: event.message.text }
  } else if (event.kind === 'turn-end') {
    const reply = lastReply
    if (!reply || reply.id === spokenReplyId) return
    spokenReplyId = reply.id
    const { speak, speakReplies } = loadSettings()
    if (speak && speakReplies) speechPhrases(reply.text).forEach((phrase) => speaker.say(phrase))
  }
})

function registerIpc(): void {
  ipcMain.handle('settings:get', (): Settings => loadSettings())
  ipcMain.handle('settings:set', (_e, patch: Partial<Settings>): Settings => {
    if (patch.speak === false || patch.speakReplies === false) speaker.stop()
    return saveSettings(patch)
  })
  ipcMain.handle('speech:stop', (): void => speaker.stop())
  ipcMain.handle('speech:voices', (): Promise<string[]> => voices.refresh())
  ipcMain.handle('speech:preview', (): void => {
    speaker.stop()
    speaker.say('Здравствуйте! Так звучит выбранный голос.')
  })
  ipcMain.handle('speech:ended', (_e, id: number): void => windowVoice.ended(id))
  ipcMain.handle('settings:forget-project', (_e, dir: string): Settings => forgetProject(dir))

  ipcMain.handle('project:pick', async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Выберите папку проекта',
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Открыть'
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('session:start', async (_e, dir: string): Promise<SessionInfo | null> => {
    try {
      return await sessions.start(dir)
    } catch {
      // Подробная ошибка уже ушла в renderer через канал appError.
      return null
    }
  })
  ipcMain.handle('session:resume', async (_e, id: string): Promise<SessionInfo | null> => {
    try {
      return await sessions.resume(id)
    } catch {
      // Подробная ошибка уже ушла в renderer через канал appError.
      return null
    }
  })
  ipcMain.handle('session:info', (): SessionInfo | null => sessions.info)
  ipcMain.handle('history:list', (): Promise<HistorySession[]> => sessions.history())
  ipcMain.handle('session:stop', async (): Promise<void> => sessions.stop())
  ipcMain.handle('session:open-terminal', async (): Promise<void> => sessions.openTerminal())
  ipcMain.handle('session:attach-command', async (): Promise<string | null> =>
    sessions.attachCommand()
  )
  ipcMain.handle('session:submit', (_e, text: string): void => sessions.submit(text))
  ipcMain.handle('session:answer-permission', (_e, allow: boolean): void =>
    sessions.answerPermission(allow)
  )
  ipcMain.handle('session:interrupt', (): void => sessions.interrupt())
  ipcMain.handle('project:overview', () => sessions.overview())
  ipcMain.handle('project:changes', () => sessions.changes())
  ipcMain.handle('project:diff', (_e, path: string) => sessions.diff(path))

  ipcMain.handle('claude:probe', async (): Promise<{ bin: string | null; version: string | null }> => {
    const bin = await resolveClaudeBin(loadSettings().claudeBinPath)
    return { bin, version: bin ? await claudeVersion(bin) : null }
  })

  ipcMain.handle('stt:probe', async (_e, locale?: string): Promise<SttStatus> => {
    const settings = loadSettings()
    try {
      const result = await getProvider(settings.sttProvider).probe(locale ?? settings.sttLocale)
      return result
    } catch (err) {
      const detail = err instanceof SttError ? err.appError.message : 'Модуль распознавания недоступен'
      return { available: false, installed: false, detail }
    }
  })

  ipcMain.handle(
    'stt:transcribe',
    async (_e, wav: ArrayBuffer, locale?: string): Promise<{ text: string; engine: string }> => {
      const settings = loadSettings()
      try {
        const result = await getProvider(settings.sttProvider).transcribeWav(
          Buffer.from(wav),
          locale ?? settings.sttLocale
        )
        return { text: result.text, engine: result.engine }
      } catch (err) {
        if (err instanceof SttError) {
          push(PUSH_CHANNELS.appError, err.appError)
          throw new Error(err.appError.message)
        }
        throw err
      }
    }
  )

  ipcMain.handle('secrets:status', () => ({
    hasKey: hasApiKey(),
    source: keySource(),
    canStore: isEncryptionAvailable()
  }))
  ipcMain.handle('secrets:set-key', (_e, value: string): void => setApiKey(value))
  ipcMain.handle('secrets:clear-key', (): void => clearApiKey())

  ipcMain.handle('telegram:status', (): TelegramStatus => telegram.status())
  ipcMain.handle('telegram:set-token', (_e, value: string): Promise<TelegramStatus> =>
    telegram.setToken(value)
  )
  ipcMain.handle('telegram:clear-token', (): TelegramStatus => telegram.clearToken())
  ipcMain.handle('telegram:set-enabled', (_e, enabled: boolean): TelegramStatus =>
    telegram.setEnabled(enabled)
  )
  ipcMain.handle('telegram:pair', (): TelegramStatus => telegram.pairCode())
  ipcMain.handle('telegram:unbind', (): TelegramStatus => telegram.unbind())
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.krip.claude-voice-desk')
  buildMenu()
  registerIpc()
  createWindow()
  // Бот поднимается сам при запуске, ещё до выбора папки: с телефона можно
  // сразу открыть проект. Без токена или выключенный — просто не стартует.
  telegram.start()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // Сессия живёт вместе с окном: осиротевший PTY нам не нужен.
  void sessions.stop()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  // В window-all-closed бота не гасим: на macOS приложение живёт без окна,
  // и с телефона можно открыть проект заново.
  telegram.stop()
  speaker.stop()
  void sessions.stop()
})
