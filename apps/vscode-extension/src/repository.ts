import * as crypto from 'node:crypto'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { gunzipSync } from 'node:zlib'

const MAX_ARCHIVE_BYTES = 200 * 1024 * 1024
const MAX_NETWORK_ATTEMPTS = 3
const STATE_DIRECTORY = '.pyro-wiki'
const STATE_FILE = 'repository-state.json'

export interface RepositoryMetadata {
  repositoryUrl: string
  branch: string
  commitSha: string
  commitUrl?: string
  updatedAt?: string
}

export interface SharedRepositoryState {
  repositoryUrl: string
  branch: string
  remoteCommitSha: string
  files: Record<string, string>
}

export interface SharedRepositoryPullResult {
  created: number
  replaced: number
  kept: number
  skipped: number
  deleted: number
  conflicts: string[]
  unchanged: boolean
  remoteCommitSha: string
  files: string[]
}

function sleep(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)) }
function hash(content: Uint8Array): string { return crypto.createHash('sha256').update(content).digest('hex') }

/**
 * Older workspace bootstrap/publish clients could concatenate the exact same
 * archive entry more than once. Collapse only byte-for-byte repeated payloads;
 * arbitrary Markdown edits are never merged or rewritten here.
 */
export function collapseRepeatedContent(content: Uint8Array): Uint8Array {
  let current = content
  for (let pass = 0; pass < 8 && current.byteLength; pass += 1) {
    let collapsed: Uint8Array | undefined
    for (let repeat = 2; repeat <= 8; repeat += 1) {
      if (current.byteLength % repeat !== 0) continue
      const chunkSize = current.byteLength / repeat
      const first = current.subarray(0, chunkSize)
      let repeated = true
      for (let index = 1; index < repeat && repeated; index += 1) {
        const chunk = current.subarray(index * chunkSize, (index + 1) * chunkSize)
        for (let byte = 0; byte < chunkSize; byte += 1) if (chunk[byte] !== first[byte]) { repeated = false; break }
      }
      if (repeated) { collapsed = first.slice(); break }
    }
    if (!collapsed) return current
    current = collapsed
  }
  return current
}

function safeRelativePath(value: string): string | undefined {
  const normalized = value.replaceAll('\\', '/').replace(/^\/+/, '').replace(/\/+/g, '/')
  if (!normalized || normalized.startsWith('../') || normalized.includes('/../') || normalized === '..') return undefined
  if (path.posix.isAbsolute(normalized)) return undefined
  const withoutArchiveRoot = normalized.split('/').slice(1).join('/')
  if (!withoutArchiveRoot || withoutArchiveRoot === '.git' || withoutArchiveRoot.startsWith('.git/')) return undefined
  return withoutArchiveRoot
}

function readTarString(buffer: Uint8Array, start: number, length: number): string {
  const bytes = buffer.subarray(start, start + length)
  const zero = bytes.indexOf(0)
  return new TextDecoder().decode(zero >= 0 ? bytes.subarray(0, zero) : bytes).trim()
}

function readTarSize(buffer: Uint8Array): number {
  const raw = readTarString(buffer, 124, 12).replace(/\0/g, '').trim()
  return raw ? Number.parseInt(raw, 8) : 0
}

function parseTarArchive(compressed: Uint8Array): Map<string, Uint8Array> {
  if (compressed.byteLength > MAX_ARCHIVE_BYTES) throw new Error('Shared Wiki archive exceeds the 200 MB limit.')
  const buffer = gunzipSync(compressed)
  const files = new Map<string, Uint8Array>()
  let offset = 0
  while (offset + 512 <= buffer.byteLength) {
    const header = buffer.subarray(offset, offset + 512)
    if (header.every((byte) => byte === 0)) break
    const name = readTarString(header, 0, 100)
    const prefix = readTarString(header, 345, 155)
    const archivePath = prefix ? `${prefix}/${name}` : name
    const size = readTarSize(header)
    const type = header[156]
    const dataStart = offset + 512
    const dataEnd = dataStart + size
    if (dataEnd > buffer.byteLength) throw new Error('Shared Wiki archive is truncated.')
    if (type === 0 || type === 48) {
      const relativePath = safeRelativePath(archivePath)
      if (relativePath) files.set(relativePath, buffer.slice(dataStart, dataEnd))
    }
    offset = dataStart + Math.ceil(size / 512) * 512
  }
  return files
}

