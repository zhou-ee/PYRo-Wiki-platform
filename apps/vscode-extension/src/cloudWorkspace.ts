import * as vscode from 'vscode'
import * as path from 'node:path'
import { ApiClient, ApiError, type RemoteDocument, type RemoteRevision } from './sync/api'
import { AuthManager } from './auth/session'
import { workspaceRoot } from './workspace'
import { cloudSyncStatus, filterCloudDocuments, type CloudSyncStatus } from './cloudWorkspaceLogic'
import { suppressNextDraftSave } from './sync/autoSave'

const DEFAULT_API_BASE_URL = 'https://pyro-wiki-api.luckyy.ccwu.cc'

export type CloudNode =
  | { kind: 'document'; document: RemoteDocument; syncStatus: CloudSyncStatus }
  | { kind: 'signIn' }
  | { kind: 'empty' }
  | { kind: 'loading' }

export type { CloudSyncStatus } from './cloudWorkspaceLogic'

export function workspaceIdForRoot(root: string): string {
  return path.basename(root).replace(/[^A-Za-z0-9_-]/g, '-').toLowerCase() || 'default'
}

const cloudContent = new Map<string, string>()
const cloudContentProvider: vscode.TextDocumentContentProvider = {
  provideTextDocumentContent(uri): string {
    return cloudContent.get(uri.toString()) ?? ''
  }
}

function cloudSnapshotUri(documentPath: string, revision: number, content: string): vscode.Uri {
  const uri = vscode.Uri.parse(`pyro-cloud:/${encodeURIComponent(documentPath)}?revision=${revision}`)
  cloudContent.set(uri.toString(), content)
  while (cloudContent.size > 64) cloudContent.delete(cloudContent.keys().next().value as string)
  return uri
}

