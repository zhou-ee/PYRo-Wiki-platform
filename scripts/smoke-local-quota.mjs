import { spawnSync } from 'node:child_process'
const result = spawnSync('npm', ['--prefix', 'workers/api', 'run', 'test', '--', 'test/quota.test.ts'], { cwd: new URL('..', import.meta.url), stdio: 'inherit', shell: process.platform === 'win32' })
if (result.status !== 0) process.exit(result.status ?? 1)
console.log('PYRo Wiki smoke-local-quota passed')
