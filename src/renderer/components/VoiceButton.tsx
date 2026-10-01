import { useCallback, useEffect, useRef, useState } from 'react'
import { MicPermissionError, Recorder } from '../recorder'

interface Props {
  /** Вызывается с расшифровкой; пустая строка означает «ничего не распознано». */
  onTranscript: (text: string) => void
  onError: (message: string) => void
  disabled?: boolean
}

type Phase = 'idle' | 'recording' | 'transcribing'

/**
 * Push-to-talk: запись идёт, пока кнопка удерживается (мышью или пробелом).
 * Так пользователю не нужно попадать в кнопку второй раз, чтобы остановить запись,
 * и не бывает случайно оставленного включённым микрофона.
 */
export default function VoiceButton({
  onTranscript,
  onError,
  disabled = false
}: Props): React.JSX.Element {
  const [phase, setPhase] = useState<Phase>('idle')
  const recorderRef = useRef<Recorder | null>(null)
  const phaseRef = useRef<Phase>('idle')

  const setPhaseBoth = (next: Phase): void => {
    phaseRef.current = next
    setPhase(next)
  }

  // Кнопку отпустили, пока микрофон ещё включался (getUserMedia асинхронный,
  // а в первый раз macOS показывает запрос разрешения). Без этого флага stop()
  // приходил раньше старта и запись оставалась включённой навсегда.
  const releasedRef = useRef(false)
  const startingRef = useRef(false)

  const stop = useCallback(async () => {
    if (startingRef.current) {
      releasedRef.current = true
      return
    }
    const recorder = recorderRef.current
    if (!recorder || phaseRef.current !== 'recording') return
    recorderRef.current = null
    setPhaseBoth('transcribing')

    try {
      const wav = await recorder.stop()
      if (!wav) {
        setPhaseBoth('idle')
        return // слишком короткое нажатие — молча игнорируем
      }
      const { text } = await window.desk.stt.transcribe(await wav.arrayBuffer())
      if (text.trim()) {
        onTranscript(text.trim())
      } else {
        onError('Ничего не удалось разобрать — попробуйте ещё раз')
      }
    } catch (err) {
      onError(err instanceof Error ? err.message : 'Ошибка распознавания')
    } finally {
      setPhaseBoth('idle')
    }
  }, [onError, onTranscript])

  const start = useCallback(async () => {
    if (phaseRef.current !== 'idle' || startingRef.current || disabled) return
    startingRef.current = true
    releasedRef.current = false
    const recorder = new Recorder()
    recorderRef.current = recorder
    try {
      await recorder.start()
      setPhaseBoth('recording')
    } catch (err) {
      recorderRef.current = null
      setPhaseBoth('idle')
      onError(
        err instanceof MicPermissionError
          ? 'Нет доступа к микрофону. Разрешите его в Системных настройках → Конфиденциальность и безопасность → Микрофон.'
          : 'Не удалось начать запись'
      )
      return
    } finally {
      startingRef.current = false
    }
    if (releasedRef.current) {
      releasedRef.current = false
      void stop()
    }
  }, [disabled, onError, stop])

  // Пробел как глобальный push-to-talk, но не когда пользователь печатает.
  useEffect(() => {
    const isTyping = (target: EventTarget | null): boolean =>
      target instanceof HTMLElement &&
      (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || e.repeat || isTyping(e.target)) return
      e.preventDefault()
      void start()
    }
    const onKeyUp = (e: KeyboardEvent): void => {
      if (e.code !== 'Space' || isTyping(e.target)) return
      e.preventDefault()
      void stop()
    }

    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [start, stop])

  const label =
    phase === 'recording' ? 'Говорите…' : phase === 'transcribing' ? 'Распознаю…' : 'Удерживайте'

  return (
    <button
      className={`mic mic--${phase}`}
      disabled={disabled || phase === 'transcribing'}
      onMouseDown={() => void start()}
      onMouseUp={() => void stop()}
      // Курсор мог уйти с кнопки до отпускания — иначе запись зависнет.
      onMouseLeave={() => void stop()}
      title="Удерживайте кнопку или пробел, чтобы говорить"
    >
      <span className="mic__icon">{phase === 'transcribing' ? '⋯' : '🎤'}</span>
      <span className="mic__label">{label}</span>
    </button>
  )
}