export class CloudDocumentsProvider implements vscode.TreeDataProvider<CloudNode>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<CloudNode | undefined | null | void>()
  private readonly disposables: vscode.Disposable[] = [this.emitter]
  private documents: RemoteDocument[] = []
  private syncStatuses = new Map<string, CloudSyncStatus>()
  private searchQuery = ''
  private loading = false
  private loaded = false
  private loadedAt = 0
  private loadPromise: Promise<void> | undefined
  private readonly cacheTtlMs = 45_000

  readonly onDidChangeTreeData = this.emitter.event

  constructor(private readonly context: vscode.ExtensionContext, private readonly auth: AuthManager) {
    this.disposables.push(
      vscode.workspace.registerTextDocumentContentProvider('pyro-cloud', cloudContentProvider),
      auth.onDidChange((user) => {
        if (!user) { this.documents = []; this.syncStatuses.clear(); this.loaded = false; this.loadedAt = 0 }
        else { this.loaded = false; this.loadedAt = 0 }
        this.refresh()
      })
    )
  }

  getTreeItem(node: CloudNode): vscode.TreeItem {
    if (node.kind === 'signIn') {
      const item = new vscode.TreeItem('Sign in with Feishu', vscode.TreeItemCollapsibleState.None)
      item.command = { command: 'pyroWiki.signIn', title: 'Sign in with Feishu' }
      item.iconPath = new vscode.ThemeIcon('account')
      return item
    }
    if (node.kind === 'empty') {
      const label = this.searchQuery ? `No documents match '${this.searchQuery}'` : this.loaded ? 'No remote documents' : 'Open Cloud Documents to load'
      const item = new vscode.TreeItem(label, vscode.TreeItemCollapsibleState.None)
      item.iconPath = new vscode.ThemeIcon('info')
      return item
    }
    if (node.kind === 'loading') {
      const item = new vscode.TreeItem('Loading Cloud Documents?', vscode.TreeItemCollapsibleState.None)
      item.iconPath = new vscode.ThemeIcon('sync~spin')
      return item
    }
    const item = new vscode.TreeItem(node.document.path, vscode.TreeItemCollapsibleState.None)
    item.description = `r${node.document.revision} - ${this.syncLabel(node.syncStatus)}`
    item.tooltip = `${node.document.title}\nUpdated: ${node.document.updatedAt}\nSync: ${this.syncLabel(node.syncStatus)}`
    item.contextValue = 'pyroWiki.cloudDocument'
    item.iconPath = new vscode.ThemeIcon(this.syncIcon(node.syncStatus))
    item.command = { command: 'pyroWiki.openCloudDocument', title: 'Open Cloud Document', arguments: [node.document] }
    return item
  }

  async getChildren(): Promise<CloudNode[]> {
    if (!this.auth.signedIn) return [{ kind: 'signIn' }]
    if (this.loading) return [{ kind: 'loading' }]
    const documents = filterCloudDocuments(this.documents, this.searchQuery)
    return documents.length ? documents.map((document) => ({ kind: 'document', document, syncStatus: this.syncStatuses.get(document.path) ?? 'not-pulled' })) : [{ kind: 'empty' }]
  }

  async search(): Promise<void> {
    if (!this.auth.signedIn) return void vscode.window.showWarningMessage('Sign in with Feishu before searching cloud documents.')
    const query = await vscode.window.showInputBox({ value: this.searchQuery, prompt: 'Filter cloud documents by path or title', placeHolder: 'e.g. Course/embedded' })
    if (query === undefined) return
    this.searchQuery = query.trim()
    this.refresh()
  }

  async load(force = false): Promise<void> {
    if (!this.auth.signedIn) return
    if (this.loadPromise) return this.loadPromise
    if (!force && this.loaded && Date.now() - this.loadedAt < this.cacheTtlMs) return
    const root = workspaceRoot(vscode.window.activeTextEditor?.document ?? vscode.window.visibleTextEditors[0]?.document) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) { this.documents = []; this.loaded = true; this.loadedAt = Date.now(); this.refresh(); return }
    this.loading = true
    this.loadPromise = (async () => {
      try {
        const client = this.client(root)
        const documents = (await client.listDocuments()).documents
        const syncStatuses = new Map(await Promise.all(documents.map(async (document) => [document.path, await this.syncStatus(root, document)] as const)))
        this.documents = documents
        this.syncStatuses = syncStatuses
        this.loaded = true
        this.loadedAt = Date.now()
        this.refresh()
      } catch (error) {
        this.loaded = false
        this.loadedAt = 0
        void vscode.window.showErrorMessage(`Could not load PYRo Wiki cloud documents: ${error instanceof Error ? error.message : String(error)}`)
        this.refresh()
      } finally {
        this.loading = false
        this.loadPromise = undefined
      }
    })()
    return this.loadPromise
  }


  async showRevisions(document: RemoteDocument): Promise<void> {
    const root = workspaceRoot(vscode.window.activeTextEditor?.document ?? vscode.window.visibleTextEditors[0]?.document) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before viewing cloud revisions.')
    try {
      const revisions = (await this.client(root).revisions(document.path)).revisions
      if (!revisions.length) return void vscode.window.showInformationMessage('This cloud document has no revisions yet.')
      const picked = await vscode.window.showQuickPick(revisions.map((revision) => ({
        label: `Revision ${revision.revision}`,
        description: `${revision.kind ?? 'published'} - ${revision.updatedAt}${revision.message ? ` - ${revision.message}` : ''}`,
        revision
      })), { placeHolder: `Select a revision of ${document.path}` })
      if (!picked) return
      const action = await vscode.window.showQuickPick([
        { label: 'Compare with current document', value: 'compare' },
        { label: 'Restore this revision to the cloud', value: 'restore' },
        { label: 'Cancel', value: 'cancel' }
      ], { placeHolder: `Action for revision ${picked.revision.revision}` })
      if (!action || action.value === 'cancel') return
      if (action.value === 'restore') {
        const current = await this.client(root).getDocument(document.path)
        const confirmation = await vscode.window.showWarningMessage(`Restore cloud revision ${picked.revision.revision} as a new revision?`, { modal: true }, 'Restore')
        if (confirmation !== 'Restore') return
        const restored = await this.client(root).restoreRevision(document.path, picked.revision.revision, current.revision)
        const localUri = this.localUri(root, document.path)
        await this.context.workspaceState.update(this.revisionKey(localUri), restored.revision)
        void vscode.window.showInformationMessage(`Restored revision ${picked.revision.revision} as cloud revision ${restored.revision}.`)
        await this.load(true)
        return
      }
      const localUri = this.localUri(root, document.path)
      let local: vscode.TextDocument | undefined
      try { local = await vscode.workspace.openTextDocument(localUri) } catch { /* compare revision in read-only cloud view below */ }
      const revisionDocument = await vscode.workspace.openTextDocument(cloudSnapshotUri(document.path, picked.revision.revision, picked.revision.content))
      if (local) await vscode.commands.executeCommand('vscode.diff', local.uri, revisionDocument.uri, `PYRo: ${document.path} revision ${picked.revision.revision}`)
      else await vscode.window.showTextDocument(revisionDocument, { preview: false })
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not load cloud revisions: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async compareWithLocal(document: RemoteDocument): Promise<void> {
    const root = this.currentRoot()
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before comparing a cloud document.')
    try {
      const localUri = this.localUri(root, document.path)
      const local = await vscode.workspace.openTextDocument(localUri)
      const remote = await this.client(root).getDocument(document.path)
      const remoteDoc = await vscode.workspace.openTextDocument(cloudSnapshotUri(document.path, remote.revision, remote.content ?? ''))
      await vscode.commands.executeCommand('vscode.diff', local.uri, remoteDoc.uri, `PYRo: ${document.path} local ? cloud r${remote.revision}`)
    } catch (error) {
      if ((error as { code?: string }).code === 'FileNotFound') void vscode.window.showWarningMessage(`No local copy exists for ${document.path}. Use Open or Pull first.`)
      else void vscode.window.showErrorMessage(`Could not compare cloud document: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async openDocument(document: RemoteDocument): Promise<void> {
    const root = this.currentRoot()
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before opening a cloud document.')
    try {
      const localUri = this.localUri(root, document.path)
      try {
        const local = await vscode.workspace.openTextDocument(localUri)
        await vscode.window.showTextDocument(local, { preview: false })
        return
      } catch { /* create a local copy below */ }
      const remote = await this.client(root).getDocument(document.path)
      await this.writeLocal(localUri, remote.content ?? '')
      await this.context.workspaceState.update(this.revisionKey(localUri), remote.revision)
      const local = await vscode.workspace.openTextDocument(localUri)
      await vscode.window.showTextDocument(local, { preview: false })
      await this.load(true)
    } catch (error) {
      void vscode.window.showErrorMessage(`Could not open cloud document: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  async pullDocument(document: RemoteDocument): Promise<void> {
    const root = this.currentRoot()
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before pulling a cloud document.')
    try {
      const remote = await this.client(root).getDocument(document.path)
      const localUri = this.localUri(root, document.path)
      let local: vscode.TextDocument | undefined
      try { local = await vscode.workspace.openTextDocument(localUri) } catch { /* create below */ }
      if (local?.isDirty) {
        const choice = await vscode.window.showWarningMessage(`${document.path} has unsaved local changes. Replace them with revision ${remote.revision}?`, 'Replace', 'Cancel')
        if (choice !== 'Replace') return
      }
      if (local) {
        await this.replaceDocument(local, remote.content ?? '')
        suppressNextDraftSave(local)
        await local.save()
      } else {
        await this.writeLocal(localUri, remote.content ?? '')
      }
      await this.context.workspaceState.update(this.revisionKey(localUri), remote.revision)
      const opened = local ?? await vscode.workspace.openTextDocument(localUri)
      if (opened.isDirty) {
        suppressNextDraftSave(opened)
        await opened.save()
      }
      await vscode.window.showTextDocument(opened, { preview: false })
      void vscode.window.showInformationMessage(`Pulled ${document.path} revision ${remote.revision}.`)
      await this.load(true)
    } catch (error) {
      this.showApiError('Could not pull cloud document', error)
    }
  }

  async pushDocument(document: RemoteDocument): Promise<void> {
    const root = this.currentRoot()
    if (!root) return void vscode.window.showWarningMessage('Open a workspace before pushing a cloud document.')
    try {
      const localUri = this.localUri(root, document.path)
      const local = await vscode.workspace.openTextDocument(localUri)
      const baseRevision = this.context.workspaceState.get<number>(this.revisionKey(localUri), document.revision)
      const result = await this.client(root).putDocument(document.path, local.getText(), baseRevision)
      await this.context.workspaceState.update(this.revisionKey(localUri), result.revision)
      void vscode.window.showInformationMessage(`Uploaded ${document.path} revision ${result.revision}.`)
      await this.load(true)
    } catch (error) {
      if ((error as { status?: number }).status === 409) void vscode.window.showWarningMessage(`Cloud document ${document.path} changed remotely. Use Compare Cloud Document or Pull before pushing again.`)
      else this.showApiError('Could not push cloud document', error)
    }
  }

  refresh(): void { this.emitter.fire() }

  private currentRoot(): string | undefined {
    return workspaceRoot(vscode.window.activeTextEditor?.document ?? vscode.window.visibleTextEditors[0]?.document) ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
  }

  private localUri(root: string, remotePath: string): vscode.Uri {
    const normalized = remotePath.replaceAll('\\', '/').replace(/^\/+/, '')
    if (!normalized || path.isAbsolute(normalized) || normalized.split('/').includes('..')) throw new Error('Unsafe cloud document path')
    const rootPath = path.resolve(root)
    const filePath = path.resolve(rootPath, ...normalized.split('/'))
    if (filePath !== rootPath && !filePath.startsWith(`${rootPath}${path.sep}`)) throw new Error('Unsafe cloud document path')
    return vscode.Uri.file(filePath)
  }

  private revisionKey(uri: vscode.Uri): string { return `pyroWiki.revision.${uri.toString()}` }

  private async replaceDocument(document: vscode.TextDocument, content: string): Promise<void> {
    const edit = new vscode.WorkspaceEdit()
    const endLine = Math.max(0, document.lineCount - 1)
    edit.replace(document.uri, new vscode.Range(0, 0, endLine, document.lineAt(endLine).text.length), content)
    await vscode.workspace.applyEdit(edit)
  }

  private async writeLocal(uri: vscode.Uri, content: string): Promise<void> {
    await vscode.workspace.fs.createDirectory(vscode.Uri.file(path.dirname(uri.fsPath)))
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(content))
  }

  private showApiError(prefix: string, error: unknown): void {
    if (error instanceof ApiError && error.status === 401) void vscode.window.showWarningMessage('Sign in with Feishu before using cloud document sync.')
    else void vscode.window.showErrorMessage(`${prefix}: ${error instanceof Error ? error.message : String(error)}`)
  }

  private async syncStatus(root: string, document: RemoteDocument): Promise<CloudSyncStatus> {
    const localUri = this.localUri(root, document.path)
    try {
      await vscode.workspace.fs.stat(localUri)
    } catch {
      return cloudSyncStatus(false, undefined, document.revision)
    }
    const revisionKey = `pyroWiki.revision.${localUri.toString()}`
    const localRevision = this.context.workspaceState.get<number | undefined>(revisionKey)
    return cloudSyncStatus(true, localRevision, document.revision)
  }

  private syncLabel(status: CloudSyncStatus): string {
    return { synced: 'synced', 'remote-newer': 'remote newer', 'local-newer': 'local newer', 'not-pulled': 'not pulled', 'missing-local': 'local missing' }[status]
  }

  private syncIcon(status: CloudSyncStatus): string {
    return { synced: 'cloud', 'remote-newer': 'cloud-download', 'local-newer': 'cloud-upload', 'not-pulled': 'cloud', 'missing-local': 'file' }[status]
  }

  private client(root: string): ApiClient {
    const baseUrl = vscode.workspace.getConfiguration('pyroWiki').get<string>('apiBaseUrl', DEFAULT_API_BASE_URL)
    return new ApiClient(baseUrl, workspaceIdForRoot(root), this.auth)
  }

  dispose(): void { for (const disposable of this.disposables) disposable.dispose() }
}
