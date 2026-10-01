import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotTree, staleCheckpoints } from './quality.ts'

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
