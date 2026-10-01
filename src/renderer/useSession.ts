import { useCallback, useEffect, useReducer } from 'react'
import type {
  AppError,
  ChatMessage,
  SessionInfo,
  TodoItem,
  ToolTask,
  TranscriptEvent
} from '../shared/types'

interface State {
  info: SessionInfo | null
  /** Последняя известная сессия — переживает null между остановкой и новым запуском. */
  sessionId: string | null
  messages: ChatMessage[]
  tasks: ToolTask[]
  todos: TodoItem[]
  error: AppError | null
}

type Action =
  | { t: 'session'; info: SessionInfo | null }
  | { t: 'transcript'; event: TranscriptEvent }
  | { t: 'error'; error: AppError | null }
  | { t: 'local-message'; message: ChatMessage }
  | { t: 'reset' }

/** Сколько последних строк держит панель «Действия». */
const MAX_TASKS = 500

const initial: State = { info: null, sessionId: null, messages: [], tasks: [], todos: [], error: null }

function reduce(state: State, action: Action): State {
  switch (action.t) {
    case 'reset':
      return initial

    case 'session':
      // Смена sessionId — это другая сессия, чужую переписку показывать нельзя.
      // Сравниваем с последней известной: при переключении main сначала
      // сообщает «сессии нет» (null), и по текущему info смену было бы не видно.
      if (action.info && state.sessionId !== null && action.info.sessionId !== state.sessionId) {
        return { ...initial, info: action.info, sessionId: action.info.sessionId }
      }
      return { ...state, info: action.info, sessionId: action.info?.sessionId ?? state.sessionId }

    case 'error':
      return { ...state, error: action.error }

    case 'local-message':
      return { ...state, messages: [...state.messages, action.message] }

    case 'transcript':
      return applyTranscript(state, action.event)

    default:
      return state
  }
}

function applyTranscript(state: State, event: TranscriptEvent): State {
  switch (event.kind) {
    case 'chat': {
      // Транскрипт может быть перечитан с начала — защищаемся от дублей по id.
      if (state.messages.some((m) => m.id === event.message.id)) return state
      return { ...state, messages: [...state.messages, event.message] }
    }

    case 'task-start': {
      if (state.tasks.some((t) => t.id === event.task.id)) return state
      // Старые действия отбрасываем: в долгой сессии их тысячи, и каждое событие
      // перебирало бы весь список.
      return { ...state, tasks: [...state.tasks, event.task].slice(-MAX_TASKS) }
    }

    case 'task-end':
      return {
        ...state,
        tasks: state.tasks.map((t) =>
          t.id === event.id
            ? { ...t, state: event.state, error: event.error, endedAt: Date.now() }
            : t
        )
      }

    case 'todos':
      return { ...state, todos: event.items }

    case 'turn-end': {
      // Финальность известна только по завершении хода: помечаем последнее
      // ассистентское сообщение, чтобы UI мог его выделить.
      const lastAssistant = [...state.messages].reverse().find((m) => m.role === 'assistant')
      if (!lastAssistant) return state
      return {
        ...state,
        messages: state.messages.map((m) =>
          m.id === lastAssistant.id ? { ...m, final: true } : m
        )
      }
    }

    default:
      return state
  }
}

export function useSession() {
  const [state, dispatch] = useReducer(reduce, initial)

  useEffect(() => {
    const offSession = window.desk.on.sessionUpdate((info) => dispatch({ t: 'session', info }))
    const offEvent = window.desk.on.transcriptEvent((event) => dispatch({ t: 'transcript', event }))
    const offError = window.desk.on.appError((error) => dispatch({ t: 'error', error }))

    // Окно могло быть перезагружено при живой сессии — подтягиваем текущее состояние.
    void window.desk.session.info().then((info) => dispatch({ t: 'session', info }))

    return () => {
      offSession()
      offEvent()
      offError()
    }
  }, [])

  const start = useCallback(async (dir: string) => {
    dispatch({ t: 'reset' })
    dispatch({ t: 'error', error: null })
    await window.desk.session.start(dir)
  }, [])

  /**
   * Продолжить прошлую сессию. Чат не чистим заранее: если сессия не найдётся,
   * текущая продолжит работать. Очистит его смена sessionId, переписку пришлёт main.
   */
  const resume = useCallback(async (id: string) => {
    dispatch({ t: 'error', error: null })
    return window.desk.session.resume(id)
  }, [])

  const submit = useCallback(async (text: string, fromVoice = false) => {
    const trimmed = text.trim()
    if (!trimmed) return
    // Своё сообщение показываем сразу: в транскрипте пользовательский промт
    // появляется не как chat-запись, поэтому эхо делаем локально.
    dispatch({
      t: 'local-message',
      message: {
        id: `local:${Date.now()}`,
        role: 'user',
        text: trimmed,
        at: Date.now(),
        fromVoice
      }
    })
    // Что это — новая задача, «выполняй» или замечание к плану, — решает ассистент в main.
    await window.desk.session.submit(trimmed)
  }, [])

  const dismissError = useCallback(() => dispatch({ t: 'error', error: null }), [])

  /** Ошибка, замеченная в renderer (микрофон, распознавание) — в тот же баннер. */
  const showError = useCallback((message: string) => {
    dispatch({ t: 'error', error: { code: 'unknown', message } })
  }, [])

  return { ...state, start, resume, submit, dismissError, showError }
}
