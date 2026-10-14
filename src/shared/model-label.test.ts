import { test } from 'node:test'
import assert from 'node:assert/strict'
import { modelLabel } from './model-label.ts'

test('modelLabel: версии и даты', () => {
  assert.equal(modelLabel('claude-sonnet-5-5'), 'Sonnet 5.5')
  assert.equal(modelLabel('claude-opus-5-5'), 'Opus 5.5')
  assert.equal(modelLabel('claude-fable-5-1'), 'Fable 5.1')
  assert.equal(modelLabel('claude-haiku-4-5-20251001'), 'Haiku 4.5')
  assert.equal(modelLabel('claude-opus-5'), 'Opus 5')
  assert.equal(modelLabel('opus'), 'Opus')
  assert.equal(modelLabel('fable'), 'Fable')
})

test('modelLabel: незнакомый id как есть, служебный — не модель', () => {
  assert.equal(modelLabel('some-model'), 'some-model')
  assert.equal(modelLabel('<synthetic>'), null)
})
