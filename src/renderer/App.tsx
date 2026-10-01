import { useCallback, useEffect, useRef, useState } from 'react'
import ProjectPicker from './components/ProjectPicker'
import StatusBar from './components/StatusBar'
import Chat from './components/Chat'
import Tasks from './components/Tasks'
import VoiceButton from './components/VoiceButton'
import AlwaysListen from './components/AlwaysListen'
import AssistantPanel from './components/AssistantPanel'
import Settings from './components/Settings'
import ProjectDrawer from './components/ProjectDrawer'
import HistoryPanel from './components/HistoryPanel'
import { useSession } from './useSession'
import { isSpeaking, stopSpeaking } from './speech'
import { isApprove, isStop } from '../shared/intents'
import type { Settings as SettingsData } from '../shared/types'

export default function App(): React.JSX.Element {
  const { info, messages, tasks, todos, error, start, resume, submit, dismissError, showError } =
    useSession()
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [projectOpen, setProjectOpen] = useState(false)
  const [settings, setSettings] = useState<SettingsData | null>(null)

  // Режим прослушивания и задержка живут в настройках — перечитываем после их закрытия.
  useEffect(() => {
    if (!settingsOpen) void window.desk.settings.get().then(setSettings)
  }, [settingsOpen])

  // Esc обрывает речь приложения. Перехватываем на погружении и только пока оно
  // говорит: иначе Esc очищал бы заодно черновик в поле ввода.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || !isSpeaking()) return
      e.preventDefault()
      e.stopPropagation()
      stopSpeaking()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  // ─── Черновик и автоотправка ───
  //
  // Речь дописывается в поле ввода, а отправка ждёт паузы: вдруг вы хотите
  // что-то добавить. Пока вы говорите или фраза ещё распознаётся, отсчёт стоит.
  const [draft, setDraft] = useState('')
  const [fromVoice, setFromVoice] = useState(false)
  const [typed, setTyped] = useState(false)
  const [hearing, setHearing] = useState(false)
  const [pending, setPending] = useState(0)
  const [micOn, setMicOn] = useState(true)
  const [countdown, setCountdown] = useState<{ startedAt: number; durationMs: number } | null>(null)

  const phase = info?.assistant.phase

  const send = useCallback(
    (text: string, voice: boolean) => {
      if (!text.trim()) return
      void submit(text.trim(), voice)
      setDraft('')
      setFromVoice(false)
      setTyped(false)
      setCountdown(null)
    },
    [submit]
  )

  const onVoiceText = useCallback(
    (text: string) => {
      // Короткие команды не ждут паузы: «стоп» должен сработать сразу,
      // «выполняй» над готовым планом — тоже.
      if (!draft.trim() && (isStop(text) || (phase === 'plan-ready' && isApprove(text)))) {
        send(text, true)
        return
      }
      setDraft((d) => (d.trim() ? `${d.trim()} ${text}` : text))
      setFromVoice(true)
    },
    [draft, phase, send]
  )

  const delayMs = Math.round((settings?.sendDelaySec ?? 3) * 1000)
  const draftRef = useRef(draft)
  draftRef.current = draft

  useEffect(() => {
    // Вручную набранный текст уходит по Enter — его автоматически не отправляем.
    const ready = draft.trim() !== '' && fromVoice && !typed && !hearing && pending === 0
    if (!ready) {
      setCountdown(null)
      return
    }
    setCountdown({ startedAt: Date.now(), durationMs: delayMs })
    const timer = setTimeout(() => send(draftRef.current, true), delayMs)
    return () => clearTimeout(timer)
  }, [draft, fromVoice, typed, hearing, pending, delayMs, send])

  // Озвучку делает main; выключение звука там же обрывает текущую фразу.
  const speakOn = settings?.speak ?? true
  const toggleSound = useCallback(() => {
    void window.desk.settings.set({ speak: !speakOn }).then(setSettings)
  }, [speakOn])

  const stop = useCallback(async () => {
    await window.desk.session.stop()
  }, [])

  const interrupt = useCallback(() => {
    void window.desk.session.interrupt()
  }, [])

  const openTerminal = useCallback(() => {
    void window.desk.session.openTerminal()
  }, [])

  // ─── История ───
  //
  // Пока прошлая сессия запускается, main успевает сообщить «сессии нет» —
  // без этого флага окно на секунду мигнуло бы выбором проекта.
  const [resuming, setResuming] = useState(false)
  const resumeSession = useCallback(
    async (id: string) => {
      setResuming(true)
      try {
        await resume(id)
      } finally {
        setResuming(false)
      }
    },
    [resume]
  )

  const historyOpen = settings?.historyOpen ?? true
  const setHistoryOpen = useCallback((open: boolean) => {
    void window.desk.settings.set({ historyOpen: open }).then(setSettings)
  }, [])

  const banner = error && (
    <div className="banner" role="alert">
      <div className="banner__body">
        <strong className="banner__title">{error.message}</strong>
        {error.hint && <span className="banner__hint">{error.hint}</span>}
      </div>
      {error.hint && (
        <button
          className="btn btn--ghost btn--small"
          onClick={() => void navigator.clipboard.writeText(error.hint ?? '')}
        >
          Копировать
        </button>
      )}
      <button className="banner__close" onClick={dismissError} aria-label="Скрыть">
        ×
      </button>
    </div>
  )

  const settingsModal = settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />

  // Нет сессии (или она завершена) — возвращаем пользователя к выбору проекта.
  if (resuming && (!info || info.status === 'stopped')) {
    return (
      <div className="app app--picker">
        <div className="picker">
          <p className="muted">Открываю сессию…</p>
        </div>
      </div>
    )
  }

  if (!info || info.status === 'stopped') {
    return (
      <div className="app app--picker">
        {banner}
        <ProjectPicker onOpen={(dir) => void start(dir)} onOpenSettings={() => setSettingsOpen(true)} />
        {settingsModal}
      </div>
    )
  }

  const voiceSlot =
    settings === null ? null : settings.listenMode === 'always' ? (
      <AlwaysListen
        enabled={micOn}
        bargeIn={settings?.bargeIn ?? true}
        onToggle={() => setMicOn((on) => !on)}
        onText={onVoiceText}
        onHearing={setHearing}
        onPending={setPending}
        onError={showError}
        onDisable={() => setMicOn(false)}
      />
    ) : (
      <VoiceButton onTranscript={onVoiceText} onError={showError} />
    )

  return (
    <div className="app">
      <StatusBar
        info={info}
        onOpenTerminal={openTerminal}
        onStop={() => void stop()}
        onBack={() => void stop()}
        onOpenSettings={() => setSettingsOpen(true)}
        soundOn={speakOn}
        onToggleSound={toggleSound}
        onOpenProject={() => setProjectOpen(true)}
        historyOpen={historyOpen}
        onToggleHistory={() => setHistoryOpen(!historyOpen)}
      />
      {banner}
      <main className={`workspace${historyOpen ? ' workspace--history' : ''}`}>
        {historyOpen && (
          <HistoryPanel
            currentId={info.sessionId}
            // Перечитываем, когда ход закончился, сменилась сессия или её название.
            refreshKey={`${info.sessionId}:${info.assistant.phase === 'ready'}:${info.title ?? ''}`}
            canResume={info.assistant.phase === 'ready'}
            onResume={(id) => void resumeSession(id)}
            onClose={() => setHistoryOpen(false)}
          />
        )}
        <Chat
          messages={messages}
          draft={draft}
          onDraftChange={(text) => {
            setDraft(text)
            setTyped(true)
          }}
          onSubmit={() => send(draft, fromVoice && !typed)}
          onClearDraft={() => {
            setDraft('')
            setTyped(false)
            setFromVoice(false)
          }}
          onInterrupt={interrupt}
          busy={info.status === 'working'}
          countdown={countdown}
          header={
            <AssistantPanel
              state={info.assistant}
              onSay={(text) => send(text, false)}
              onPermission={(allow) => void window.desk.session.answerPermission(allow)}
            />
          }
          voiceSlot={voiceSlot}
        />
        <Tasks tasks={tasks} todos={todos} />
      </main>
      {projectOpen && (
        <ProjectDrawer
          state={info.assistant}
          // Перечитываем сведения, когда задача закончилась или появилась новая точка отката.
          refreshKey={`${info.assistant.phase === 'ready'}:${info.assistant.checkpoint}:${info.assistant.checks.length}`}
          onClose={() => setProjectOpen(false)}
          onSay={(text) => {
            setProjectOpen(false)
            send(text, false)
          }}
        />
      )}
      {settingsModal}
    </div>
  )
}
