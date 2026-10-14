import { useMemo, useState } from 'react'
import type { LimitsSnapshot, TokenUsage } from '../../shared/types'
import { aggregateTokens, totalTokens } from '../../shared/token-stats'
import { weightUsage } from '../../shared/limit-estimate'
import { categoryLabel } from '../actionKinds'

interface Props {
  usage: Record<string, { tools: string[]; usage: TokenUsage; model?: string | null }>
  limits: LimitsSnapshot | null
}

const STORAGE_KEY = 'cvd.tokenChart.open'

function readOpen(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== '0'
  } catch {
    return true
  }
}

const exact = (n: number): string => n.toLocaleString('ru-RU')

const pctText = (v: number): string => (v < 10 ? v.toFixed(1) : String(Math.round(v))).replace('.', ',')
const usd = (micro: number): string => `$${(micro / 1_000_000).toFixed(2)}`.replace('.', ',')

/** «Эта сессия ≈ 7 % лимита · всего 42 % · сброс в 18:30» — или то, что известно. */
function headline(limits: LimitsSnapshot | null, totalMicro: number): string {
  if (limits?.sessionPct != null) {
    const parts = [`Эта сессия ≈ ${pctText(limits.sessionPct)} % лимита`]
    if (limits.totalPct != null) parts.push(`всего ${Math.round(limits.totalPct)} %`)
    if (limits.resetsAt != null) {
      parts.push(`сброс в ${new Date(limits.resetsAt * 1000).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`)
    }
    return parts.join(' · ')
  }
  if (limits?.totalPct != null) return `Лимит ${Math.round(limits.totalPct)} % · оценка сессии появится чуть позже`
  return `Расход сессии ≈ ${usd(totalMicro)} по ценам API`
}

export default function TokenChart({ usage, limits }: Props): React.JSX.Element {
  const [open, setOpen] = useState(readOpen)
  // Токены взвешены по ценам API (кэш дёшев, выход и сильные модели дороги): полоски
  // показывают вклад в лимит, а не сырой счётчик, где почти всё — чтение кэша.
  const shares = useMemo(
    () => aggregateTokens(Object.values(usage).map((e) => ({ tools: e.tools, usage: weightUsage(e.usage, e.model) }))),
    [usage]
  )
  const total = useMemo(() => shares.reduce((sum, s) => sum + s.total, 0), [shares])
  const rawTokens = useMemo(
    () => Object.values(usage).reduce((sum, e) => sum + totalTokens(e.usage), 0),
    [usage]
  )
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
        <span title={`Сырой счётчик: ${exact(rawTokens)} токенов, включая чтение кэша. Оценка — по ценам API и общему проценту лимита.`}>
          {headline(limits, total)}
        </span>
      </button>
      {open &&
        (shares.length === 0 ? (
          <p className="tasks__empty">Пока нет данных о расходе.</p>
        ) : (
          <>
            <ul className="tokens__list">
              {shares.map((s) => {
                const u = s.usage
                const newInput = u.input + u.cacheWrite
                const pct = total > 0 ? (s.total / total) * 100 : 0
                const title =
                  `${categoryLabel(s.category)}: ${usd(s.total)} (${pct.toFixed(1).replace('.', ',')} % расхода)\n` +
                  `Вывод: ${usd(u.output)}\nНовый ввод: ${usd(newInput)}\nЧтение кэша: ${usd(u.cacheRead)}`
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
                    <span className="tokens__sum">{pct.toFixed(0)} %</span>
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