async function requestJson<T>(apiBaseUrl: string, endpoint: string): Promise<T> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}${endpoint}`, { headers: { accept: 'application/json' }, signal: controller.signal })
      const body = await response.json().catch(() => ({})) as T & { error?: string }
      if (!response.ok) throw new Error(body.error || `Worker repository metadata returned HTTP ${response.status}`)
      return body
    } catch (error) {
      lastError = error
      if (attempt < MAX_NETWORK_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Shared Wiki metadata request failed.')
}

async function downloadArchive(apiBaseUrl: string): Promise<Uint8Array> {
  let lastError: unknown
  for (let attempt = 1; attempt <= MAX_NETWORK_ATTEMPTS; attempt += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 60_000)
    try {
      const response = await fetch(`${apiBaseUrl.replace(/\/$/, '')}/repository/archive`, { headers: { accept: 'application/gzip' }, signal: controller.signal })
      if (!response.ok) {
        const body = await response.text().catch(() => '')
        throw new Error(body || `Worker repository proxy returned HTTP ${response.status}`)
      }
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (!bytes.byteLength) throw new Error('Worker returned an empty shared Wiki archive.')
      return bytes
    } catch (error) {
      lastError = error
      if (attempt < MAX_NETWORK_ATTEMPTS) await sleep(400 * 2 ** (attempt - 1))
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('Shared Wiki download failed.')
}

async function readState(root: string): Promise<SharedRepositoryState | undefined> {
  try {
    const value = JSON.parse(await fs.readFile(path.join(root, STATE_DIRECTORY, STATE_FILE), 'utf8')) as SharedRepositoryState
    if (!value || typeof value.remoteCommitSha !== 'string' || !value.files || typeof value.files !== 'object') return undefined
    return value
  } catch {
    return undefined
  }
}

async function writeState(root: string, state: SharedRepositoryState): Promise<void> {
  const directory = path.join(root, STATE_DIRECTORY)
  await fs.mkdir(directory, { recursive: true })
  const temporary = path.join(directory, `${STATE_FILE}.tmp`)
  await fs.writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
  await fs.rename(temporary, path.join(directory, STATE_FILE))
  const exclude = path.join(root, '.git', 'info', 'exclude')
  try {
    const existing = await fs.readFile(exclude, 'utf8')
    if (!existing.split(/\r?\n/).includes(`${STATE_DIRECTORY}/`)) await fs.appendFile(exclude, `${existing.endsWith('\n') ? '' : '\n'}${STATE_DIRECTORY}/\n`)
  } catch { /* no local Git metadata */ }
}

async function readLocalHash(target: string): Promise<{ exists: boolean; hash?: string }> {
  try { return { exists: true, hash: hash(await fs.readFile(target)) } } catch { return { exists: false } }
}

async function writeLocal(root: string, relativePath: string, content: Uint8Array): Promise<void> {
  const target = path.resolve(root, relativePath)
  const relativeTarget = path.relative(root, target)
  if (relativeTarget.startsWith('..') || path.isAbsolute(relativeTarget)) throw new Error(`Unsafe shared Wiki path: ${relativePath}`)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

export async function getRepositoryMetadata(apiBaseUrl: string): Promise<RepositoryMetadata> {
  return requestJson<RepositoryMetadata>(apiBaseUrl, '/repository/metadata')
}

export async function pullSharedRepository(root: string, apiBaseUrl: string, overwrite = false): Promise<SharedRepositoryPullResult> {
  const metadata = await getRepositoryMetadata(apiBaseUrl)
  const previous = await readState(root)
  if (previous && previous.remoteCommitSha === metadata.commitSha && !overwrite) {
    return { created: 0, replaced: 0, kept: 0, skipped: 0, deleted: 0, conflicts: [], unchanged: true, remoteCommitSha: metadata.commitSha, files: [] }
  }
  const archive = parseTarArchive(await downloadArchive(apiBaseUrl))
  if (!archive.size) throw new Error('Shared Wiki archive contained no usable files.')
  const previousFiles = previous?.files ?? {}
  const nextFiles: Record<string, string> = { ...previousFiles }
  const conflicts: string[] = []
  const files: string[] = []
  let created = 0
  let replaced = 0
  let kept = 0
  let skipped = 0
  let deleted = 0

  for (const [relativePath, rawContent] of archive) {
    const content = collapseRepeatedContent(rawContent)
    const remoteHash = hash(content)
    const target = path.resolve(root, relativePath)
    const local = await readLocalHash(target)
    const previousHash = previousFiles[relativePath]
    if (overwrite) {
      await writeLocal(root, relativePath, content)
      if (local.exists) replaced += 1
      else created += 1
      nextFiles[relativePath] = remoteHash
      files.push(relativePath)
      continue
    }
    if (!local.exists) {
      await writeLocal(root, relativePath, content)
      created += 1
      nextFiles[relativePath] = remoteHash
      files.push(relativePath)
      continue
    }
    if (!previousHash) {
      conflicts.push(`${relativePath} (local file has no sync baseline)`)
      skipped += 1
      continue
    }
    if (local.hash === previousHash && remoteHash !== previousHash) {
      await writeLocal(root, relativePath, content)
      replaced += 1
      nextFiles[relativePath] = remoteHash
      files.push(relativePath)
    } else if (local.hash === previousHash && remoteHash === previousHash) {
      skipped += 1
    } else if (remoteHash === previousHash) {
      kept += 1
    } else {
      conflicts.push(relativePath)
      skipped += 1
    }
  }

  for (const [relativePath, previousHash] of Object.entries(previousFiles)) {
    if (archive.has(relativePath)) continue
    const local = await readLocalHash(path.resolve(root, relativePath))
    if (!local.exists) {
      delete nextFiles[relativePath]
      continue
    }
    if (overwrite || local.hash === previousHash) {
      await fs.rm(path.resolve(root, relativePath), { force: true })
      delete nextFiles[relativePath]
      deleted += 1
      files.push(relativePath)
    } else {
      conflicts.push(`${relativePath} (remote deleted, local changed)`)
      skipped += 1
    }
  }

  const fullyApplied = conflicts.length === 0
  await writeState(root, {
    repositoryUrl: metadata.repositoryUrl,
    branch: metadata.branch,
    remoteCommitSha: fullyApplied ? metadata.commitSha : (previous?.remoteCommitSha ?? ''),
    files: nextFiles
  })
  return { created, replaced, kept, skipped, deleted, conflicts, unchanged: false, remoteCommitSha: metadata.commitSha, files }
}

export { parseTarArchive, safeRelativePath }
