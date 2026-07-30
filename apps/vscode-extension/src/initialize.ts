import * as childProcess from 'node:child_process'
import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import * as vscode from 'vscode'
import { pullSharedRepository } from './repository'

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'
const VITEPRESS_VERSION = '^2.0.0-alpha.16'
let initializing = false

async function exists(filePath: string): Promise<boolean> {
  try { await fs.access(filePath); return true } catch { return false }
}

function currentWorkspaceRoot(): string | undefined {
  const document = vscode.window.activeTextEditor?.document
  return document ? vscode.workspace.getWorkspaceFolder(document.uri)?.uri.fsPath : vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
}

async function chooseWorkspaceRoot(): Promise<string | undefined> {
  const current = currentWorkspaceRoot()
  if (current) return current
  const selected = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, canSelectMany: false, openLabel: 'Use as shared PYRo Wiki workspace' })
  return selected?.[0]?.fsPath
}

function apiBaseUrl(): string {
  return vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL).replace(/\/$/, '')
}

function hasResolvableVitePress(root: string): boolean {
  try { require.resolve('vitepress', { paths: [root] }); return true } catch { return false }
}

function runNpmInstall(root: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const processHandle = childProcess.spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['install'], {
      cwd: root,
      windowsHide: true,
      shell: process.platform === 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let errorOutput = ''
    processHandle.stderr?.on('data', (chunk: Buffer | string) => { errorOutput += String(chunk) })
    processHandle.once('error', reject)
    processHandle.once('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`npm install exited with code ${code ?? 'unknown'}${errorOutput.trim() ? `: ${errorOutput.trim().slice(-500)}` : ''}`))
    })
  })
}

async function ensureVitePress(root: string): Promise<boolean> {
  if (hasResolvableVitePress(root)) return true
  const choice = await vscode.window.showInformationMessage(
    'The shared Wiki was pulled through the PYRo Worker, but VitePress is not resolvable from this workspace. Install project dependencies now?',
    { modal: true },
    'Run npm install',
    'Later'
  )
  if (choice !== 'Run npm install') return false
  try {
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Installing shared Wiki dependencies', cancellable: false }, async () => { await runNpmInstall(root) })
    if (!hasResolvableVitePress(root)) throw new Error(`VitePress ${VITEPRESS_VERSION} is still not resolvable after npm install.`)
    return true
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const action = await vscode.window.showErrorMessage(`Could not install shared Wiki dependencies: ${detail}`, 'Copy Command')
    if (action === 'Copy Command') await vscode.env.clipboard.writeText('npm install')
    return false
  }
}

async function syncSharedWiki(root: string, overwrite: boolean): Promise<Awaited<ReturnType<typeof pullSharedRepository>>> {
  return pullSharedRepository(root, apiBaseUrl(), overwrite)
}

export async function pullSharedWiki(overwrite = false): Promise<void> {
  const root = await chooseWorkspaceRoot()
  if (!root) return
  try {
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Syncing shared PYRo Wiki through Worker', cancellable: false }, async () => syncSharedWiki(root, overwrite))
    void vscode.window.showInformationMessage(`Shared Wiki sync completed ? updated: ${result.created + result.replaced}, kept: ${result.kept + result.skipped}, remote deleted: ${result.deleted}, conflicts: ${result.conflicts.length}.`)
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not sync shared Wiki through Worker: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function initializeWikiWorkspace(): Promise<void> {
  if (initializing) return
  initializing = true
  try {
    const root = await chooseWorkspaceRoot()
    if (!root) return
    const hasFiles = await Promise.all([exists(path.join(root, 'package.json')), exists(path.join(root, 'index.md')), exists(path.join(root, '.vitepress'))]).then((values) => values.some(Boolean))
    let overwrite = false
    if (hasFiles) {
      const choice = await vscode.window.showWarningMessage(
        'This workspace is not empty. Pull the shared PYRo Wiki through the Worker without replacing existing files, or replace existing files with the shared snapshot?',
        { modal: true },
        'Pull and replace',
        'Pull missing only',
        'Cancel'
      )
      if (choice === 'Cancel' || !choice) return
      overwrite = choice === 'Pull and replace'
    }
    const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Pulling shared PYRo Wiki through Worker', cancellable: false }, async () => syncSharedWiki(root, overwrite))
    const vitePressReady = await ensureVitePress(root)
    const indexUri = vscode.Uri.file(path.join(root, 'index.md'))
    const document = await vscode.workspace.openTextDocument(indexUri)
    await vscode.window.showTextDocument(document, { preview: false })
    const action = await vscode.window.showInformationMessage(
      `Shared Wiki initialized ? updated: ${result.created + result.replaced}, kept: ${result.kept + result.skipped}, remote deleted: ${result.deleted}, conflicts: ${result.conflicts.length}. ${vitePressReady ? 'VitePress is ready.' : 'Install dependencies before full preview.'}`,
      'Open Preview'
    )
    if (action === 'Open Preview' && vitePressReady) await vscode.commands.executeCommand('pyroWiki.openPreview')
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not initialize shared PYRo Wiki workspace: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    initializing = false
  }
}
