import { useEffect, useState } from 'react'
import type { Settings as SettingsData } from '../../shared/types'
import {
  PERMISSION_RULES,
  PERM_MODES,
  permissionMode,
  type PermMode,
  type PermRule,
  type PermRuleId
} from '../../shared/permissions'

interface Props {
  onClose: () => void
}

const MODE_LABELS: Record<PermMode, string> = {
  allow: 'Сам',
  ask: 'Спросить',
  deny: 'Запретить'
}

const SECTIONS: { group: PermRule['group']; title: string }[] = [
  { group: 'safe', title: 'Безопасные действия' },
  { group: 'danger', title: 'Опасные действия' }
]

export default function PermissionsSettings({ onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsData | null>(null)

  useEffect(() => {
    void window.desk.settings.get().then(setSettings)
  }, [])

  const save = async (permissions: SettingsData['permissions']): Promise<void> => {
    setSettings(await window.desk.settings.set({ permissions }))
  }

  // Храним только отличия от значения по умолчанию.
  const choose = (rule: PermRule, mode: PermMode): void => {
    if (!settings) return
    const next: Partial<Record<PermRuleId, PermMode>> = { ...settings.permissions }
    if (mode === rule.default) delete next[rule.id]
    else next[rule.id] = mode
    void save(next)
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Разрешения">
      <div className="modal__card modal__card--wide">
        <header className="modal__head">
          <h2 className="modal__title">Разрешения</h2>
          <button className="modal__close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {!settings ? (
          <p className="modal__status">Загрузка…</p>
        ) : (
          <div className="settings">
            <p className="settings__hint">
              «Сам» — приложение разрешает действие само. «Спросить» — озвучит и подождёт вашего
              «да». «Запретить» — Claude получит отказ. «Спросить» для безопасных действий
              остановит работу на каждом таком действии. Изменения применяются сразу, а для
              интернета и MCP — со следующей сессии.
            </p>

            {SECTIONS.map(({ group, title }) => (
              <section
                key={group}
                className={`settings__group${group === 'danger' ? ' settings__group--danger' : ''}`}
              >
                <h3 className="settings__title">{title}</h3>
                {PERMISSION_RULES.filter((rule) => rule.group === group).map((rule) => {
                  const current = permissionMode(settings.permissions, rule)
                  return (
                    <div key={rule.id} className="perm">
                      <div className="perm__text">
                        <span className="perm__label">{rule.label}</span>
                        <span className="settings__hint">{rule.hint}</span>
                      </div>
                      <div className="seg" role="radiogroup" aria-label={rule.label}>
                        {PERM_MODES.map((mode) => (
                          <label
                            key={mode}
                            className={`seg__item seg__item--${mode}${current === mode ? ' seg__item--on' : ''}`}
                          >
                            <input
                              className="seg__input"
                              type="radio"
                              name={`perm-${rule.id}`}
                              value={mode}
                              checked={current === mode}
                              onChange={() => choose(rule, mode)}
                            />
                            {MODE_LABELS[mode]}
                          </label>
                        ))}
                      </div>
                    </div>
                  )
                })}
              </section>
            ))}
          </div>
        )}

        <footer className="modal__actions">
          <button
            className="btn btn--ghost"
            disabled={!settings}
            onClick={() => void save({})}
          >
            Сбросить по умолчанию
          </button>
          <span className="modal__spacer" />
          <button className="btn btn--primary" onClick={onClose}>
            Закрыть
          </button>
        </footer>
      </div>
    </div>
  )
}
