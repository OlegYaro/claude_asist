import { useEffect, useState } from 'react'
import type { Settings as SettingsData, SttStatus } from '../../shared/types'
import TelegramSettings from './TelegramSettings'

interface Props {
  onClose: () => void
}

interface KeyStatus {
  hasKey: boolean
  source: 'stored' | 'env' | 'none'
  canStore: boolean
}

const MODELS = [
  { id: 'claude-haiku-4-5', label: 'Haiku 4.5 — быстро и дёшево' },
  { id: 'claude-sonnet-5-5', label: 'Sonnet 5.5 — точнее на сложных формулировках' }
]

const RATES = [
  { value: '', label: 'Обычная' },
  { value: '160', label: 'Медленнее' },
  { value: '220', label: 'Быстрее' },
  { value: '260', label: 'Очень быстро' }
]

/** Улучшенный или премиум-голос — заметно живее компактного. */
const isGoodVoice = (name: string): boolean => /premium|enhanced|премиум|улучш/i.test(name)

const LOCALES = [
  { id: 'ru-RU', label: 'Русский' },
  { id: 'en-US', label: 'English' },
  { id: 'uk-UA', label: 'Українська' },
  { id: 'de-DE', label: 'Deutsch' }
]

export default function Settings({ onClose }: Props): React.JSX.Element {
  const [settings, setSettings] = useState<SettingsData | null>(null)
  const [keyStatus, setKeyStatus] = useState<KeyStatus | null>(null)
  const [keyDraft, setKeyDraft] = useState('')
  const [stt, setStt] = useState<SttStatus | null>(null)
  const [saveNote, setSaveNote] = useState<string | null>(null)
  const [voices, setVoices] = useState<string[] | null>(null)

  useEffect(() => {
    void window.desk.settings.get().then(setSettings)
    void window.desk.secrets.status().then(setKeyStatus)
    // Перечитываем при каждом открытии: так подхватится только что скачанный голос.
    void window.desk.speech.voices().then(setVoices)
  }, [])

  // Статус распознавания зависит от выбранной локали — перепроверяем при смене.
  // Зависимость только от локали: иначе любая правка настроек (каждая буква
  // в поле пути к claude) заново запускала бы проверку распознавания.
  const sttLocale = settings?.sttLocale
  useEffect(() => {
    if (!sttLocale) return
    setStt(null)
    void window.desk.stt.probe(sttLocale).then(setStt)
  }, [sttLocale])

  const patch = async (part: Partial<SettingsData>): Promise<void> => {
    setSettings(await window.desk.settings.set(part))
  }

  const saveKey = async (): Promise<void> => {
    try {
      await window.desk.secrets.setKey(keyDraft)
      setKeyDraft('')
      setKeyStatus(await window.desk.secrets.status())
      setSaveNote('Ключ сохранён')
    } catch (err) {
      setSaveNote(err instanceof Error ? err.message : 'Не удалось сохранить ключ')
    }
  }

  const clearKey = async (): Promise<void> => {
    await window.desk.secrets.clearKey()
    setKeyStatus(await window.desk.secrets.status())
    setSaveNote('Ключ удалён')
  }

  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Настройки">
      <div className="modal__card modal__card--wide">
        <header className="modal__head">
          <h2 className="modal__title">Настройки</h2>
          <button className="modal__close" onClick={onClose} aria-label="Закрыть">
            ×
          </button>
        </header>

        {!settings || !keyStatus ? (
          <p className="modal__status">Загрузка…</p>
        ) : (
          <div className="settings">
            <section className="settings__group">
              <h3 className="settings__title">Распознавание речи</h3>
              <label className="settings__row">
                <span className="settings__label">Язык</span>
                <select
                  className="settings__control"
                  value={settings.sttLocale}
                  onChange={(e) => void patch({ sttLocale: e.target.value })}
                >
                  {LOCALES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.label}
                    </option>
                  ))}
                </select>
              </label>
              <p className="settings__hint">
                {stt === null
                  ? 'Проверяем…'
                  : stt.available
                    ? `Работает локально: ${stt.detail}${stt.installed ? '' : ' · модель догрузится при первом использовании'}`
                    : `Недоступно: ${stt.detail}`}
              </p>
            </section>

            <section className="settings__group">
              <h3 className="settings__title">Голосовое управление</h3>
              <label className="settings__row">
                <span className="settings__label">Режим</span>
                <select
                  className="settings__control"
                  value={settings.listenMode}
                  onChange={(e) =>
                    void patch({ listenMode: e.target.value as SettingsData['listenMode'] })
                  }
                >
                  <option value="always">Слушать постоянно</option>
                  <option value="push">По удержанию кнопки или пробела</option>
                </select>
              </label>
              <label className="settings__row">
                <span className="settings__label">Пауза перед отправкой</span>
                <select
                  className="settings__control"
                  value={String(settings.sendDelaySec)}
                  onChange={(e) => void patch({ sendDelaySec: Number(e.target.value) })}
                >
                  <option value="2">2 секунды</option>
                  <option value="3">3 секунды</option>
                  <option value="5">5 секунд</option>
                  <option value="8">8 секунд</option>
                </select>
              </label>
              <p className="settings__hint">
                После того как вы замолчали, приложение ждёт столько времени — можно договорить, и
                текст допишется. «Стоп» и «выполняй» над готовым планом срабатывают сразу.
              </p>
              <label className="settings__row settings__row--check">
                <input
                  type="checkbox"
                  checked={settings.speak}
                  onChange={(e) => void patch({ speak: e.target.checked })}
                />
                <span>Озвучивать «План готов», «Готово» и вопросы</span>
              </label>
              <label
                className={`settings__row settings__row--check${settings.speak ? '' : ' settings__row--off'}`}
              >
                <input
                  type="checkbox"
                  checked={settings.speakReplies}
                  disabled={!settings.speak}
                  onChange={(e) => void patch({ speakReplies: e.target.checked })}
                />
                <span>Читать вслух ответы Claude</span>
              </label>
              <label
                className={`settings__row settings__row--check${settings.speak ? '' : ' settings__row--off'}`}
              >
                <input
                  type="checkbox"
                  checked={settings.bargeIn}
                  disabled={!settings.speak}
                  onChange={(e) => void patch({ bargeIn: e.target.checked })}
                />
                <span>Перебивать голосом</span>
              </label>
              <p className="settings__hint">
                {!settings.speak
                  ? 'Включён беззвучный режим — сейчас приложение ничего не озвучивает.'
                  : settings.bargeIn
                    ? 'Итоговый ответ в конце хода, без кода. Чтобы приложение замолчало, просто начните говорить, нажмите кнопку микрофона или Esc. Если на колонках речь обрывается сама, выключите «Перебивать голосом» или наденьте наушники.'
                    : 'Итоговый ответ в конце хода, без кода. Пока приложение говорит, микрофон не слушает — оборвать речь можно кнопкой микрофона или Esc.'}
              </p>
              <label className={`settings__row${settings.speak ? '' : ' settings__row--off'}`}>
                <span className="settings__label">Голос</span>
                <select
                  className="settings__control"
                  value={settings.speechVoice ?? ''}
                  disabled={!settings.speak || voices === null}
                  onChange={(e) => void patch({ speechVoice: e.target.value || null })}
                >
                  <option value="">
                    {voices?.[0] ? `Лучший установленный — ${voices[0]}` : 'Системный'}
                  </option>
                  {voices?.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>
              <label className={`settings__row${settings.speak ? '' : ' settings__row--off'}`}>
                <span className="settings__label">Скорость</span>
                <select
                  className="settings__control"
                  value={settings.speechRate === null ? '' : String(settings.speechRate)}
                  disabled={!settings.speak}
                  onChange={(e) =>
                    void patch({ speechRate: e.target.value ? Number(e.target.value) : null })
                  }
                >
                  {RATES.map((r) => (
                    <option key={r.value} value={r.value}>
                      {r.label}
                    </option>
                  ))}
                </select>
              </label>
              <div className="settings__row">
                <button
                  className="btn btn--small"
                  disabled={!settings.speak}
                  onClick={() => void window.desk.speech.preview()}
                >
                  Прослушать
                </button>
              </div>
              {voices !== null && !voices.some(isGoodVoice) && (
                <p className="settings__hint">
                  Сейчас установлен только простой голос — он звучит как робот. Скачайте живее:
                  Системные настройки → Универсальный доступ → Устное содержимое → Системный голос →
                  Управление голосами → Русский → «Милена (улучшенный)» или «(премиум)». Затем
                  откройте настройки заново — голос выберется сам.
                </p>
              )}
            </section>

            <section className="settings__group">
              <h3 className="settings__title">Ассистент</h3>
              <label className="settings__row">
                <span className="settings__label">План</span>
                <select
                  className="settings__control"
                  value={settings.planMode}
                  onChange={(e) => void patch({ planMode: e.target.value as SettingsData['planMode'] })}
                >
                  <option value="auto">Claude решает сам</option>
                  <option value="always">Всегда сначала план</option>
                  <option value="never">Без плана</option>
                </select>
              </label>
              <p className="settings__hint">
                «Сам решает»: на вопрос — ответ, мелкая правка — сразу, сложная задача — план и
                ваше «выполняй». Можно сказать явно: «с планом, …» или «просто сделай …».
              </p>
              <label className="settings__row settings__row--check">
                <input
                  type="checkbox"
                  checked={settings.qualityGate}
                  onChange={(e) => void patch({ qualityGate: e.target.checked })}
                />
                <span>Проверять результат: типы, линтер, тесты проекта</span>
              </label>
              <label className="settings__row settings__row--check">
                <input
                  type="checkbox"
                  checked={settings.autoReview}
                  onChange={(e) => void patch({ autoReview: e.target.checked })}
                />
                <span>Независимое ревью перед завершением задачи</span>
              </label>
              <p className="settings__hint">
                Пока проверки красные, Claude не может закончить — получает ошибки и исправляет
                причину (до трёх попыток). Ревью — отдельный запуск Claude в чистом контексте, только чтение.
              </p>
              <label className="settings__row settings__row--check">
                <input
                  type="checkbox"
                  checked={settings.autoApprove}
                  onChange={(e) => void patch({ autoApprove: e.target.checked })}
                />
                <span>Давать согласие на действия автоматически</span>
              </label>
              <p className="settings__hint">
                Каждое согласие видно в «Действиях». Рискованные команды (rm -rf, sudo, git push
                --force и подобные) всё равно ждут вашего «да».
              </p>
            </section>

            <section className="settings__group">
              <h3 className="settings__title">Обработка промта</h3>
              <p className="settings__hint">
                Необязательна. Превращает надиктованную реплику в чёткую задачу и
                исправляет ошибки распознавания. Без ключа расшифровка отправляется как есть.
              </p>

              {keyStatus.hasKey ? (
                <div className="settings__row">
                  <span className="settings__label">API-ключ</span>
                  <span className="settings__control settings__value">
                    {keyStatus.source === 'env'
                      ? 'взят из переменной ANTHROPIC_API_KEY'
                      : 'сохранён в связке ключей'}
                  </span>
                  {keyStatus.source === 'stored' && (
                    <button className="btn btn--ghost btn--small" onClick={() => void clearKey()}>
                      Удалить
                    </button>
                  )}
                </div>
              ) : (
                <div className="settings__row">
                  <span className="settings__label">API-ключ</span>
                  <input
                    className="settings__control"
                    type="password"
                    value={keyDraft}
                    placeholder="sk-ant-…"
                    onChange={(e) => setKeyDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') void saveKey()
                    }}
                  />
                  <button
                    className="btn btn--small"
                    onClick={() => void saveKey()}
                    disabled={!keyDraft.trim()}
                  >
                    Сохранить
                  </button>
                </div>
              )}

              {!keyStatus.canStore && (
                <p className="settings__hint warn">
                  Системное хранилище секретов недоступно — ключ сохранить не получится.
                </p>
              )}

              <label className="settings__row">
                <span className="settings__label">Модель</span>
                <select
                  className="settings__control"
                  value={settings.promptModel}
                  onChange={(e) => void patch({ promptModel: e.target.value })}
                >
                  {MODELS.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label}
                    </option>
                  ))}
                </select>
              </label>
            </section>

            <TelegramSettings />

            <section className="settings__group">
              <h3 className="settings__title">Сессия Claude Code</h3>
              <label className="settings__row">
                <span className="settings__label">Режим разрешений</span>
                <select
                  className="settings__control"
                  value={settings.permissionMode ?? ''}
                  onChange={(e) => void patch({ permissionMode: e.target.value || null })}
                >
                  <option value="">Обычный — согласия даёт приложение</option>
                  <option value="acceptEdits">Принимать правки файлов</option>
                  <option value="plan">Только планировать</option>
                </select>
              </label>
              <label className="settings__row settings__row--check">
                <input
                  type="checkbox"
                  checked={settings.autoOpenTerminal}
                  onChange={(e) => void patch({ autoOpenTerminal: e.target.checked })}
                />
                <span>Открывать окно терминала при старте сессии</span>
              </label>
              <label className="settings__row">
                <span className="settings__label">Путь к claude</span>
                <input
                  className="settings__control"
                  type="text"
                  value={settings.claudeBinPath ?? ''}
                  placeholder="определяется автоматически"
                  onChange={(e) => void patch({ claudeBinPath: e.target.value || null })}
                />
              </label>
            </section>

            {saveNote && <p className="modal__status">{saveNote}</p>}
          </div>
        )}

        <footer className="modal__actions">
          <span className="modal__spacer" />
          <button className="btn btn--primary" onClick={onClose}>
            Готово
          </button>
        </footer>
      </div>
    </div>
  )
}
