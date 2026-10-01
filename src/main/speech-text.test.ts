import { test } from 'node:test'
import assert from 'node:assert/strict'
import { PHRASE_MAX_CHARS, speechPhrases } from './speech-text.ts'

test('разметка снимается, текст остаётся', () => {
  assert.deepEqual(
    speechPhrases('## Итог\n\n**Готово**: правка в `index.ts`, см. [README](https://x.dev/r).'),
    ['Итог. Готово: правка в index.ts, см. README.']
  )
})

test('пункты списка — отдельные предложения', () => {
  assert.deepEqual(speechPhrases('Сделано:\n- первое\n- второе\n1. третье'), [
    'Сделано: первое. второе. третье.'
  ])
})

test('блок кода заменяется пометкой, подряд идущие — одной', () => {
  assert.deepEqual(
    speechPhrases('Запустите:\n```bash\nnpm test\n```\n```\nnpm run build\n```\nИ всё.'),
    ['Запустите: Фрагмент кода. И всё.']
  )
})

test('незакрытый блок кода не читается до конца', () => {
  assert.deepEqual(speechPhrases('Вот:\n```ts\nconst a = 1'), ['Вот: Фрагмент кода.'])
})

test('голая ссылка и таблица читаются по-человечески', () => {
  assert.deepEqual(
    speechPhrases('См. https://example.com/a?b=1\n\n| Файл | Итог |\n|---|---|\n| a.ts | ок |'),
    ['См. ссылка. Файл, Итог. a.ts, ок.']
  )
})

test('snake_case и точки внутри имён не ломаются', () => {
  assert.deepEqual(speechPhrases('Поле speak_replies в settings.json.'), [
    'Поле speak_replies в settings.json.'
  ])
})

test('слэши, кавычки, скобки и стрелки не читаются вслух', () => {
  assert.deepEqual(
    speechPhrases('Путь src/main\\speaker.ts: "кавычки" и «ёлочки», {a} <b> [c] | #1 ^~ Настройки → Голос'),
    ['Путь src main speaker.ts: кавычки и ёлочки, a b c 1 Настройки, Голос.']
  )
})

test('апостроф внутри слова остаётся, вокруг слова — снимается', () => {
  assert.deepEqual(speechPhrases("Don't touch 'это'."), ["Don't touch это."])
})

test('длинный текст режется по предложениям в пределах лимита', () => {
  const sentence = 'Это предложение средней длины для проверки нарезки.'
  const phrases = speechPhrases(Array(20).fill(sentence).join(' '))
  assert.ok(phrases.length > 1)
  for (const p of phrases) {
    assert.ok(p.length <= PHRASE_MAX_CHARS, `длина ${p.length}`)
    assert.ok(p.endsWith('.'), 'режем на границе предложения')
  }
  assert.equal(phrases.join(' '), Array(20).fill(sentence).join(' '))
})

test('сверхдлинное предложение режется по словам', () => {
  const long = Array(100).fill('слово').join(' ')
  const phrases = speechPhrases(long, 50)
  for (const p of phrases) assert.ok(p.length <= 50)
  assert.equal(phrases.join(' '), `${long}.`)
})

test('пустой ответ и одна разметка — нечего читать', () => {
  assert.deepEqual(speechPhrases(''), [])
  assert.deepEqual(speechPhrases('---\n\n   \n'), [])
})
