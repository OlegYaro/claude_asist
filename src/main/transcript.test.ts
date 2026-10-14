import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { detailOfToolInput, toolErrorText, TranscriptTailer } from './transcript.ts'
import type { TranscriptEvent } from '../shared/types.ts'

test('detailOfToolInput: Bash — команда целиком, с переводами строк', () => {
  const command = 'git add -A &&\n  git commit -m "очень длинное сообщение коммита"'
  assert.equal(detailOfToolInput('Bash', { command }), command)
})

test('detailOfToolInput: файловые инструменты — полный путь', () => {
  for (const name of ['Read', 'Write', 'Edit', 'NotebookEdit']) {
    assert.equal(detailOfToolInput(name, { file_path: '/a/b/c.ts', content: 'x' }), '/a/b/c.ts')
  }
})

test('detailOfToolInput: Agent/Task — описание и промт', () => {
  assert.equal(
    detailOfToolInput('Agent', { description: 'Поиск', prompt: 'Найди всё' }),
    'Поиск\n\nНайди всё'
  )
  assert.equal(detailOfToolInput('Task', { prompt: 'Только промт' }), 'Только промт')
})

test('detailOfToolInput: ExitPlanMode, поиск и веб', () => {
  assert.equal(detailOfToolInput('ExitPlanMode', { plan: '# План\n\n1. шаг' }), '# План\n\n1. шаг')
  assert.equal(detailOfToolInput('Grep', { pattern: 'foo\\s+bar', path: 'src' }), 'foo\\s+bar')
  assert.equal(detailOfToolInput('Glob', { pattern: 'src/**/*.ts' }), 'src/**/*.ts')
  assert.equal(detailOfToolInput('WebSearch', { query: 'node test' }), 'node test')
  assert.equal(detailOfToolInput('WebFetch', { url: 'https://example.com/x' }), 'https://example.com/x')
})

test('detailOfToolInput: неизвестный инструмент и непривычная форма — JSON', () => {
  const input = { a: 1, b: ['x'] }
  assert.equal(detailOfToolInput('Mystery', input), JSON.stringify(input, null, 2))
  assert.equal(detailOfToolInput('Bash', { cmd: 'ls' }), JSON.stringify({ cmd: 'ls' }, null, 2))
  assert.equal(detailOfToolInput('Bash', null), '')
  assert.equal(detailOfToolInput('Bash', 'ls'), '')
})

test('detailOfToolInput: обрезка до 20000 символов с пометкой', () => {
  const out = detailOfToolInput('Bash', { command: 'x'.repeat(25000) })
  assert.equal(out, `${'x'.repeat(20000)}… (обрезано)`)
  assert.equal(detailOfToolInput('Bash', { command: 'y'.repeat(20000) }), 'y'.repeat(20000))
})

test('toolErrorText: сохраняет переводы строк, обрезает до max', () => {
  assert.equal(toolErrorText('  ошибка\n  в строке 2\n'), 'ошибка\n  в строке 2')
  assert.equal(toolErrorText('a'.repeat(5000)), `${'a'.repeat(4000)}…`)
  assert.equal(toolErrorText('   '), '')
})

/** Прогоняет записи через Tailer (replayExisting) и возвращает события. */
async function run(records: unknown[]): Promise<TranscriptEvent[]> {
  const dir = mkdtempSync(join(tmpdir(), 'cvd-transcript-'))
  const file = join(dir, 's.jsonl')
  writeFileSync(file, records.map((r) => JSON.stringify(r)).join('\n') + '\n')
  const tailer = new TranscriptTailer(file, dir, true)
  const events: TranscriptEvent[] = []
  tailer.on('event', (e: TranscriptEvent) => events.push(e))
  tailer.start()
  await new Promise((r) => setTimeout(r, 100))
  tailer.stop()
  rmSync(dir, { recursive: true, force: true })
  return events
}

const usage = { input_tokens: 10, cache_creation_input_tokens: 20, cache_read_input_tokens: 30, output_tokens: 40 }

function assistant(id: string | undefined, content: unknown[], u: unknown = usage): unknown {
  return {
    type: 'assistant',
    timestamp: '2026-01-01T00:00:00Z',
    message: { id, model: 'claude-opus-4-1', content, usage: u }
  }
}

test('usage: инструменты копятся по message.id между записями', async () => {
  const events = await run([
    assistant('m1', [{ type: 'text', text: 'Сейчас' }]),
    assistant('m1', [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }]),
    assistant('m1', [{ type: 'tool_use', id: 't2', name: 'Read', input: { file_path: '/x' } }])
  ])
  const u = events.filter((e) => e.kind === 'usage')
  assert.equal(u.length, 3)
  assert.deepEqual(
    u.map((e) => e.kind === 'usage' && e.tools),
    [[], ['Bash'], ['Bash', 'Read']]
  )
  const last = u[2]
  assert.ok(last?.kind === 'usage')
  assert.equal(last.messageId, 'm1')
  assert.deepEqual(last.usage, { input: 10, cacheWrite: 20, cacheRead: 30, output: 40 })

  const start = events.find((e) => e.kind === 'task-start')
  assert.ok(start?.kind === 'task-start')
  assert.equal(start.task.detail, 'ls')
})

test('usage: без id или без usage — не эмитится', async () => {
  const events = await run([
    assistant(undefined, [{ type: 'text', text: 'a' }]),
    assistant('m2', [{ type: 'text', text: 'b' }], null)
  ])
  assert.equal(events.filter((e) => e.kind === 'usage').length, 0)
})

test('usage субагента из toolUseResult.totalTokens; ошибка с переводами строк', async () => {
  const toolResult = (id: string, extra: Record<string, unknown> = {}, isError = false): unknown => ({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'строка 1\nстрока 2', is_error: isError }] },
    ...extra
  })
  const events = await run([
    assistant('m3', [
      { type: 'tool_use', id: 'a1', name: 'Agent', input: { description: 'd', prompt: 'p' } },
      { type: 'tool_use', id: 'a2', name: 'Agent', input: { description: 'd', prompt: 'p' } },
      { type: 'tool_use', id: 'b1', name: 'Bash', input: { command: 'false' } }
    ]),
    toolResult('a1', { toolUseResult: { totalTokens: 1234 } }),
    toolResult('a2', { toolUseResult: { totalTokens: 'много' } }),
    toolResult('b1', {}, true)
  ])
  const agentUsage = events.filter((e) => e.kind === 'usage' && e.messageId.startsWith('agent:'))
  assert.deepEqual(agentUsage.map((e) => e.kind === 'usage' && [e.messageId, e.tools, e.usage]), [
    ['agent:a1', ['Agent'], { input: 0, cacheWrite: 0, cacheRead: 0, output: 1234 }]
  ])
  const end = events.find((e) => e.kind === 'task-end' && e.id === 'b1')
  assert.ok(end?.kind === 'task-end')
  assert.equal(end.error, 'строка 1\nстрока 2')
})
