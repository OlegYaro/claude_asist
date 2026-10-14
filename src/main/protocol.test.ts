import test from 'node:test'
import assert from 'node:assert/strict'
import { sessionProtocol } from './protocol.ts'

test('sessionProtocol: выключенные плагины предлагаются с маркером', () => {
  const text = sessionProtocol({ autoModel: false })
  assert.match(text, /\[\[подключить: id\]\]/)
  assert.match(text, /- playwright —/)
})

test('sessionProtocol: включённый плагин не предлагается', () => {
  const text = sessionProtocol({ autoModel: false, enabledPlugins: ['playwright'] })
  assert.doesNotMatch(text, /- playwright —/)
  assert.match(text, /- context7 —/)
})

test('sessionProtocol: все плагины включены — раздела нет', () => {
  const all = ['playwright', 'context7', 'pr-review-toolkit', 'feature-dev']
  assert.doesNotMatch(sessionProtocol({ autoModel: true, enabledPlugins: all }), /Выключенные плагины/)
})
