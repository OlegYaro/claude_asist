import { useEffect, useRef, useState } from 'react'
import { ContinuousListener, MicPermissionError } from '../recorder'
import { isSpeaking, onSpeaking, speechBetween, stopSpeaking } from '../speech'
import { isEcho } from '../../shared/echo'

interface Props {
  /** Микрофон включён. */
  enabled: boolean
  /** Перебивать приложение голосом: пока оно говорит, слушаем с повышенным порогом. */
  bargeIn: boolean
  onToggle: () => void
  /** Распознанная фраза — дописывается в поле ввода. */
  onText: (text: string) => void
  /** Детектор слышит речь — пока вы говорите, отправку откладываем. */
  onHearing: (active: boolean) => void
  /** Сколько фраз ещё распознаётся. */
  onPending: (count: number) => void
  onError: (message: string) => void
  /** Не удалось включить микрофон — выключаем режим. */
  onDisable: () => void
}

type Phase = 'off' | 'listening' | 'hearing' | 'muted'

/** Сколько звука детектор берёт до срабатывания (`PREROLL_MS` в recorder.ts) — с запасом. */
const PREROLL_MS = 500
/** Сколько показывать на кнопке, что фраза отброшена как эхо. */
const ECHO_NOTE_MS = 4000

/**
 * Постоянное прослушивание. Детектор голоса нарезает речь на фразы, каждая
 * распознаётся локально и дописывается в поле ввода; когда отправлять, решает
 * App — после паузы, чтобы можно было договорить.
 */
export default function AlwaysListen(props: Props): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('off')
  const [pending, setPending] = useState(0)

  // Колбэки слушателя живут дольше одного рендера — читаем свежие props через ref.
  const propsRef = useRef(props)
  propsRef.current = props
  const queueRef = useRef<Promise<void>>(Promise.resolve())
  const listenerRef = useRef<ContinuousListener | null>(null)
  const segmentStartRef = useRef(0)
  /** Фраза, отброшенная как эхо собственной речи, — показываем, чтобы вы её повторили. */
  const [echoNote, setEchoNote] = useState<string | null>(null)

  useEffect(() => {
    if (!echoNote) return
    const timer = setTimeout(() => setEchoNote(null), ECHO_NOTE_MS)
    return () => clearTimeout(timer)
  }, [echoNote])
  const pendingRef = useRef(0)

  const bumpPending = (delta: number): void => {
    pendingRef.current += delta
    setPending(pendingRef.current)
    propsRef.current.onPending(pendingRef.current)
  }

  useEffect(() => {
    if (!props.enabled) {
      setPhase('off')
      return
    }

    const listener = new ContinuousListener({
      onSpeech: (active) => {
        if (active) segmentStartRef.current = Date.now() - PREROLL_MS
        // Вы заговорили поверх приложения — оно замолкает и слушает вас.
        if (active && isSpeaking()) stopSpeaking()
        setPhase(active ? 'hearing' : isSpeaking() ? 'muted' : 'listening')
        propsRef.current.onHearing(active)
      },
      onSegment: (wav, overlapped) => {
        bumpPending(1)
        // Сверяем только с фразами, звучавшими, пока вы говорили; берём их сразу,
        // к концу распознавания список уже сдвинется.
        const spoken = overlapped ? speechBetween(segmentStartRef.current, Date.now()) : []
        // Распознаём по очереди: хелпер тяжёлый, а порядок фраз важен.
        queueRef.current = queueRef.current.then(async () => {
          try {
            const { text } = await window.desk.stt.transcribe(await wav.arrayBuffer())
            // Остаток собственной речи из колонок — не ваша команда.
            if (overlapped && isEcho(text, spoken)) {
              setEchoNote(text.trim())
              return
            }
            if (text.trim()) propsRef.current.onText(text.trim())
          } catch {
            // Ошибка одной фразы не повод выключать прослушивание; баннер покажет main.
          } finally {
            bumpPending(-1)
          }
        })
      }
    })

    listenerRef.current = listener
    applySpeaking(listener, isSpeaking())
    const offSpeaking = onSpeaking((speaking) => {
      applySpeaking(listener, speaking)
      setPhase(speaking ? 'muted' : 'listening')
    })

    let cancelled = false
    listener
      .start()
      .then(() => {
        if (cancelled) void listener.stop()
        else setPhase(isSpeaking() ? 'muted' : 'listening')
      })
      .catch((err) => {
        propsRef.current.onDisable()
        propsRef.current.onError(
          err instanceof MicPermissionError
            ? 'Нет доступа к микрофону. Разрешите его в Системных настройках → Конфиденциальность и безопасность → Микрофон.'
            : 'Не удалось включить микрофон'
        )
      })

    return () => {
      cancelled = true
      listenerRef.current = null
      offSpeaking()
      void listener.stop()
      propsRef.current.onHearing(false)
    }
  }, [props.enabled])

  // Переключили «перебивать голосом» в настройках — режим меняется без перезапуска микрофона.
  useEffect(() => {
    if (listenerRef.current) applySpeaking(listenerRef.current, isSpeaking())
  }, [props.bargeIn])

  /**
   * Пока приложение говорит: либо слушаем с повышенным порогом (можно перебить),
   * либо глохнем совсем — иначе оно услышит себя.
   */
  function applySpeaking(listener: ContinuousListener, speaking: boolean): void {
    const bargeIn = propsRef.current.bargeIn
    listener.setMuted(speaking && !bargeIn)
    listener.setBargeIn(speaking && bargeIn)
  }

  const onClick = (): void => {
    // Пока приложение говорит, кнопка обрывает речь, а не выключает микрофон.
    if (props.enabled && isSpeaking()) stopSpeaking()
    else props.onToggle()
  }

  const label = echoNote
    ? 'Похоже на эхо — повторите'
    : phase === 'off'
      ? 'Микрофон выкл.'
      : phase === 'hearing'
        ? 'Слышу…'
        : phase === 'muted'
          ? 'Говорю… Esc — стоп'
          : pending > 0
            ? 'Распознаю…'
            : 'Слушаю'

  return (
    <button
      className={`mic mic--always mic--${phase}${pending > 0 ? ' mic--busy' : ''}`}
      onClick={onClick}
      title={
        echoNote
          ? `Фраза «${echoNote}» совпала с тем, что приложение само говорило, и не отправлена. Если это были вы — повторите.`
          : phase === 'muted'
          ? props.bargeIn
            ? 'Приложение говорит. Перебейте голосом или нажмите (Esc), чтобы замолчало.'
            : 'Приложение говорит. Нажмите (или Esc), чтобы замолчало.'
          : props.enabled
            ? 'Микрофон слушает постоянно. Нажмите, чтобы выключить.'
            : 'Нажмите, чтобы включить микрофон'
      }
      aria-pressed={props.enabled}
    >
      <span className="mic__icon">{phase === 'off' ? '🔇' : '🎙'}</span>
      <span className="mic__label">{label}</span>
    </button>
  )
}
