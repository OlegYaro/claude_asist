/**
 * Короткие голосовые команды: «выполняй», «стоп», «второй вариант».
 *
 * Общие для main (решает, что делать с фразой) и renderer (решает, можно ли
 * отправить фразу сразу, не дожидаясь паузы).
 */

function words(text: string): string[] {
  return [...text.toLowerCase().replace(/ё/g, 'е').matchAll(/[\p{L}\p{N}]+/gu)].map((m) => m[0])
}

// \p{L}, а не \w: в JS \w совпадает только с латиницей.
const APPROVE = /^(выполня\p{L}*|выполни|делай|давай|поехали|запускай|вперед|одобряю|согласен|подтверждаю|да|ок|окей|разрешаю|можно)$/u
const STOP = /^(стоп|хватит|прекрати|остановись|останови|прерви|стой)$/u
const CANCEL = /^(отмен\p{L}*|нет|отставить|запрещаю|нельзя)$/u
const FILLER = /^(ну|так|хорошо|ладно|пожалуйста|все|всё|тогда|можешь|план|его|это)$/u

/** Фраза целиком — согласие («выполняй», «да, давай»). Длинные фразы — уже не согласие, а замечание. */
export function isApprove(text: string): boolean {
  const w = words(text).filter((x) => !FILLER.test(x))
  return w.length > 0 && w.length <= 3 && w.some((x) => APPROVE.test(x)) && !w.some((x) => CANCEL.test(x))
}

export function isStop(text: string): boolean {
  const w = words(text).filter((x) => !FILLER.test(x))
  return w.length > 0 && w.length <= 2 && STOP.test(w[0]!)
}

export function isCancel(text: string): boolean {
  const w = words(text).filter((x) => !FILLER.test(x))
  return w.length > 0 && w.length <= 3 && CANCEL.test(w[0]!)
}

/**
 * Явное указание, нужен ли план: «с планом …», «сначала план, …», «просто сделай …»,
 * «без плана …». Возвращает режим и текст без этих слов.
 */
export function parsePlanOverride(text: string): { mode: 'plan' | 'direct' | null; rest: string } {
  const plan = /^\s*(давай\s+)?(сначала\s+(составь\s+)?план|с\s+планом|составь\s+план|спланируй)[\s,.:;—-]*/iu
  // «Просто»/«сразу» — только перед глаголом действия, и глагол остаётся в тексте:
  // «просто скажи, что это» — вопрос, а не просьба сделать без плана.
  const direct =
    /^\s*(без\s+плана[\s,.:;—-]*|(просто|сразу)[\s,]+(?=(сделай|делай|поправь|исправь|добавь|удали|поменяй|замени|переименуй|убери|запусти|обнови|напиши|создай)))/iu
  const p = plan.exec(text)
  if (p) return { mode: 'plan', rest: text.slice(p[0].length).trim() || text }
  const d = direct.exec(text)
  if (d) return { mode: 'direct', rest: text.slice(d[0].length).trim() || text }
  return { mode: null, rest: text }
}

/** «Изучи проект» — создать CLAUDE.md командой /init. */
export function isInit(text: string): boolean {
  return /^\s*(изучи|проанализируй|разбери)\s+(проект|кодовую\s+базу|код)\s*[.!]?\s*$/iu.test(text)
}

/** «Откати», «верни как было» — вернуть проект к точке отката. */
export function isRollback(text: string): boolean {
  return /^\s*(откати\p{L}*|верни\s+(всё|все)?\s*как\s+было|отмени\s+(все\s+|всё\s+)?изменения)/iu.test(text)
}

const ORDINALS: Record<string, number> = {
  '1': 1, один: 1, первый: 1, первое: 1, первую: 1, первая: 1,
  '2': 2, два: 2, второй: 2, второе: 2, вторую: 2, вторая: 2,
  '3': 3, три: 3, третий: 3, третье: 3, третью: 3, третья: 3,
  '4': 4, четыре: 4, четвертый: 4, четвертое: 4, четвертую: 4, четвертая: 4,
  '5': 5, пять: 5, пятый: 5, пятое: 5, пятую: 5, пятая: 5
}

/** «Второй вариант», «три» → номер варианта; иначе null. */
export function parseOrdinal(text: string): number | null {
  const w = words(text)
  if (w.length === 0 || w.length > 4) return null
  for (const x of w) if (ORDINALS[x] !== undefined) return ORDINALS[x]!
  return null
}

const LIST_GLUE = /^(и|а|еще|также|плюс|вариант\p{L}*|номер\p{L}*|пункт\p{L}*)$/u

/**
 * «Первый и третий», «1, 3» → [1, 3] — для вопроса с несколькими ответами.
 * Каждое значимое слово должно быть номером: «первый, но лучше без третьего» — не список.
 */
export function parseOrdinals(text: string): number[] | null {
  const w = words(text).filter((x) => !FILLER.test(x) && !LIST_GLUE.test(x))
  if (w.length === 0 || w.length > 5) return null
  const nums: number[] = []
  for (const x of w) {
    const n = ORDINALS[x]
    if (n === undefined) return null
    if (!nums.includes(n)) nums.push(n)
  }
  return nums
}
