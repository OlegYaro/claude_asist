import { useEffect, useState } from 'react'
import type { Settings } from '../../shared/types'

interface Props {
  onOpen: (dir: string) => void
  onOpenSettings: () => void
}

function tail(path: string): string {
  const parts = path.split('/').filter(Boolean)
  return parts[parts.length - 1] ?? path
}

export default function ProjectPicker({ onOpen, onOpenSettings }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [probe, setProbe] = useState<{ bin: string | null; version: string | null } | null>(null)

  useEffect(() => {
    void window.desk.settings.get().then(setSettings)
    void window.desk.claude.probe().then(setProbe)
  }, [])

  const pick = async (): Promise<void> => {
    const dir = await window.desk.project.pick()
    if (dir) onOpen(dir)
  }

  const forget = async (dir: string): Promise<void> => {
    setSettings(await window.desk.settings.forgetProject(dir))
  }

  return (
    <div className="picker">
      <div className="picker__card">
        <h1 className="picker__title">Claude Voice Desk</h1>
        <p className="picker__subtitle">
          Выберите папку проекта — в ней запустится Claude Code, а управлять им можно голосом.
        </p>

        <button className="btn btn--primary btn--wide" onClick={() => void pick()}>
          Выбрать папку…
        </button>

        {settings && settings.recentProjects.length > 0 && (
          <>
            <h2 className="picker__section">Недавние</h2>
            <ul className="recents">
              {settings.recentProjects.map((dir) => (
                <li key={dir} className="recents__item">
                  <button className="recents__open" onClick={() => onOpen(dir)} title={dir}>
                    <span className="recents__name">{tail(dir)}</span>
                    <span className="recents__path">{dir}</span>
                  </button>
                  <button
                    className="recents__forget"
                    onClick={() => void forget(dir)}
                    title="Убрать из списка"
                    aria-label={`Убрать ${tail(dir)} из списка`}
                  >
                    ×
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}

        <div className="picker__probe">
          {probe === null ? (
            <span className="muted">Проверяем Claude Code…</span>
          ) : probe.bin ? (
            <span className="muted">
              Claude Code {probe.version ?? ''} — <code>{probe.bin}</code>
            </span>
          ) : (
            <span className="warn">
              Не найден исполняемый файл <code>claude</code>. Укажите путь в настройках.
            </span>
          )}
          <button className="btn btn--ghost btn--small" onClick={onOpenSettings}>
            Настройки
          </button>
        </div>
      </div>
    </div>
  )
}
