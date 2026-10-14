import { useMemo, useState } from 'react'
import type { TokenUsage } from '../../shared/types'
import { aggregateTokens } from '../../shared/token-stats'
import { categoryLabel } from '../actionKinds'

interface Props {
  usage: Record<string, { tools: string[]; usage: TokenUsage }>
}

const STORAGE_KEY = 'cvd.tokenChart.open'

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

/** 12400 → «12,4 тыс.», 1 500 000 → «1,5 млн». */
export function formatTokens(n: number): string {
  const fmt = (v: number): string => v.toFixed(1).replace(/\.0$/, '').replace('.', ',')
  if (n >= 1_000_000) return `${fmt(n / 1_000_000)} млн`
  if (n >= 1000) return `${fmt(n / 1000)} тыс.`
  return String(n)
}

const exact = (n: number): string => n.toLocaleString('ru-RU')

export default function TokenChart({ usage }: Props): React.JSX.Element {
  const [open, setOpen] = useState(readOpen)
  const shares = useMemo(() => aggregateTokens(Object.values(usage)), [usage])
  const total = useMemo(() => shares.reduce((sum, s) => sum + s.total, 0), [shares])
  const max = shares[0]?.total ?? 0

  const toggle = (): void => {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(STORAGE_KEY, next ? '1' : '0')
    } catch {
      /* без хранилища просто не запоминаем */
    }
  }

  return (
    <section className="tokens">
      <button type="button" className="tokens__head" aria-expanded={open} onClick={toggle}>
        <span className="tokens__caret">▶</span>
        <span>Токены · всего {formatTokens(total)}</span>
      </button>
      {open &&
        (shares.length === 0 ? (
          <p className="tasks__empty">Пока нет данных о токенах.</p>
        ) : (
          <>
            <ul className="tokens__list">
              {shares.map((s) => {
                const u = s.usage
                const newInput = u.input + u.cacheWrite
                const pct = total > 0 ? (s.total / total) * 100 : 0
                const title =
                  `${categoryLabel(s.category)}: ${exact(s.total)} (${pct.toFixed(1).replace('.', ',')} %)\n` +
                  `Вывод: ${exact(u.output)}\nНовый ввод: ${exact(newInput)}\nЧтение кэша: ${exact(u.cacheRead)}`
                const kind = s.category === 'answer' ? 'task' : s.category
                const seg = (v: number, cls: string): React.JSX.Element | null =>
                  v > 0 ? <span className={`tokens__seg ${cls}`} style={{ flexGrow: v }} /> : null
                return (
                  <li key={s.category} className={`tokens__row act--${kind}`} title={title}>
                    <span className="tokens__label">{categoryLabel(s.category)}</span>
                    <span className="tokens__track">
                      <span className="tokens__bar" style={{ width: `${(s.total / max) * 100}%` }}>
                        {seg(u.output, 'tokens__seg--out')}
                        {seg(newInput, 'tokens__seg--in')}
                        {seg(u.cacheRead, 'tokens__seg--cache')}
                      </span>
                    </span>
                    <span className="tokens__sum">{formatTokens(s.total)}</span>
                  </li>
                )
              })}
            </ul>
            <div className="tokens__legend">
              <span><i className="tokens__swatch tokens__seg--out" />вывод</span>
              <span><i className="tokens__swatch tokens__seg--in" />новый ввод</span>
              <span><i className="tokens__swatch tokens__seg--cache" />кэш</span>
            </div>
          </>
        ))}
    </section>
  )
}
