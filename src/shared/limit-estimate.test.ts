import test from 'node:test'
import assert from 'node:assert/strict'
import { LimitTracker, dominantModel, priceFor, usageCostUsd, weightUsage, WINDOW_SEC } from './limit-estimate.ts'

const U = (input = 0, cacheWrite = 0, cacheRead = 0, output = 0) => ({ input, cacheWrite, cacheRead, output })

test('priceFor: модели и алиасы', () => {
  assert.equal(priceFor('claude-fable-5-1').output, 50)
  assert.equal(priceFor('claude-opus-5-5').input, 4)
  assert.equal(priceFor('claude-opus-4-8').input, 5)
  assert.equal(priceFor('sonnet').output, 10)
  assert.equal(priceFor('claude-haiku-5-5').input, 0.1)
  assert.equal(priceFor('claude-haiku-4-5').input, 1)
  assert.equal(priceFor(null).input, 2)
})

test('usageCostUsd: кэш дёшев, выход дорог', () => {
  // 1М чтения кэша на Sonnet 5.5 = $0,20; 1М выхода = $10.
  assert.equal(usageCostUsd(U(0, 0, 1_000_000, 0), 'sonnet'), 0.2)
  assert.equal(usageCostUsd(U(0, 0, 0, 1_000_000), 'sonnet'), 10)
  assert.deepEqual(weightUsage(U(10, 0, 0, 1), 'sonnet'), U(20, 0, 0, 10))
})

const NOW = 1_800_000_000
const win = NOW + WINDOW_SEC // resets_at
const ms = (sec: number): number => sec * 1000

test('калибровка: прирост процента делится на расход сессии', () => {
  const t = new LimitTracker()
  t.observe(10, win)
  t.addUsage('a', 2, ms(NOW + 10))
  t.observe(14, win) // +4 % за $2 → 2 % на доллар
  t.addUsage('b', 1, ms(NOW + 20))
  const s = t.snapshot()
  assert.equal(s.totalPct, 14)
  assert.equal(s.costUsd, 3)
  assert.equal(s.sessionPct, 6)
})

test('чужие терминалы: процент вырос, а мы не тратили — интервал отбрасывается', () => {
  const t = new LimitTracker()
  t.observe(10, win)
  t.observe(20, win) // нашего расхода нет
  assert.equal(t.snapshot().sessionPct, null)
  t.addUsage('a', 1, ms(NOW + 5))
  t.observe(22, win) // +2 % за $1
  assert.equal(t.snapshot().sessionPct, 2)
})

test('медиана гасит выброс от параллельной сессии', () => {
  const t = new LimitTracker([1, 1, 1, 1, 50])
  t.addUsage('a', 4, ms(NOW + 5))
  t.observe(5, win)
  assert.equal(t.snapshot().sessionPct, 4)
})

test('новое окно лимита обнуляет расход, калибровка остаётся', () => {
  const t = new LimitTracker([2])
  t.observe(10, win)
  t.addUsage('a', 3, ms(NOW + 5))
  assert.equal(t.snapshot().sessionPct, 6)
  const next = win + WINDOW_SEC
  t.observe(1, next)
  const s = t.snapshot()
  assert.equal(s.costUsd, 0)
  assert.equal(s.sessionPct, 0)
  assert.deepEqual(t.calibration, [2])
})

test('оценка не больше общего процента; повтор id заменяет запись', () => {
  const t = new LimitTracker([100])
  t.observe(7, win)
  t.addUsage('a', 1, ms(NOW + 5))
  t.addUsage('a', 2, ms(NOW + 6))
  const s = t.snapshot()
  assert.equal(s.costUsd, 2)
  assert.equal(s.sessionPct, 7)
})

test('resetSession: расход старой сессии не входит', () => {
  const t = new LimitTracker([1])
  t.observe(5, win)
  t.addUsage('a', 3, ms(NOW + 5))
  t.resetSession()
  assert.equal(t.snapshot().costUsd, 0)
})

test('observe игнорирует нечисловые значения', () => {
  const t = new LimitTracker()
  t.observe(Number.NaN, win)
  assert.equal(t.snapshot().totalPct, null)
})

test('dominantModel: модель с наибольшим числом токенов', () => {
  assert.equal(
    dominantModel({
      'claude-haiku-5-5': { inputTokens: 5, outputTokens: 5 },
      'claude-opus-5-5': { inputTokens: 10, outputTokens: 20, cacheReadInputTokens: 1000 }
    }),
    'claude-opus-5-5'
  )
  assert.equal(dominantModel({ 'claude-fable-5-1': {} }), 'claude-fable-5-1')
  assert.equal(dominantModel({}), null)
  assert.equal(dominantModel(undefined), null)
})
