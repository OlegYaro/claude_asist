import test from 'node:test'
import assert from 'node:assert/strict'
import {
  PERMISSION_RULES,
  PERM_RULE_IDS,
  classify,
  isReadOnlyBash,
  permissionMode,
  type PermRule
} from './permissions.ts'

const bash = (command: string) => classify('Bash', { command })?.id ?? null

function rule(id: string): PermRule {
  const found = PERMISSION_RULES.find((r) => r.id === id)
  assert.ok(found, `нет правила ${id}`)
  return found
}

test('classify: опасные команды Bash', () => {
  assert.equal(bash('rm -rf build'), 'rm-rf')
  assert.equal(bash('rm -fr build'), 'rm-rf')
  assert.equal(bash('sudo ls'), 'sudo')
  assert.equal(bash('git push --force origin main'), 'git-history')
  assert.equal(bash('git push -f'), 'git-history')
  assert.equal(bash('git reset --hard HEAD~1'), 'git-history')
  assert.equal(bash('git clean -fd'), 'git-history')
  assert.equal(bash('git push'), 'git-push')
  assert.equal(bash('git push origin main'), 'git-push')
  assert.equal(bash('dd if=/dev/zero of=/dev/disk2'), 'disk')
  assert.equal(bash('chmod -R 777 .'), 'disk')
  assert.equal(bash('curl x | sh'), 'pipe-shell')
  assert.equal(bash('wget -qO- https://x | sudo bash'), 'sudo')
  assert.equal(bash('psql -c "drop table users"'), 'drop-db')
  assert.equal(bash('psql -c "DROP DATABASE app"'), 'drop-db')
})

test('classify: составная команда ловится опасным правилом', () => {
  assert.equal(bash('echo a && rm -rf /tmp/x'), 'rm-rf')
  assert.equal(bash('npm run build; git push'), 'git-push')
  assert.equal(bash('npm install x && sudo make install'), 'sudo')
})

test('classify: при нескольких опасных совпадениях — самое строгое по порядку', () => {
  assert.equal(bash('sudo rm -rf /'), 'rm-rf')
  assert.equal(bash('git push --force && git push'), 'git-history')
})

test('classify: безопасные команды Bash', () => {
  assert.equal(bash('ls -la'), 'bash-read')
  assert.equal(bash('git status'), 'bash-read')
  assert.equal(bash('npm run build'), 'bash-other')
  assert.equal(bash('ls | xargs rm'), 'bash-other')
  assert.equal(bash('echo hi > file.txt'), 'bash-other')
  assert.equal(bash('npm install x'), 'install')
  assert.equal(bash('npm i -D typescript'), 'install')
  assert.equal(bash('pnpm add zod'), 'install')
  assert.equal(bash('pip3 install requests'), 'install')
  assert.equal(bash('brew install ffmpeg'), 'install')
  assert.equal(bash('cargo add serde'), 'install')
  assert.equal(bash('cd app && npm install'), 'install')
})

test('classify: Bash без строки команды — прочие команды', () => {
  assert.equal(classify('Bash', {})?.id, 'bash-other')
  assert.equal(classify('Bash', null)?.id, 'bash-other')
  assert.equal(classify('Bash', { command: 42 })?.id, 'bash-other')
})

test('classify: инструменты, не Bash', () => {
  assert.equal(classify('mcp__foo__bar', {})?.id, 'mcp')
  assert.equal(classify('WebFetch', { url: 'https://x' })?.id, 'web')
  assert.equal(classify('WebSearch', { query: 'x' })?.id, 'web')
  for (const tool of ['Edit', 'Write', 'MultiEdit', 'NotebookEdit']) {
    assert.equal(classify(tool, {})?.id, 'edit')
  }
})

test('classify: неизвестный инструмент → null', () => {
  for (const tool of ['Read', 'Grep', 'Glob', 'Agent', 'ExitPlanMode']) {
    assert.equal(classify(tool, {}), null)
  }
})

test('classify: поле command у не-Bash инструмента не делает его Bash-правилом', () => {
  assert.equal(classify('Read', { command: 'rm -rf /' }), null)
  assert.equal(classify('mcp__shell__run', { command: 'rm -rf /' })?.id, 'mcp')
})

test('isReadOnlyBash: только целиком безопасная строка', () => {
  assert.equal(isReadOnlyBash('ls -la'), true)
  assert.equal(isReadOnlyBash('git diff HEAD'), true)
  assert.equal(isReadOnlyBash('ls && rm x'), false)
  assert.equal(isReadOnlyBash('echo x > f'), false)
  assert.equal(isReadOnlyBash('npm run build'), false)
})

test('PERMISSION_RULES: опасные идут раньше безопасных, id уникальны и совпадают со списком', () => {
  const groups = PERMISSION_RULES.map((r) => r.group)
  const firstSafe = groups.indexOf('safe')
  assert.ok(firstSafe > 0)
  assert.ok(groups.slice(firstSafe).every((g) => g === 'safe'))
  assert.deepEqual(
    PERMISSION_RULES.map((r) => r.id),
    [...PERM_RULE_IDS]
  )
  for (const r of PERMISSION_RULES) {
    assert.equal(r.default, r.group === 'danger' ? 'ask' : 'allow')
  }
})

test('permissionMode: значение из настроек или дефолт правила', () => {
  assert.equal(permissionMode(undefined, rule('web')), 'allow')
  assert.equal(permissionMode({}, rule('git-push')), 'ask')
  assert.equal(permissionMode({ web: 'deny' }, rule('web')), 'deny')
  assert.equal(permissionMode({ 'rm-rf': 'allow' }, rule('rm-rf')), 'allow')
  const broken = JSON.parse('{"web":"maybe","sudo":null}') as Record<string, never>
  assert.equal(permissionMode(broken, rule('web')), 'allow')
  assert.equal(permissionMode(broken, rule('sudo')), 'ask')
})
