import * as vscode from 'vscode'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { pullSharedWiki } from './initialize'

const execFileAsync = promisify(execFile)

async function gitRoot(folder: vscode.WorkspaceFolder): Promise<string> {
  try {
    const result = await execFileAsync('git', ['rev-parse', '--show-toplevel'], { cwd: folder.uri.fsPath, windowsHide: true, maxBuffer: 1024 * 1024 })
    return result.stdout.trim() || folder.uri.fsPath
  } catch {
    return folder.uri.fsPath
  }
}

export async function pullRepository(): Promise<void> {
  await pullSharedWiki(false)
}

export async function showRepositoryStatus(): Promise<void> {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return void vscode.window.showWarningMessage('Open the shared Wiki workspace first.')
  const cwd = await gitRoot(folder)
  try {
    const result = await execFileAsync('git', ['status', '--short', '--branch'], { cwd, windowsHide: true, maxBuffer: 1024 * 1024 })
    const status = result.stdout.trim() || 'Working tree clean.'
    const channel = vscode.window.createOutputChannel('PYRo Wiki Git')
    channel.clear()
    channel.appendLine(status)
    channel.appendLine('Repository pull is proxied through the configured PYRo Worker.')
    channel.show(true)
  } catch (cause) {
    void vscode.window.showErrorMessage(`Unable to read repository status: ${String(cause)}`)
  }
}

export function createRepositoryStatusItem(context: vscode.ExtensionContext): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100)
  item.text = '$(sync) PYRo Sync'
  item.tooltip = 'PYRo Wiki: Sync shared repository through Worker'
  item.command = 'pyroWiki.pullRepository'
  item.show()
  context.subscriptions.push(item)
  return item
}
