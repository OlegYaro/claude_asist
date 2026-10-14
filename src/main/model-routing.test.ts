import { test } from 'node:test'
import assert from 'node:assert/strict'
import { completionReason, escalate, parsePlanModels, planEscalations, type StepModel } from './model-routing.ts'

const PLAN = `# План

## Шаги
1. Добавить настройку — sonnet

## Модели
1. Найти места использования — haiku
2) Реализовать **парсер** — Sonnet
3. Продумать безопасность — **opus**
4. Строка без модели
- 5. маркер списка — haiku

## Риски и вопросы
6. Не шаг — haiku`

test('parsePlanModels: только раздел «Модели», регистр и оформление', () => {
  assert.deepEqual(parsePlanModels(PLAN), [
    { n: 1, text: 'Найти места использования', model: 'haiku' },
    { n: 2, text: 'Реализовать парсер', model: 'sonnet' },
    { n: 3, text: 'Продумать безопасность', model: 'opus' }
  ])
})

test('parsePlanModels: нет раздела — пусто', () => {
  assert.deepEqual(parsePlanModels('## Шаги\n1. Сделать — sonnet'), [])
  assert.deepEqual(parsePlanModels(''), [])
})

test('parsePlanModels: дефис и тире, заголовок с жирным', () => {
  assert.deepEqual(parsePlanModels('### **Модели**\n1. A - haiku\n2. B – `opus`'), [
    { n: 1, text: 'A', model: 'haiku' },
    { n: 2, text: 'B', model: 'opus' }
  ])
})

test('escalate: ступенька вверх, fable — потолок', () => {
  assert.equal(escalate('haiku'), 'sonnet')
  assert.equal(escalate('sonnet'), 'opus')
  assert.equal(escalate('opus'), 'fable')
  assert.equal(escalate('fable'), 'fable')
})

test('planEscalations: от модели шага, повторный круг — выше', () => {
  const steps = parsePlanModels(PLAN)
  const tried = new Map<number, StepModel>()
  assert.deepEqual(planEscalations([{ step: 1, what: 'не найдено' }], steps, tried), [
    { step: 1, title: 'Найти места использования', what: 'не найдено', model: 'sonnet' }
  ])
  assert.equal(planEscalations([{ step: 1, what: 'снова' }], steps, tried)[0]!.model, 'opus')
})

test('parsePlanModels: fable как модель шага', () => {
  assert.deepEqual(parsePlanModels('## Модели\n1. Спроектировать — fable'), [
    { n: 1, text: 'Спроектировать', model: 'fable' }
  ])
})

test('planEscalations: пункт вне шагов — сильнее исполнителя сессии', () => {
  const [e] = planEscalations([{ step: 0, what: 'нет тестов' }], [], new Map())
  assert.deepEqual(e, { step: 0, title: null, what: 'нет тестов', model: 'opus' })
})

test('completionReason: шаг, модель и указание доделать', () => {
  const text = completionReason([
    { step: 2, title: 'Реализовать парсер', what: 'нет обработки ошибок', model: 'opus' },
    { step: 0, title: null, what: 'нет тестов', model: 'opus' }
  ])
  assert.match(text, /Шаг 2 «Реализовать парсер»: нет обработки ошибок/)
  assert.match(text, /Вне шагов плана: нет тестов/)
  assert.match(text, /model: "opus"/)
})
