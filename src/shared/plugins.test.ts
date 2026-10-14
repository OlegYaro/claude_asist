import test from 'node:test'
import assert from 'node:assert/strict'
import { enabledPluginsSetting, findPlugin, parsePluginRequest } from './plugins.ts'

test('parsePluginRequest: находит маркер и убирает его из текста', () => {
  const r = parsePluginRequest('Нужен браузер.\n\n[[подключить: playwright]]')
  assert.equal(r.plugin?.id, 'playwright')
  assert.equal(r.text, 'Нужен браузер.')
})

test('parsePluginRequest: регистр и пробелы не важны', () => {
  assert.equal(parsePluginRequest('[[ Подключить : Context7 ]]').plugin?.id, 'context7')
})

test('parsePluginRequest: неизвестный плагин игнорируется, но маркер убирается', () => {
  const r = parsePluginRequest('Текст [[подключить: evil]] дальше')
  assert.equal(r.plugin, null)
  assert.equal(r.text, 'Текст  дальше')
})

test('parsePluginRequest: без маркера текст не меняется', () => {
  const r = parsePluginRequest('Просто ответ\n\n\nс пустыми строками')
  assert.equal(r.plugin, null)
  assert.equal(r.text, 'Просто ответ\n\n\nс пустыми строками')
})

test('parsePluginRequest: повторные вызовы не зависят друг от друга', () => {
  assert.equal(parsePluginRequest('[[подключить: playwright]]').plugin?.id, 'playwright')
  assert.equal(parsePluginRequest('[[подключить: playwright]]').plugin?.id, 'playwright')
})

test('enabledPluginsSetting: только известные плагины', () => {
  assert.deepEqual(enabledPluginsSetting(['playwright', 'nope']), {
    'playwright@claude-plugins-official': true
  })
  assert.deepEqual(enabledPluginsSetting([]), {})
})

test('findPlugin', () => {
  assert.equal(findPlugin('feature-dev')?.title, 'Feature Dev')
  assert.equal(findPlugin('x'), null)
})
