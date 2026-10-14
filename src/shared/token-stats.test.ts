import test from 'node:test'
import assert from 'node:assert/strict'
import { aggregateTokens, parseUsage, totalTokens } from './token-stats.ts'
import { usageCategory } from './action-kind.ts'

const u = (input: number, output = 0, cacheWrite = 0, cacheRead = 0) => ({
  input,
  cacheWrite,
  cacheRead,
  output
})

test('parseUsage: нормальная запись', () => {
  const r = parseUsage({
    input_tokens: 3,
    cache_creation_input_tokens: 100,
    cache_read_input_tokens: 2000,
    output_tokens: 50
  })
  assert.deepEqual(r, u(3, 50, 100, 2000))
  assert.equal(totalTokens(r!), 2153)
})

test('parseUsage: мусор и нули', () => {
  assert.equal(parseUsage(null), null)
  assert.equal(parseUsage('x'), null)
  assert.equal(parseUsage([1]), null)
  assert.deepEqual(parseUsage({}), u(0))
  assert.deepEqual(
    parseUsage({ input_tokens: -5, output_tokens: '7', cache_read_input_tokens: NaN }),
    u(0)
  )
})

test('aggregateTokens: деление поровну между инструментами', () => {
  const r = aggregateTokens([{ tools: ['Edit', 'Bash'], usage: u(0, 100) }])
  assert.equal(r.length, 2)
  assert.deepEqual(r.map((x) => x.total), [50, 50])
  assert.deepEqual(r.map((x) => x.category).sort(), ['command', 'edit'])
})

test('aggregateTokens: одна категория суммируется, остаток не теряется', () => {
  const r = aggregateTokens([{ tools: ['Read', 'Grep', 'Glob'], usage: u(0, 10) }])
  assert.equal(r.length, 1)
  assert.equal(r[0]?.category, 'read')
  assert.equal(r[0]?.total, 10)
})

test("aggregateTokens: 'answer', служебные имена, сортировка и нули", () => {
  const r = aggregateTokens([
    { tools: [], usage: u(10) },
    { tools: ['Ревью'], usage: u(500) },
    { tools: ['Bash'], usage: u(0) },
    { tools: [], usage: u(5) }
  ])
  assert.deepEqual(
    r.map((x) => [x.category, x.total]),
    [
      ['review', 500],
      ['answer', 15]
    ]
  )
})

test('usageCategory', () => {
  assert.equal(usageCategory([]), 'answer')
  assert.equal(usageCategory(['Bash', 'Edit']), 'command')
  assert.equal(usageCategory(['Ревью']), 'review')
})
