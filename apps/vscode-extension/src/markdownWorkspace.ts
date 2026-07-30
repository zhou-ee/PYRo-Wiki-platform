import * as vscode from 'vscode'
import * as path from 'node:path'
import { navigationSectionForPath } from './navigation'

export interface WikiTreeNode {
  kind: 'root' | 'directory' | 'file'
  name: string
  uri?: vscode.Uri
  relativePath: string
  children?: WikiTreeNode[]
}

const EXCLUDE = '**/{node_modules,.git,.vitepress,public,.github,.vscode,apps,infra,migrations,workers,dist,build,.wrangler}/**'
function wikiRootUri(): vscode.Uri | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]
  if (!folder) return undefined
  const configured = vscode.workspace.getConfiguration('pyroWiki', folder.uri).get<string>('wikiRoot', '').trim()
  if (!configured) return folder.uri
  return path.isAbsolute(configured) ? vscode.Uri.file(path.normalize(configured)) : vscode.Uri.joinPath(folder.uri, configured)
}

export class WikiDocumentsProvider implements vscode.TreeDataProvider<WikiTreeNode>, vscode.Disposable {
  private readonly changeEmitter = new vscode.EventEmitter<WikiTreeNode | undefined | null | void>()
  readonly onDidChangeTreeData = this.changeEmitter.event
  private readonly disposables: vscode.Disposable[] = []
  private root: WikiTreeNode = { kind: 'root', name: 'Markdown Documents', relativePath: '' }

  constructor() {
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.md')
    this.disposables.push(
      watcher,
      watcher.onDidCreate(() => this.refresh()),
      watcher.onDidDelete(() => this.refresh()),
      watcher.onDidChange(() => this.refresh())
    )
  }

  refresh(): void {
    this.changeEmitter.fire()
  }

  getTreeItem(node: WikiTreeNode): vscode.TreeItem {
    const item = new vscode.TreeItem(node.name, node.kind === 'file' ? vscode.TreeItemCollapsibleState.None : vscode.TreeItemCollapsibleState.Collapsed)
    if (node.kind === 'file' && node.uri) {
      item.resourceUri = node.uri
      item.command = { command: 'vscode.open', title: 'Open Markdown document', arguments: [node.uri, { preview: false, viewColumn: vscode.ViewColumn.One }] }
      item.contextValue = 'pyroWikiMarkdownFile'
      item.iconPath = new vscode.ThemeIcon('markdown')
      item.tooltip = node.relativePath
    } else if (node.kind === 'directory') {
      item.contextValue = 'pyroWikiMarkdownDirectory'
      item.iconPath = new vscode.ThemeIcon('folder')
      if (node.uri) item.tooltip = node.relativePath
    } else {
      item.iconPath = new vscode.ThemeIcon('book')
    }
    return item
  }

  async getChildren(node?: WikiTreeNode): Promise<WikiTreeNode[]> {
    if (!node) {
      this.root.children = await this.buildTree()
      return this.root.children
    }
    return node.children ?? []
  }

  private async buildTree(): Promise<WikiTreeNode[]> {
    const rootUri = wikiRootUri()
    if (!rootUri) return []
    const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), EXCLUDE)
    const root: WikiTreeNode = { kind: 'root', name: 'Markdown Documents', relativePath: '', children: [] }
    for (const uri of files.sort((a, b) => a.fsPath.localeCompare(b.fsPath))) {
      const relative = path.relative(rootUri.fsPath, uri.fsPath).replaceAll('\\', '/')
      if (!relative || relative.startsWith('..')) continue
      const parts = relative.split('/')
      let children = root.children!
      let currentPath = ''
      for (let index = 0; index < parts.length; index += 1) {
        const name = parts[index]
        const isFile = index === parts.length - 1
        currentPath = currentPath ? `${currentPath}/${name}` : name
        let child = children.find((candidate) => candidate.name === name)
        if (!child) {
          child = isFile
            ? { kind: 'file', name, relativePath: currentPath, uri }
            : { kind: 'directory', name, relativePath: currentPath, uri: vscode.Uri.joinPath(rootUri, ...currentPath.split('/')), children: [] }
          children.push(child)
        }
        if (!isFile) children = child.children!
      }
    }
    const sort = (nodes: WikiTreeNode[]) => {
      nodes.sort((a, b) => Number(b.kind === 'directory') - Number(a.kind === 'directory') || a.name.localeCompare(b.name))
      for (const node of nodes) if (node.children) sort(node.children)
    }
    sort(root.children!)
    return root.children!
  }

  dispose(): void {
    this.changeEmitter.dispose()
    for (const disposable of this.disposables) disposable.dispose()
  }
}

function safeMarkdownChildName(value: string): string | undefined {
  const trimmed = value.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || trimmed.includes('/') || trimmed.includes('\\')) return undefined
  const name = trimmed.toLowerCase().endsWith('.md') ? trimmed : `${trimmed}.md`
  return name.toLowerCase().endsWith('.md') ? name : undefined
}

function operationDirectory(node: WikiTreeNode | undefined): vscode.Uri | undefined {
  const root = wikiRootUri()
  if (!root) return undefined
  if (!node || node.kind === 'root' || node.kind === 'directory') return node?.uri ?? root
  return node.uri ? vscode.Uri.file(path.dirname(node.uri.fsPath)) : root
}

