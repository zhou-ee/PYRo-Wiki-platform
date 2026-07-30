import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import * as http from 'node:http'
import WebSocket from 'ws'
import { VitePressPreviewServer } from '../src/preview/vitepress'

function docsRoot(): string {
  const candidates = [
    process.env.PYRO_WIKI_DOCS_ROOT,
    resolve(__dirname, '../../../'),
    resolve(__dirname, '../../../../PYRo-Wiki')
  ].filter((candidate): candidate is string => Boolean(candidate))
  for (const candidate of candidates) {
    if (existsSync(resolve(candidate, '.vitepress')) && existsSync(resolve(candidate, 'package.json'))) return candidate
  }
  throw new Error('Could not locate the PYRo Wiki documentation workspace.')
}

function get(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolvePromise, reject) => {
    http.get(url, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => resolvePromise({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
    }).on('error', reject)
  })
}

describe('full VitePress preview server', () => {
  it('serves the real VitePress app and injects the scroll bridge', async () => {
    const root = docsRoot()
    const server = new VitePressPreviewServer()
    try {
      await server.start(root)
      const document = { uri: { fsPath: resolve(root, 'about_us/administrator_list.md') } } as any
      const url = server.urlFor(document)
      const expectedBase = root.endsWith('Test-wiki') ? '/' : '/PYRo-Wiki/'
      expect(new URL(url).pathname).toBe(`${expectedBase}about_us/administrator_list`)
      const indexDocument = { uri: { fsPath: resolve(root, 'index.md') } } as any
      expect(new URL(server.urlFor(indexDocument)).pathname).toBe(expectedBase)
      const response = await get(url)
      expect(response.status).toBe(200)
      expect(response.body).toContain('parentWindow.postMessage')
      expect(response.body).toContain('window.scrollTo')
      expect(response.body).toContain('activeHeading')
      expect(response.body).toContain('atBottom')
      expect(response.body).toContain('pageKey')
      expect(response.body).toContain('previewNavigate')
      expect(response.body).toContain('popstate')
      expect(response.body).toContain('/@vite/client')
      expect(response.body).not.toContain('Unsupported component')
      const shell = server.document(url, 'vscode-webview://test', 'file:///wiki/index.md')
      expect(shell).toContain('vitepress-frame')
      expect(shell).toContain('pendingSourceScroll')
      expect(shell).toContain('file:///wiki/index.md')
      const loading = server.loadingDocument('vscode-webview://test')
      expect(loading).toContain('Starting PYRo Wiki preview')
      expect(loading).toContain('Content-Security-Policy')
      const route = new URL(url)
      const socket = new WebSocket(`ws://${route.host}/`)
      await new Promise<void>((resolvePromise, reject) => {
        const timer = setTimeout(() => { socket.terminate(); reject(new Error('VitePress HMR WebSocket did not connect')) }, 5_000)
        socket.once('open', () => { clearTimeout(timer); resolvePromise() })
        socket.once('error', (error) => { clearTimeout(timer); reject(error) })
      })
      socket.terminate()
    } finally {
      await server.disposeAsync()
    }
  }, 45_000)
})
