/**
 * node-pty 1.1 публикует prebuilds/<платформа>/spawn-helper без бита исполнения.
 * Без него любой pty.spawn падает с «posix_spawnp failed» — Claude Code просто
 * не запускается. Чиним права и в node_modules (postinstall), и в собранном
 * приложении (afterPack electron-builder).
 */
'use strict'

const { chmodSync, existsSync, readdirSync, statSync } = require('node:fs')
const { join } = require('node:path')

function fixUnder(root) {
  if (!existsSync(root)) return 0
  let fixed = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) walk(p)
      else if (entry.name === 'spawn-helper' && (statSync(p).mode & 0o111) === 0) {
        chmodSync(p, 0o755)
        fixed++
      }
    }
  }
  walk(root)
  return fixed
}

/** Хук afterPack для electron-builder. */
exports.default = async function afterPack(context) {
  const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`)
  fixUnder(join(app, 'Contents', 'Resources', 'app.asar.unpacked', 'node_modules', 'node-pty'))
}

if (require.main === module) {
  fixUnder(join(__dirname, '..', 'node_modules', 'node-pty'))
}