export async function createMarkdownDocument(node?: WikiTreeNode, synchronizeCreatedDocument?: (document: vscode.TextDocument, label: string) => Promise<boolean>): Promise<void> {
  const directory = operationDirectory(node)
  if (!directory) return void vscode.window.showWarningMessage('Open a workspace before creating a Markdown document.')
  const root = wikiRootUri()
  if (!root) return void vscode.window.showWarningMessage('Open a workspace before creating a Markdown document.')
  const relativeDirectory = path.relative(root.fsPath, directory.fsPath).replaceAll('\\', '/')
  if (!navigationSectionForPath(relativeDirectory)) return void vscode.window.showWarningMessage('This directory is not part of an existing VitePress sidebar section. The Markdown document was not created.')
  const input = await vscode.window.showInputBox({ prompt: 'New PYRo Wiki Markdown filename', placeHolder: 'NewDocument.md', ignoreFocusOut: true })
  if (input === undefined) return
  const name = safeMarkdownChildName(input)
  if (!name) return void vscode.window.showErrorMessage('Use a single Markdown filename without path separators.')
  const sidebarLabel = await vscode.window.showInputBox({
    prompt: 'Navigation label for this document',
    placeHolder: 'Shown in the VitePress sidebar',
    ignoreFocusOut: true,
    validateInput: (value) => value.trim() ? undefined : 'A navigation label is required.'
  })
  if (sidebarLabel === undefined) return
  if (!sidebarLabel.trim()) return void vscode.window.showErrorMessage('A navigation label is required.')
  const uri = vscode.Uri.joinPath(directory, name)
  try {
    await vscode.workspace.fs.stat(uri)
    return void vscode.window.showErrorMessage(`Markdown document already exists: ${name}`)
  } catch (error) {
    const code = (error as { code?: string }).code
    if (code && code !== 'FileNotFound') return void vscode.window.showErrorMessage(`Could not inspect the target Markdown document: ${String(error)}`)
  }
  try {
    await vscode.workspace.fs.writeFile(uri, new Uint8Array())
    const document = await vscode.workspace.openTextDocument(uri)
    await vscode.window.showTextDocument(document, { preview: false, viewColumn: vscode.ViewColumn.One })
    if (synchronizeCreatedDocument && !(await synchronizeCreatedDocument(document, sidebarLabel.trim()))) void vscode.window.showWarningMessage('The Markdown file was created locally, but has not reached the cloud workspace yet. Keep the workspace connected and retry the publish batch command.')
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not create Markdown document: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function deleteMarkdownDocument(node?: WikiTreeNode, synchronizeDeletedDocument?: (uri: vscode.Uri) => Promise<boolean>): Promise<void> {
  if (!node?.uri || node.kind !== 'file') return void vscode.window.showWarningMessage('Select a Markdown document to delete.')
  const confirmation = await vscode.window.showWarningMessage(`Delete Markdown document ${node.relativePath}?`, { modal: true }, 'Delete Markdown')
  if (confirmation !== 'Delete Markdown') return
  try {
    await vscode.workspace.fs.delete(node.uri, { useTrash: true })
    if (synchronizeDeletedDocument && !(await synchronizeDeletedDocument(node.uri))) void vscode.window.showWarningMessage('The Markdown file was deleted locally, but the deletion has not reached the cloud workspace yet. Keep the workspace connected and retry the publish batch command.')
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not delete Markdown document: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function renameMarkdownDocument(node?: WikiTreeNode): Promise<void> {
  if (!node?.uri || node.kind !== 'file') return void vscode.window.showWarningMessage('Select a Markdown document to rename.')
  const input = await vscode.window.showInputBox({ prompt: 'Rename Markdown document', value: node.name, ignoreFocusOut: true })
  if (input === undefined) return
  const name = safeMarkdownChildName(input)
  if (!name) return void vscode.window.showErrorMessage('Use a single Markdown filename without path separators.')
  if (name === node.name) return
  const target = vscode.Uri.joinPath(vscode.Uri.file(path.dirname(node.uri.fsPath)), name)
  try {
    await vscode.workspace.fs.rename(node.uri, target, { overwrite: false })
  } catch (error) {
    void vscode.window.showErrorMessage(`Could not rename Markdown document: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function searchMarkdownDocuments(): Promise<void> {
  const rootUri = wikiRootUri()
  if (!rootUri) return void vscode.window.showWarningMessage('Open a workspace before searching Wiki documents.')
  const query = await vscode.window.showInputBox({ prompt: 'Search PYRo Wiki Markdown documents', placeHolder: 'title, keyword, or path' })
  if (!query) return
  const files = await vscode.workspace.findFiles(new vscode.RelativePattern(rootUri, '**/*.md'), EXCLUDE)
  const matches: Array<{ uri: vscode.Uri; line: number; text: string }> = []
  for (const uri of files) {
    const document = await vscode.workspace.openTextDocument(uri)
    for (let line = 0; line < document.lineCount; line += 1) {
      const text = document.lineAt(line).text
      if (text.toLocaleLowerCase().includes(query.toLocaleLowerCase())) matches.push({ uri, line, text: text.trim() })
      if (matches.length >= 200) break
    }
    if (matches.length >= 200) break
  }
  const picked = await vscode.window.showQuickPick(matches.map((match) => ({
    label: `${path.relative(rootUri.fsPath, match.uri.fsPath).replaceAll('\\', '/')}:${match.line + 1}`,
    description: match.text,
    match
  })), { placeHolder: matches.length ? `${matches.length} Markdown matches` : 'No Markdown matches found' })
  if (picked) {
    const editor = await vscode.window.showTextDocument(picked.match.uri, { viewColumn: vscode.ViewColumn.One, preview: false })
    editor.revealRange(new vscode.Range(picked.match.line, 0, picked.match.line, 0), vscode.TextEditorRevealType.InCenter)
  }
}
