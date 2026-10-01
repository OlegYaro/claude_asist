import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_GITIGNORE,
  canInitRepo,
  commitAll,
  commitMessage,
  ensureRepo,
  findSecrets,
  snapshotTree,
  staleCheckpoints
} from './quality.ts'

test('staleCheckpoints: оставляет самые свежие, чужие ссылки не трогает', () => {
  const refs = [
    'refs/cvd/checkpoint-100',
    'refs/cvd/checkpoint-300',
    'refs/cvd/other',
    'refs/cvd/checkpoint-200',
    ''
  ]
  assert.deepEqual(staleCheckpoints(refs, 2), ['refs/cvd/checkpoint-100'])
  assert.deepEqual(staleCheckpoints(refs, 5), [])
  assert.deepEqual(staleCheckpoints(refs, 0), [
    'refs/cvd/checkpoint-300',
    'refs/cvd/checkpoint-200',
    'refs/cvd/checkpoint-100'
  ])
})

function git(dir: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t'
    }
  }).trim()
}

test('snapshotTree: всё рабочее состояние, настоящий индекс не меняется', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvd-snap-'))
  try {
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a1')
    writeFileSync(join(dir, '.gitignore'), 'ignored.txt\n')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    const committed = git(dir, 'rev-parse', 'HEAD^{tree}')
    assert.equal(await snapshotTree(dir), committed)

    writeFileSync(join(dir, 'a.txt'), 'a2')
    writeFileSync(join(dir, 'new.txt'), 'n')
    writeFileSync(join(dir, 'ignored.txt'), 'i')
    const indexBefore = git(dir, 'ls-files', '-s')
    const tree = await snapshotTree(dir)

    assert.ok(tree && tree !== committed)
    const files = git(dir, 'ls-tree', '--name-only', tree)
    assert.deepEqual(files.split('\n').sort(), ['.gitignore', 'a.txt', 'new.txt'])
    assert.equal(git(dir, 'show', `${tree}:a.txt`), 'a2')
    assert.equal(git(dir, 'ls-files', '-s'), indexBefore)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshotTree: настоящего индекса нет — снимок из HEAD и рабочих файлов', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvd-snap-'))
  try {
    git(dir, 'init', '-q')
    writeFileSync(join(dir, 'a.txt'), 'a1')
    git(dir, 'add', '-A')
    git(dir, 'commit', '-qm', 'init')
    rmSync(join(dir, '.git', 'index'))
    writeFileSync(join(dir, 'new.txt'), 'n')

    const tree = await snapshotTree(dir)
    assert.ok(tree)
    assert.deepEqual(git(dir, 'ls-tree', '--name-only', tree).split('\n').sort(), ['a.txt', 'new.txt'])
    assert.equal(git(dir, 'show', `${tree}:a.txt`), 'a1')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('snapshotTree: не git — null', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cvd-snap-'))
  try {
    assert.equal(await snapshotTree(dir), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

// ─────────────────────────── Git сам ───────────────────────────

/** Ненастоящие ключи собираются по частям — иначе сама проверка не пустила бы этот файл в коммит. */
const FAKE_ANTHROPIC = 'sk-' + 'ant-' + 'a'.repeat(40)
const FAKE_TELEGRAM = '1234567890' + ':AA' + 'b'.repeat(33)
const FAKE_KEY_HEADER = '-----BEGIN ' + 'RSA PRIVATE KEY-----'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'cvd-git-'))
}

test('canInitRepo: корень, домашняя и системные папки — нет, папка проекта — да', () => {
  const home = '/Users/someone'
  assert.equal(canInitRepo('/', home), false)
  assert.equal(canInitRepo(home, home), false)
  assert.equal(canInitRepo(`${home}/`, home), false)
  assert.equal(canInitRepo(`${home}/Library/Caches/x`, home), false)
  assert.equal(canInitRepo('/System/Library', home), false)
  assert.equal(canInitRepo('/usr/local/lib', home), false)
  assert.equal(canInitRepo('/Applications/Some.app', home), false)
  assert.equal(canInitRepo(`${home}/Projects/app`, home), true)
  assert.equal(canInitRepo('/var/folders/ab/T/cvd-git-1', home), true)
})

test('commitMessage: текст задачи в одну строку, не длиннее 72 символов', () => {
  assert.equal(commitMessage('  Добавь\nкнопку   выхода '), 'Voice Desk: Добавь кнопку выхода')
  assert.equal(commitMessage('   '), 'Voice Desk: изменения')
  const long = commitMessage('слово '.repeat(40))
  assert.ok(long.length <= 72, `длина ${long.length}`)
  assert.ok(long.endsWith('…'))
})

test('findSecrets: только добавленные строки, с именем файла', () => {
  const diff = [
    'diff --git a/.env b/.env',
    '+++ b/.env',
    `+ANTHROPIC_API_KEY=${FAKE_ANTHROPIC}`,
    'diff --git a/old.ts b/old.ts',
    '+++ b/old.ts',
    `-const token = '${FAKE_TELEGRAM}'`,
    'diff --git a/key.pem b/key.pem',
    '+++ b/key.pem',
    `+${FAKE_KEY_HEADER}`,
    'diff --git a/ok.ts b/ok.ts',
    '+++ b/ok.ts',
    "+const re = /sk-ant-[A-Za-z0-9_-]{20,}/"
  ].join('\n')
  assert.deepEqual(findSecrets(diff), ['.env', 'key.pem'])
  assert.deepEqual(findSecrets(''), [])
})

test('ensureRepo: создаёт репозиторий, .gitignore и первый коммит', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'index.js'), 'console.log(1)\n')
    mkdirSync(join(dir, 'node_modules', 'x'), { recursive: true })
    writeFileSync(join(dir, 'node_modules', 'x', 'a.js'), '')
    const result = await ensureRepo(dir, '/nonexistent-home')
    assert.equal(result.kind, 'created')
    assert.ok(result.kind === 'created' && result.commit?.kind === 'committed')
    assert.equal(readFileSync(join(dir, '.gitignore'), 'utf8'), DEFAULT_GITIGNORE)
    assert.equal(git(dir, 'branch', '--show-current'), 'main')
    assert.deepEqual(git(dir, 'ls-files').split('\n').sort(), ['.gitignore', 'index.js'])
    assert.equal(git(dir, 'status', '--porcelain'), '')
    // Второй раз — репозиторий уже есть, ничего не делаем.
    assert.equal((await ensureRepo(dir, '/nonexistent-home')).kind, 'exists')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ensureRepo: свой .gitignore не перезаписывается, пустая папка — без коммита', async () => {
  const withIgnore = tempDir()
  const empty = tempDir()
  try {
    writeFileSync(join(withIgnore, '.gitignore'), 'secret/\n')
    writeFileSync(join(withIgnore, 'a.txt'), 'a')
    await ensureRepo(withIgnore, '/nonexistent-home')
    assert.equal(readFileSync(join(withIgnore, '.gitignore'), 'utf8'), 'secret/\n')

    const result = await ensureRepo(empty, '/nonexistent-home')
    assert.equal(result.kind, 'created')
    assert.ok(result.kind === 'created' && result.commit === undefined)
    assert.equal(git(empty, 'rev-parse', '--is-inside-work-tree'), 'true')
  } finally {
    rmSync(withIgnore, { recursive: true, force: true })
    rmSync(empty, { recursive: true, force: true })
  }
})

