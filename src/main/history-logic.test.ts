import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  APP_SESSION_NAME,
  ROLLBACK_PROMPT_PREFIX,
  TranscriptSummarizer,
  promptText
} from './history-logic.ts'

const ID = '8fffda96-9270-4c8c-b120-c4da772c1005'
let clock = Date.parse('2026-10-01T10:00:00Z')

function at(): string {
  clock += 1000
  return new Date(clock).toISOString()
}

function user(content: unknown, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { type: 'user', cwd: '/p', timestamp: at(), message: { role: 'user', content }, ...extra }
}

function toolUse(name: string, input: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'assistant',
    timestamp: at(),
    message: { content: [{ type: 'tool_use', id: `t${clock}`, name, input }] }
  }
}

function reply(text: string): Record<string, unknown> {
  return { type: 'assistant', timestamp: at(), message: { content: [{ type: 'text', text }] } }
}

function summarize(records: unknown[]) {
  const s = new TranscriptSummarizer()
  for (const r of records) s.add(r)
  return { cwd: s.cwd, result: s.result(ID) }
}

test('promptText: обычный запрос — строкой и текстовыми блоками', () => {
  assert.equal(promptText(user('  добавь кнопку  ')), 'добавь кнопку')
  assert.equal(promptText(user([{ type: 'text', text: 'почини тест' }])), 'почини тест')
})

test('promptText: служебные записи — не запросы', () => {
  assert.equal(promptText(user('Stop hook feedback:\nревью…', { isMeta: true })), null)
  assert.equal(promptText(user('<command-name>/plan</command-name>')), null)
  assert.equal(promptText(user('<local-command-stdout>ok</local-command-stdout>')), null)
  assert.equal(promptText(user('[Request interrupted by user]')), null)
  assert.equal(promptText(user('от субагента', { isSidechain: true })), null)
  assert.equal(promptText(user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }])), null)
  assert.equal(promptText(reply('ответ')), null)
  assert.equal(promptText(null), null)
})

test('итоги запросов: ответ, план, правки, прервано, откат', () => {
  const { result } = summarize([
    user('что делает этот файл?'),
    reply('Он читает настройки.'),
    user('сделай панель истории'),
    toolUse('ExitPlanMode', { plan: '# План' }),
    toolUse('Edit', { file_path: '/p/a.ts' }),
    toolUse('Write', { file_path: '/p/b.ts' }),
    toolUse('Edit', { file_path: '/p/a.ts' }),
    user([{ type: 'tool_result', tool_use_id: 'x', content: 'ok' }]),
    user('составь план миграции'),
    toolUse('ExitPlanMode', { plan: '# Миграция' }),
    user('перепиши всё'),
    toolUse('Edit', { file_path: '/p/c.ts' }),
    user([{ type: 'text', text: '[Request interrupted by user]' }]),
    user(`${ROLLBACK_PROMPT_PREFIX} abc123: выполни git restore`),
    toolUse('Bash', { command: 'git restore' })
  ])
  assert.ok(result)
  assert.deepEqual(
    result.requests.map((r) => [r.text.slice(0, 12), r.outcome, r.files]),
    [
      ['что делает э', 'answer', 0],
      ['сделай панел', 'edits', 2],
      ['составь план', 'plan', 0],
      ['перепиши всё', 'interrupted', 1],
      [ROLLBACK_PROMPT_PREFIX.slice(0, 12), 'rollback', 0]
    ]
  )
})

test('правки субагента и служебные записи не создают запросов', () => {
  const { result } = summarize([
    user('проверь проект'),
    { ...toolUse('Edit', { file_path: '/p/x.ts' }), isSidechain: true },
    user('Stop hook feedback: проверки упали', { isMeta: true }),
    toolUse('NotebookEdit', { notebook_path: '/p/n.ipynb' })
  ])
  assert.equal(result?.requests.length, 1)
  assert.equal(result?.requests[0]?.outcome, 'edits')
  assert.equal(result?.requests[0]?.files, 1)
})

test('название: своё → от Claude → первая фраза; имя приложения не название', () => {
  const first = user('сделай тёмную тему для настроек')
  const app = { type: 'custom-title', customTitle: APP_SESSION_NAME }
  assert.equal(summarize([app, first]).result?.title, 'сделай тёмную тему для настроек')
  assert.equal(
    summarize([app, first, { type: 'ai-title', aiTitle: 'Тёмная тема' }]).result?.title,
    'Тёмная тема'
  )
  assert.equal(
    summarize([first, { type: 'ai-title', aiTitle: 'Тёмная тема' }, { type: 'custom-title', customTitle: 'Моё' }])
      .result?.title,
    'Моё'
  )
})

test('сессия приложения, cwd и время', () => {
  const start = clock
  const { cwd, result } = summarize([
    { type: 'agent-name', agentName: APP_SESSION_NAME },
    user('привет'),
    reply('Здравствуйте')
  ])
  assert.equal(cwd, '/p')
  assert.equal(result?.fromApp, true)
  assert.equal(result?.startedAt, start + 1000)
  assert.equal(result?.updatedAt, start + 2000)
  assert.equal(result?.id, ID)
})

test('сессия без запросов — null; ручная сессия — не из приложения', () => {
  assert.equal(summarize([{ type: 'custom-title', customTitle: APP_SESSION_NAME }]).result, null)
  assert.equal(summarize([user('ls')]).result?.fromApp, false)
})

test('длинный запрос и длинное название обрезаются', () => {
  const long = 'а'.repeat(800)
  const { result } = summarize([user(long)])
  assert.equal(result?.requests[0]?.text.length, 500)
  assert.ok(result?.title.endsWith('…'))
  assert.equal(result?.title.length, 80)
})
