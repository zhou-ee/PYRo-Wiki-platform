import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const packageJson = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
const filename = `pyro-wiki-vscode-extension-${packageJson.version}.vsix`
const code = process.platform === 'win32' ? 'code' : 'code'
const result = spawnSync(code, ['--profile', 'PYRo-Wiki', '--install-extension', resolve(root, filename), '--force'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log(`Installed ${filename} into VS Code PYRo-Wiki profile.`)