test('ensureRepo: папку внутри существующего репозитория и домашнюю не трогает', async () => {
  const dir = tempDir()
  try {
    git(dir, 'init', '-q')
    const inner = join(dir, 'sub')
    mkdirSync(inner)
    assert.equal((await ensureRepo(inner, '/nonexistent-home')).kind, 'exists')

    const home = tempDir()
    try {
      assert.equal((await ensureRepo(home, home)).kind, 'skipped')
      assert.throws(() => git(home, 'rev-parse', '--git-dir'))
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll: коммитит изменения, без изменений — clean', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    await ensureRepo(dir, '/nonexistent-home')
    assert.equal((await commitAll(dir, 'пусто')).kind, 'clean')
    writeFileSync(join(dir, 'a.txt'), 'a2')
    const result = await commitAll(dir, 'Voice Desk: добавь a')
    assert.equal(result.kind, 'committed')
    assert.equal(git(dir, 'log', '-1', '--format=%s'), 'Voice Desk: добавь a')
    assert.equal(git(dir, 'status', '--porcelain'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll: секрет отменяет коммит, файлы и HEAD не меняются', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    await ensureRepo(dir, '/nonexistent-home')
    const head = git(dir, 'rev-parse', 'HEAD')
    writeFileSync(join(dir, 'config.ts'), `export const key = '${FAKE_ANTHROPIC}'\n`)

    const result = await commitAll(dir, 'с секретом')
    assert.deepEqual(result, { kind: 'secrets', files: ['config.ts'] })
    assert.equal(git(dir, 'rev-parse', 'HEAD'), head)
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '')
    assert.equal(readFileSync(join(dir, 'config.ts'), 'utf8'), `export const key = '${FAKE_ANTHROPIC}'\n`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll: секрет в самом первом коммите — индекс очищается без HEAD', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, '.env'), `TOKEN=${FAKE_TELEGRAM}\n`)
    writeFileSync(join(dir, '.gitignore'), '')
    const result = await ensureRepo(dir, '/nonexistent-home')
    assert.ok(result.kind === 'created' && result.commit?.kind === 'secrets')
    assert.throws(() => git(dir, 'rev-parse', '--verify', '-q', 'HEAD'))
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll: слишком много новых файлов — не коммитит и ничего не добавляет в индекс', async () => {
  const dir = tempDir()
  try {
    writeFileSync(join(dir, 'a.txt'), 'a')
    await ensureRepo(dir, '/nonexistent-home')
    for (let i = 0; i < 4; i++) writeFileSync(join(dir, `f${i}.txt`), String(i))

    assert.deepEqual(await commitAll(dir, 'много', 3), { kind: 'too-many', count: 4 })
    assert.equal(git(dir, 'diff', '--cached', '--name-only'), '')
    assert.equal((await commitAll(dir, 'в пределах', 4)).kind, 'committed')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('commitAll: дифф больше 16 МБ не ломает проверку секретов', async () => {
  const dir = tempDir()
  try {
    // ~17 МБ текста в одном файле и ещё сотни файлов — вместе больше лимита вывода git().
    writeFileSync(join(dir, 'big.json'), 'x'.repeat(100).concat('\n').repeat(170_000))
    for (let i = 0; i < 300; i++) writeFileSync(join(dir, `m${i}.txt`), 'line\n'.repeat(2000))
    writeFileSync(join(dir, 'small.ts'), `const k = '${FAKE_ANTHROPIC}'\n`)
    writeFileSync(join(dir, '.gitignore'), '')

    const first = await ensureRepo(dir, '/nonexistent-home')
    assert.ok(first.kind === 'created')
    assert.deepEqual(first.commit, { kind: 'secrets', files: ['small.ts'] })

    writeFileSync(join(dir, 'small.ts'), 'const k = process.env.KEY\n')
    assert.equal((await commitAll(dir, 'без секрета')).kind, 'committed')
    assert.equal(git(dir, 'status', '--porcelain'), '')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
