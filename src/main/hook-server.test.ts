import test from 'node:test'
import assert from 'node:assert/strict'
import { parseRateLimits } from './hook-server.ts'

test('parseRateLimits: 5-часовое окно из статус-строки', () => {
  const r = parseRateLimits({
    session_id: 's1',
    rate_limits: { five_hour: { used_percentage: 12.5, resets_at: 1800000000 }, seven_day: { used_percentage: 3, resets_at: 1 } }
  })
  assert.deepEqual(r, { sessionId: 's1', fiveHour: { usedPercentage: 12.5, resetsAt: 1800000000 } })
})

test('parseRateLimits: нет лимитов или чужая форма', () => {
  assert.deepEqual(parseRateLimits({ session_id: 's1' }), { sessionId: 's1', fiveHour: null })
  assert.deepEqual(parseRateLimits({ session_id: 's1', rate_limits: { five_hour: { used_percentage: '5' } } }), {
    sessionId: 's1',
    fiveHour: null
  })
  assert.equal(parseRateLimits({ rate_limits: {} }), null)
  assert.equal(parseRateLimits(null), null)
})
