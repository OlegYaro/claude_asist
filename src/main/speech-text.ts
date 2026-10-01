/**
 * Ответ Claude — markdown; `say` прочитал бы звёздочки, решётки и код вслух.
 * Здесь он превращается в фразы для озвучки: разметка снимается, код заменяется
 * пометкой, текст режется на куски. Резать нужно: `Speaker` убивает фразу дольше
 * `PHRASE_LIMIT_MS`, и длинный ответ оборвался бы на середине.
 */

/** Примерно 20 секунд речи — с запасом до `PHRASE_LIMIT_MS`. */
export const PHRASE_MAX_CHARS = 300

const CODE_MARK = 'Фрагмент кода.'

/** Строка markdown → строка для чтения; пустая строка — нечего читать. */
function plainLine(raw: string): string {
  let line = raw.trim()
  // Разделитель таблицы и горизонтальная черта.
  if (/^\|?[\s:|-]+\|[\s:|-]*$/.test(line) && line.includes('-')) return ''
  if (/^([-*_]\s*){3,}$/.test(line)) return ''
  line = line
    .replace(/^#{1,6}\s+/, '')
    .replace(/^>\s?/, '')
    .replace(/^([-*+]|\d+[.)])\s+(\[[ xX]\]\s+)?/, '')
  // Строка таблицы: ячейки через запятую.
  if (line.startsWith('|')) {
    line = line
      .replace(/^\||\|$/g, '')
      .split('|')
      .map((cell) => cell.trim())
      .filter(Boolean)
      .join(', ')
  }
  return line
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/https?:\/\/\S+/g, 'ссылка')
    .replace(/`([^`]*)`/g, '$1')
    .replace(/\*+|~~/g, '')
    .replace(/(^|\s)__?(\S[^_]*?)__?(?=\s|[.,!?:;]|$)/g, '$1$2')
    // Символы, которые say читает названием («обратная косая черта», «кавычка»…).
    // Стрелка в пути по меню — пауза; слэши в путях — пробел; апостроф внутри слова (don't) остаётся.
    .replace(/\s*[→⇒]\s*/g, ', ')
    .replace(/[\\/|]+/g, ' ')
    .replace(/["«»„“”{}[\]<>#^~]/g, '')
    .replace(/(?<!\p{L})['‘’]|['‘’](?!\p{L})/gu, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Без знака в конце строки заголовок и пункты списка слились бы в одну фразу. */
function withStop(line: string): string {
  return /[.!?…:;,]$/.test(line) ? line : `${line}.`
}

/** Режет слишком длинное предложение по словам. */
function splitLong(sentence: string, max: number): string[] {
  const parts: string[] = []
  let current = ''
  for (const word of sentence.split(' ')) {
    if (current && current.length + 1 + word.length > max) {
      parts.push(current)
      current = word
    } else {
      current = current ? `${current} ${word}` : word
    }
  }
  if (current) parts.push(current)
  return parts
}

/** Markdown-ответ → фразы для `Speaker.say`, каждая не длиннее `max` символов. */
export function speechPhrases(markdown: string, max = PHRASE_MAX_CHARS): string[] {
  const lines: string[] = []
  let inCode = false
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      if (!inCode) lines.push(CODE_MARK)
      inCode = !inCode
      continue
    }
    if (inCode) continue
    const line = plainLine(raw)
    if (line) lines.push(withStop(line))
  }

  // Подряд идущие блоки кода — одной пометкой.
  const text = lines.filter((line, i) => line !== CODE_MARK || lines[i - 1] !== CODE_MARK).join(' ')
  const sentences = text
    .split(/(?<=[.!?…])\s+/)
    .flatMap((s) => (s.length > max ? splitLong(s, max) : [s]))
    .filter(Boolean)

  const phrases: string[] = []
  let current = ''
  for (const sentence of sentences) {
    if (current && current.length + 1 + sentence.length > max) {
      phrases.push(current)
      current = sentence
    } else {
      current = current ? `${current} ${sentence}` : sentence
    }
  }
  if (current) phrases.push(current)
  return phrases
}
