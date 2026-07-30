import { spawnSync } from 'node:child_process'
import { resolve } from 'node:path'

const root = resolve(process.cwd())
const wrangler = resolve(root, 'workers/api/node_modules/wrangler/bin/wrangler.js')
const config = 'infra/cloudflare/wrangler.api.prod.jsonc'
const database = 'pyro-wiki-prod'
const expectedTables = ['auth_handoff_codes', 'auth_sessions', 'authors', 'documents', 'oauth_states', 'publish_requests', 'revisions', 'users', 'workspaces', 'document_drafts', 'workspace_draft_manifest', 'workspace_snapshots', 'workspace_snapshot_items', 'publish_batches', 'publish_batch_items']
const sql = `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${expectedTables.map((name) => `'${name}'`).join(', ')}) ORDER BY name;`

function fail(message) { throw new Error(message) }

const result = spawnSync(process.execPath, [wrangler, 'd1', 'execute', database, '--remote', '--config', config, '--command', sql, '--json'], { cwd: root, encoding: 'utf8' })
if (result.status !== 0) fail(`production D1 schema query failed\n${result.stdout ?? ''}\n${result.stderr ?? ''}`)
let payload
try { payload = JSON.parse(result.stdout) } catch { fail('production D1 schema query returned invalid JSON') }
const names = new Set((payload[0]?.results ?? []).map((row) => row.name))
const missing = expectedTables.filter((table) => !names.has(table))
if (missing.length) fail(`production D1 is missing tables: ${missing.join(', ')}`)
console.log(`PYRo Wiki production D1 schema passed: ${expectedTables.length} required tables present`)
