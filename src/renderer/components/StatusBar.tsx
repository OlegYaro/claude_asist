import type { AssistantPhase, SessionInfo, SessionStatus } from '../../shared/types'

interface Props {
  info: SessionInfo
  onOpenTerminal: () => void
  onStop: () => void
  onBack: () => void
  onOpenSettings: () => void
  soundOn: boolean
  onToggleSound: () => void
  onOpenProject: () => void
  historyOpen: boolean
  onToggleHistory: () => void
}

const PHASE_LABEL: Record<AssistantPhase, string> = {
  starting: 'запуск',
  ready: 'готов',
  planning: 'составляет план',
  'plan-ready': 'ждёт «выполняй»',
  executing: 'работает',
  checking: 'проверяет',
  question: 'задал вопрос',
  permission: 'ждёт согласия'
}

/** Цвет индикатора: зелёный — готов, оранжевый — работает, жёлтый — ждёт вас. */
const PHASE_CHIP: Record<AssistantPhase, SessionStatus> = {
  starting: 'working',
  ready: 'idle',
  planning: 'working',
  'plan-ready': 'needs-permission',
  executing: 'working',
  checking: 'working',
  question: 'needs-permission',
  permission: 'needs-permission'
}

const MODE_LABEL: Record<string, string> = {
  default: 'обычный режим',
  acceptEdits: 'правки без вопросов',
  plan: 'только план',
  auto: 'авто',
  bypassPermissions: 'без проверок'
}

function tail(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function StatusBar({
  info,
  onOpenTerminal,
  onStop,
  onBack,
  onOpenSettings,
  soundOn,
  onToggleSound,
  onOpenProject,
  historyOpen,
  onToggleHistory
}: Props): React.JSX.Element {
  return (
    <header className="status">
      <button className="status__back" onClick={onBack} title="К выбору проекта">
        ‹
      </button>

      <div className="status__ident">
        <span className="status__project" title={info.projectDir}>
          {tail(info.projectDir)}
        </span>
        {info.title && <span className="status__title">{info.title}</span>}
      </div>

      <div className="status__meta">
        {info.model && <span className="chip">{info.model}</span>}
        {info.permissionMode && <span className="chip">{MODE_LABEL[info.permissionMode] ?? info.permissionMode}</span>}
        <span className={`chip chip--${PHASE_CHIP[info.assistant.phase]}`}>
          <span className="chip__dot" />
          {PHASE_LABEL[info.assistant.phase]}
        </span>
      </div>

      <div className="status__actions">
        <button
          className="btn btn--ghost"
          onClick={onToggleHistory}
          aria-pressed={historyOpen}
          title={historyOpen ? 'Скрыть историю сессий' : 'Прошлые сессии проекта и ваши запросы'}
        >
          История
        </button>
        <button
          className="btn btn--ghost"
          onClick={onOpenProject}
          title="План, изменения, проверки, стек и описание проекта"
        >
          Проект
        </button>
        <button
          className="btn btn--ghost"
          onClick={onOpenTerminal}
          title={
            info.terminalAttached
              ? 'Открыть ещё одно окно терминала'
              : 'Окно терминала закрыто — открыть заново'
          }
        >
          {info.terminalAttached ? 'Терминал' : 'Открыть терминал'}
        </button>
        <button
          className="btn btn--ghost"
          onClick={onToggleSound}
          aria-pressed={!soundOn}
          title={soundOn ? 'Беззвучный режим: не озвучивать сообщения' : 'Включить озвучку сообщений'}
        >
          {soundOn ? '🔊' : '🔇'}
        </button>
        <button className="btn btn--ghost" onClick={onOpenSettings} title="Настройки">
          ⚙
        </button>
        <button className="btn btn--ghost" onClick={onStop}>
          Завершить
        </button>
      </div>
    </header>
  )
}
