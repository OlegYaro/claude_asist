import { test } from 'node:test'
import assert from 'node:assert/strict'
import { answerFor, parseQuestions } from './questions.ts'
import { parseOrdinals } from '../shared/intents.ts'

const INPUT = {
  questions: [
    {
      question: 'Цвет?',
      header: 'Цвет',
      multiSelect: false,
      options: [{ label: 'Красный' }, { label: 'Синий' }, { label: 'Зелёный' }]
    },
    {
      question: 'Фрукты?',
      header: 'Фрукты',
      multiSelect: true,
      options: [{ label: 'Яблоко' }, { label: 'Груша' }, { label: 'Слива' }]
    }
  ]
}

test('parseQuestions: все вопросы, а не только первый', () => {
  assert.deepEqual(parseQuestions(INPUT), [
    { question: 'Цвет?', options: ['Красный', 'Синий', 'Зелёный'], multiSelect: false },
    { question: 'Фрукты?', options: ['Яблоко', 'Груша', 'Слива'], multiSelect: true }
  ])
})

test('parseQuestions: мусор на входе', () => {
  assert.deepEqual(parseQuestions(null), [])
  assert.deepEqual(parseQuestions({ questions: 'нет' }), [])
  assert.deepEqual(parseQuestions({ questions: [{ options: [] }, null] }), [])
})

test('answerFor: один и несколько вариантов', () => {
  const [color, fruits] = parseQuestions(INPUT)
  assert.equal(answerFor(color!, [2]), 'Синий')
  assert.equal(answerFor(color!, [1, 2]), null)
  assert.equal(answerFor(fruits!, [1, 3]), 'Яблоко, Слива')
  assert.equal(answerFor(fruits!, [4]), null)
  assert.equal(answerFor(fruits!, []), null)
})

test('parseOrdinals: список номеров словами и цифрами', () => {
  assert.deepEqual(parseOrdinals('первый и третий'), [1, 3])
  assert.deepEqual(parseOrdinals('1, 3'), [1, 3])
  assert.deepEqual(parseOrdinals('варианты два и четыре'), [2, 4])
  assert.deepEqual(parseOrdinals('второй'), [2])
  assert.deepEqual(parseOrdinals('1 1 2'), [1, 2])
})

test('parseOrdinals: фраза с посторонними словами — не список', () => {
  assert.equal(parseOrdinals('первый, но без третьего'), null)
  assert.equal(parseOrdinals('сделай как лучше'), null)
  assert.equal(parseOrdinals(''), null)
})
