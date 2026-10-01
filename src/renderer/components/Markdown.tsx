import type { ReactNode } from 'react'

/**
 * Минимальный Markdown для планов и ответов Claude: заголовки, списки, блоки
 * кода, **жирный** и `код`. Строим React-элементы, а не HTML-строку — текст от
 * модели не может внедрить разметку или скрипт.
 */

function inline(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let i = 0
  for (const m of text.matchAll(re)) {
    const idx = m.index ?? 0
    if (idx > last) out.push(text.slice(last, idx))
    const token = m[0]
    out.push(
      token.startsWith('**') ? (
        <strong key={`${keyBase}:${i++}`}>{token.slice(2, -2)}</strong>
      ) : (
        <code key={`${keyBase}:${i++}`}>{token.slice(1, -1)}</code>
      )
    )
    last = idx + token.length
  }
  if (last < text.length) out.push(text.slice(last))
  return out
}

export default function Markdown({ text }: { text: string }): React.JSX.Element {
  const lines = text.replace(/\r\n/g, '\n').split('\n')
  const blocks: ReactNode[] = []
  let list: { ordered: boolean; items: string[] } | null = null
  let para: string[] = []
  let code: string[] | null = null

  const flushPara = (): void => {
    if (para.length) {
      const k = `p${blocks.length}`
      blocks.push(<p key={k}>{inline(para.join(' '), k)}</p>)
      para = []
    }
  }
  const flushList = (): void => {
    if (list) {
      const k = `l${blocks.length}`
      const items = list.items.map((it, n) => <li key={n}>{inline(it, `${k}:${n}`)}</li>)
      blocks.push(list.ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>)
      list = null
    }
  }

  for (const line of lines) {
    if (code) {
      if (/^\s*```/.test(line)) {
        blocks.push(<pre key={`c${blocks.length}`}>{code.join('\n')}</pre>)
        code = null
      } else {
        code.push(line)
      }
      continue
    }
    if (/^\s*```/.test(line)) {
      flushPara()
      flushList()
      code = []
      continue
    }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    const bullet = /^\s*[-*•]\s+(.*)$/.exec(line)
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line)

    if (heading) {
      flushPara()
      flushList()
      const k = `h${blocks.length}`
      blocks.push(
        <div key={k} className={`md__h md__h${heading[1]!.length}`}>
          {inline(heading[2]!, k)}
        </div>
      )
    } else if (bullet || numbered) {
      flushPara()
      const ordered = !!numbered
      if (list && list.ordered !== ordered) flushList()
      if (!list) list = { ordered, items: [] }
      list.items.push((bullet ?? numbered)![1]!)
    } else if (!line.trim()) {
      flushPara()
      flushList()
    } else {
      flushList()
      para.push(line.trim())
    }
  }
  if (code) blocks.push(<pre key={`c${blocks.length}`}>{(code as string[]).join('\n')}</pre>)
  flushPara()
  flushList()

  return <div className="md">{blocks}</div>
}
