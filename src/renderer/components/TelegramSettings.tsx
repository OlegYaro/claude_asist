import { useEffect, useState } from 'react'
import type { TelegramStatus } from '../../shared/types'

/** Ошибку из main Electron оборачивает в «Error invoking remote method …» — показываем суть. */
function errorText(err: unknown, fallback: string): string {
  const message = err instanceof Error ? err.message : ''
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || fallback
}

const STATE_LABEL: Record<TelegramStatus['state'], string> = {
  off: 'выключен',
  connecting: 'подключается…',
  running: 'на связи',
  error: 'ошибка'
}

/** Раздел настроек «Управление с телефона». */
export default function TelegramSettings(): React.JSX.Element {
  const [status, setStatus] = useState<TelegramStatus | null>(null)
  const [tokenDraft, setTokenDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    void window.desk.telegram.status().then(setStatus)
  }, [])

  // Пока ждём подключения или привязки с телефона, статус меняется в main —
  // перечитываем его, чтобы раздел обновился сам.
  const waiting = status !== null && (status.state === 'connecting' || status.pairCode !== null)
  useEffect(() => {
    if (!waiting) return
    const timer = setInterval(() => void window.desk.telegram.status().then(setStatus), 2000)
    return () => clearInterval(timer)
  }, [waiting])

  const run = async (action: () => Promise<TelegramStatus>, done?: string): Promise<void> => {
    setBusy(true)
    setNote(null)
    try {
      setStatus(await action())
      if (done) setNote(done)
    } catch (err) {
      setNote(errorText(err, 'Не получилось'))
    } finally {
      setBusy(false)
    }
  }

  const saveToken = (): Promise<void> =>
    run(async () => {
      const next = await window.desk.telegram.setToken(tokenDraft)
      setTokenDraft('')
      return next
    }, 'Токен сохранён')

  if (!status) return <p className="settings__hint">Загрузка…</p>

  const link = status.botName && status.pairCode ? `https://t.me/${status.botName}?start=${status.pairCode}` : null

  return (
    <section className="settings__group">
      <h3 className="settings__title">Управление с телефона (Telegram)</h3>
      <p className="settings__hint">
        Пишите задачи боту, отвечайте «выполняй», выбирайте варианты и получайте ответы Claude.
        Создайте бота у @BotFather и вставьте его токен. Бот запускается сам вместе с приложением.
      </p>

      {status.hasToken ? (
        <div className="settings__row">
          <span className="settings__label">Бот</span>
          <span className="settings__control settings__value">
            {status.botName ? `@${status.botName}` : 'токен сохранён'} · {STATE_LABEL[status.state]}
          </span>
          <button
            className="btn btn--ghost btn--small"
            disabled={busy}
            onClick={() => void run(() => window.desk.telegram.clearToken(), 'Токен удалён')}
          >
            Удалить
          </button>
        </div>
      ) : (
        <div className="settings__row">
          <span className="settings__label">Токен бота</span>
          <input
            className="settings__control"
            type="password"
            value={tokenDraft}
            placeholder="123456789:AA…"
            onChange={(e) => setTokenDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && tokenDraft.trim()) void saveToken()
            }}
          />
          <button className="btn btn--small" disabled={busy || !tokenDraft.trim()} onClick={() => void saveToken()}>
            Сохранить
          </button>
        </div>
      )}

      {!status.canStore && (
        <p className="settings__hint warn">
          Системное хранилище секретов недоступно — токен сохранить не получится.
        </p>
      )}
      {status.error && <p className="settings__hint warn">{status.error}</p>}

      {status.hasToken && (
        <>
          <label className="settings__row settings__row--check">
            <input
              type="checkbox"
              checked={status.enabled}
              disabled={busy}
              onChange={(e) => {
                const enabled = e.target.checked
                void run(() => window.desk.telegram.setEnabled(enabled))
              }}
            />
            <span>Принимать команды с телефона</span>
          </label>

          {status.chatBound ? (
            <div className="settings__row">
              <span className="settings__label">Чат</span>
              <span className="settings__control settings__value">привязан</span>
              <button
                className="btn btn--ghost btn--small"
                disabled={busy}
                onClick={() => void run(() => window.desk.telegram.unbind(), 'Чат отвязан')}
              >
                Отвязать
              </button>
            </div>
          ) : status.pairCode ? (
            <p className="settings__hint">
              Отправьте боту <b>/start {status.pairCode}</b>
              {link && (
                <>
                  {' '}
                  или откройте{' '}
                  <a href={link} target="_blank" rel="noreferrer">
                    {link}
                  </a>
                </>
              )}
              .
              {status.pairExpiresAt !== null &&
                ` Код действует до ${new Date(status.pairExpiresAt).toLocaleString('ru-RU', {
                  day: 'numeric',
                  month: 'long',
                  hour: '2-digit',
                  minute: '2-digit'
                })}.`}
            </p>
          ) : (
            <div className="settings__row">
              <span className="settings__label">Чат</span>
              <span className="settings__control settings__value">не привязан</span>
              <button
                className="btn btn--small"
                disabled={busy}
                onClick={() => void run(() => window.desk.telegram.pair())}
              >
                Получить код
              </button>
            </div>
          )}
          <p className="settings__hint">
            Команды принимаются только из привязанного чата. Бот работает, пока приложение открыто
            и Mac не спит.
          </p>
        </>
      )}

      {note && <p className="settings__hint">{note}</p>}
    </section>
  )
}
