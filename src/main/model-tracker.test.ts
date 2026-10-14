import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ModelTracker } from './model-tracker.ts'

test('субагент на другой модели, затем возврат к модели сессии', () => {
  const t = new ModelTracker()
  assert.equal(t.setMain('claude-sonnet-5-5'), 'claude-sonnet-5-5')
  assert.equal(t.agentStart('a1', 'opus'), 'opus')
  assert.equal(t.agentEnd('a1'), 'claude-sonnet-5-5')
})

test('параллельные субагенты: показываем последний из работающих', () => {
  const t = new ModelTracker()
  t.setMain('claude-sonnet-5-5')
  t.agentStart('a1', 'haiku')
  assert.equal(t.agentStart('a2', 'opus'), 'opus')
  assert.equal(t.agentEnd('a2'), 'haiku')
  assert.equal(t.agentEnd('a1'), 'claude-sonnet-5-5')
})

test('Agent без model, чужой id и повторное завершение ничего не меняют', () => {
  const t = new ModelTracker()
  t.setMain('claude-sonnet-5-5')
  assert.equal(t.agentStart('a1', undefined), null)
  assert.equal(t.agentEnd('a1'), null)
  assert.equal(t.agentEnd('нет-такого'), null)
})

test('<synthetic> не перезаписывает модель', () => {
  const t = new ModelTracker()
  t.setMain('claude-opus-5-5')
  assert.equal(t.setMain('<synthetic>'), null)
  assert.equal(t.agentStart('a1', 'sonnet'), 'sonnet')
  assert.equal(t.agentEnd('a1'), 'claude-opus-5-5')
})

test('запись основной цепочки во время работы субагента не сбивает шапку', () => {
  const t = new ModelTracker()
  t.agentStart('a1', 'opus')
  assert.equal(t.setMain('claude-sonnet-5-5'), 'opus')
  assert.equal(t.agentEnd('a1'), 'claude-sonnet-5-5')
})

test('прерывание хода сбрасывает субагентов', () => {
  const t = new ModelTracker()
  t.setMain('claude-sonnet-5-5')
  t.agentStart('a1', 'opus')
  assert.equal(t.reset(), 'claude-sonnet-5-5')
  assert.equal(t.reset(), null)
})
