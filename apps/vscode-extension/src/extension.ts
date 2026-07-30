let cachedMembers: Record<string, import('./preview/parser').Member> = {}

import * as vscode from 'vscode'
import { PyroCompletionProvider } from './completion'
import { loadMembers } from './preview/data'
import { PreviewController } from './preview/controller'
import { configuredWikiRoot, isWikiDocument, selectWikiRoot } from './workspace'
import { pullCurrent, pushCurrent, retryQueued, viewCurrentRevisions, createWorkspacePublishBatch, approveWorkspacePublishBatch, rejectWorkspacePublishBatch } from './sync/commands'
import { WorkspaceCollaborationClient } from './collaboration/workspaceClient'
import { runProductionAdversarialTest } from './collaboration/adversarial'
import { CollaborationProvider } from './collaboration/workspace'
import { extendMarkdownIt as extendNativeMarkdownIt } from './preview/native'
import { createRepositoryStatusItem, pullRepository, showRepositoryStatus } from './git'
import { WikiDocumentsProvider, searchMarkdownDocuments, createMarkdownDocument, deleteMarkdownDocument, renameMarkdownDocument } from './markdownWorkspace'
import { AuthManager } from './auth/session'
import { CloudDocumentsProvider } from './cloudWorkspace'
import { pendingSyncCount } from './sync/queue'
import { initializeWikiWorkspace, pullSharedWiki } from './initialize'

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const authOutput = vscode.window.createOutputChannel('PYRo Wiki Auth')
  const auth = new AuthManager(context, authOutput)
  // Do not block command registration on SecretStorage initialization.
  // VS Code can take a long time to restore a profile's secret store; the
  // extension must still expose collaboration and publish commands so they
  // can wait for lazy authentication when they actually perform a request.
  void auth.initialize().catch((error) => authOutput.appendLine(`[${new Date().toISOString()}] initialization failed: ${error instanceof Error ? error.message : String(error)}`))
  const preview = new PreviewController(context)
  const collaboration = new WorkspaceCollaborationClient(context, auth)
  const collaborationProvider = new CollaborationProvider(collaboration)
  const provenanceHover = vscode.languages.registerHoverProvider('markdown', {
    provideHover: async (document, position) => {
      const author = await collaboration.authorAt(document, document.offsetAt(position))
      return author ? new vscode.Hover(`**${author.name}**\n\nRange: ${author.start}-${author.end}`) : undefined
    }
  })
  const cloudDocuments = new CloudDocumentsProvider(context, auth)
  context.subscriptions.push(authOutput, auth, preview, collaboration, collaborationProvider, cloudDocuments, provenanceHover)

  createRepositoryStatusItem(context)
  const authStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100)
  const syncStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90)
  const workflowStatus = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 80)

  const getActiveDocument = (): vscode.TextDocument | undefined => vscode.window.activeTextEditor?.document
  const updateContextKeys = (): void => {
    const document = getActiveDocument()
    void vscode.commands.executeCommand('setContext', 'pyroWiki.signedIn', auth.signedIn)
    void vscode.commands.executeCommand('setContext', 'pyroWiki.canPublish', Boolean(auth.currentUser?.permissions?.canPublish))
    void vscode.commands.executeCommand('setContext', 'pyroWiki.isWikiDocument', Boolean(document && isWikiDocument(document)))
  }

  const updateAuthStatus = (): void => {
    authStatus.text = auth.currentUser ? `$(account) ${auth.currentUser.name}` : '$(sign-in) PYRo Login'
    authStatus.tooltip = auth.currentUser ? `Signed in to PYRo Wiki as ${auth.currentUser.name}` : 'Sign in to PYRo Wiki with Feishu'
    authStatus.command = auth.currentUser ? 'pyroWiki.signOut' : 'pyroWiki.signIn'
    authStatus.show()
    updateContextKeys()
  }

  const updateSyncStatus = async (): Promise<void> => {
    const count = await pendingSyncCount(context)
    if (!auth.signedIn) {
      syncStatus.text = '$(cloud-offline) Cloud sync'
      syncStatus.tooltip = 'Sign in with Feishu to enable cloud sync'
      syncStatus.command = 'pyroWiki.signIn'
    } else if (count > 0) {
      syncStatus.text = `$(sync) ${count} pending`
      syncStatus.tooltip = `${count} document${count === 1 ? '' : 's'} waiting to sync. Click to retry.`
      syncStatus.command = 'pyroWiki.retrySyncQueue'
    } else {
      syncStatus.text = '$(cloud) Synced'
      syncStatus.tooltip = 'No pending cloud sync operations'
      syncStatus.command = 'pyroWiki.retrySyncQueue'
    }
    syncStatus.show()
  }

  const updateWorkflowStatus = (snapshot = collaboration.state): void => {
    const document = getActiveDocument()
    if (!document || !isWikiDocument(document)) {
      workflowStatus.hide()
      return
    }
    if (!auth.signedIn) {
      workflowStatus.text = '$(cloud-offline) Sign in to collaborate'
      workflowStatus.tooltip = 'Sign in with Feishu to enable workspace collaboration'
      workflowStatus.command = 'pyroWiki.signIn'
      workflowStatus.show()
      return
    }
    const memberCount = snapshot.members.length
    if (snapshot.status === 'connected') {
      workflowStatus.text = `$(cloud) Workspace synced${memberCount ? ` - ${memberCount} online` : ''}`
      workflowStatus.tooltip = 'Edits are automatically synchronized. Create one workspace publish batch for the changed files when ready.'
      workflowStatus.command = 'pyroWiki.createWorkspacePublishBatch'
    } else if (snapshot.status === 'connecting' || snapshot.status === 'reconnecting') {
      workflowStatus.text = '$(sync~spin) Workspace reconnecting'
      workflowStatus.tooltip = 'Local edits remain available and will be merged after the workspace connection recovers.'
      workflowStatus.command = 'pyroWiki.joinCollaboration'
    } else if (snapshot.status === 'error') {
      workflowStatus.text = '$(error) Workspace error'
      workflowStatus.tooltip = snapshot.error || 'Workspace collaboration reported an error.'
      workflowStatus.command = 'pyroWiki.joinCollaboration'
    } else {
      workflowStatus.text = '$(cloud-offline) Join workspace collaboration'
      workflowStatus.tooltip = 'Join the workspace realtime collaboration room.'
      workflowStatus.command = 'pyroWiki.joinCollaboration'
    }
    workflowStatus.show()
  }

  const retrySyncQueue = async (silent = false): Promise<void> => {
    await retryQueued(context, auth, silent)
    await updateSyncStatus()
  }
  const runPush = async (): Promise<void> => { await pushCurrent(context, auth); await updateSyncStatus(); updateWorkflowStatus() }
  const runPull = async (): Promise<void> => { await pullCurrent(context, auth); await updateSyncStatus(); updateWorkflowStatus() }
  const handleAuthChange = (): void => {
    updateAuthStatus()
    void updateSyncStatus()
    void updateWorkflowStatus()
    if (auth.signedIn) void retrySyncQueue(true)
  }
  updateAuthStatus()
  void updateSyncStatus()
  void updateWorkflowStatus()
  context.subscriptions.push(authStatus, syncStatus, workflowStatus, auth.onDidChange(handleAuthChange), collaboration.onDidChange((snapshot) => updateWorkflowStatus(snapshot)))

  const markdownDocuments = new WikiDocumentsProvider()
  const markdownTreeView = vscode.window.createTreeView('pyroWiki.documents', { treeDataProvider: markdownDocuments, showCollapseAll: true })
  const cloudTreeView = vscode.window.createTreeView('pyroWiki.cloudDocuments', { treeDataProvider: cloudDocuments, showCollapseAll: false })
  context.subscriptions.push(cloudTreeView.onDidChangeVisibility((event) => { if (event.visible) void cloudDocuments.load() }))
  const collaborationTreeView = vscode.window.createTreeView('pyroWiki.collaboration', { treeDataProvider: collaborationProvider, showCollapseAll: false })
  context.subscriptions.push(markdownDocuments, markdownTreeView, cloudTreeView, collaborationTreeView)

  const members = async (): Promise<Record<string, import('./preview/parser').Member>> => {
    const document = vscode.window.activeTextEditor?.document
    cachedMembers = document ? await loadMembers(configuredWikiRoot(document), context) : context.globalState.get('pyroWiki.membersCache', {})
    return cachedMembers
  }
  const getMembers = () => cachedMembers
  const provider = new PyroCompletionProvider(getMembers)

  context.subscriptions.push(
    vscode.commands.registerCommand('pyroWiki.initializeWorkspace', initializeWikiWorkspace),
    vscode.commands.registerCommand('pyroWiki.pullSharedWiki', () => pullSharedWiki(false)),
    vscode.commands.registerCommand('pyroWiki.selectWikiRoot', selectWikiRoot),
    vscode.commands.registerCommand('pyroWiki.openPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.openSourceAndPreview', () => preview.open()),
    vscode.commands.registerCommand('pyroWiki.refreshPreview', () => preview.refresh()),
    vscode.commands.registerCommand('pyroWiki.pullRepository', pullRepository),
    vscode.commands.registerCommand('pyroWiki.repositoryStatus', showRepositoryStatus),
    vscode.commands.registerCommand('pyroWiki.openMarkdownWorkspace', () => vscode.commands.executeCommand('workbench.view.extension.pyroWiki')),
    vscode.commands.registerCommand('pyroWiki.searchMarkdownDocuments', searchMarkdownDocuments),
    vscode.commands.registerCommand('pyroWiki.createMarkdownDocument', (node) => createMarkdownDocument(node, (document, label) => collaboration.synchronizeCreatedMarkdownDocument(document, label))),
    vscode.commands.registerCommand('pyroWiki.deleteMarkdownDocument', (node) => deleteMarkdownDocument(node, (uri) => collaboration.synchronizeDeletedMarkdownDocument(uri))),
    vscode.commands.registerCommand('pyroWiki.renameMarkdownDocument', (node) => renameMarkdownDocument(node)),
    vscode.commands.registerCommand('pyroWiki.refreshDocuments', () => markdownDocuments.refresh()),
    vscode.commands.registerCommand('pyroWiki.signIn', () => auth.signIn()),
    vscode.commands.registerCommand('pyroWiki.signOut', () => auth.signOut()),
    vscode.commands.registerCommand('pyroWiki.completeFeishuLogin', async () => {
      const handoff = await vscode.window.showInputBox({ prompt: 'Paste the Feishu fallback handoff code', password: true, ignoreFocusOut: true })
      if (handoff) await auth.completeHandoff(handoff)
    }),
    vscode.commands.registerCommand('pyroWiki.refreshCloudDocuments', () => cloudDocuments.load(true)),
    vscode.commands.registerCommand('pyroWiki.searchCloudDocuments', () => cloudDocuments.search()),
    vscode.commands.registerCommand('pyroWiki.openCloudDocument', (document) => cloudDocuments.openDocument(document)),
    vscode.commands.registerCommand('pyroWiki.viewCloudRevisions', (document) => cloudDocuments.showRevisions(document)),
    vscode.commands.registerCommand('pyroWiki.compareCloudDocument', (document) => cloudDocuments.compareWithLocal(document)),
    vscode.commands.registerCommand('pyroWiki.pullCloudDocument', (document) => cloudDocuments.pullDocument(document)),
    vscode.commands.registerCommand('pyroWiki.pushCloudDocument', (document) => cloudDocuments.pushDocument(document)),
    vscode.commands.registerCommand('pyroWiki.pullDocument', runPull),
    vscode.commands.registerCommand('pyroWiki.pushDocument', runPush),
    vscode.commands.registerCommand('pyroWiki.retrySyncQueue', () => retrySyncQueue(false)),
    vscode.commands.registerCommand('pyroWiki.viewRevisions', () => viewCurrentRevisions(auth)),
    vscode.commands.registerCommand('pyroWiki.createWorkspacePublishBatch', async () => {
      if (!(await collaboration.waitForSynchronization())) return void vscode.window.showWarningMessage('Workspace is still synchronizing. Please try creating the workspace publish batch again in a moment.')
      if (!(await collaboration.reconcileLocalMarkdownFiles())) return
      return createWorkspacePublishBatch(auth)
    }),
    vscode.commands.registerCommand('pyroWiki.approveWorkspacePublishBatch', () => approveWorkspacePublishBatch(auth)),
    vscode.commands.registerCommand('pyroWiki.rejectWorkspacePublishBatch', () => rejectWorkspacePublishBatch(auth)),
    vscode.commands.registerCommand('pyroWiki.resolveConflict', () => pushCurrent(context, auth)),
    vscode.commands.registerCommand('pyroWiki.joinCollaboration', () => collaboration.join()),
    vscode.commands.registerCommand('pyroWiki.runProductionAdversarialTest', () => vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PYRo Wiki production adversarial test', cancellable: false }, () => runProductionAdversarialTest(auth, authOutput))),
    vscode.commands.registerCommand('pyroWiki.leaveCollaboration', () => collaboration.leave()),
    vscode.languages.registerCompletionItemProvider({ language: 'markdown' }, provider, '/'),
    vscode.workspace.onDidOpenTextDocument(async () => { await members() }),
    vscode.workspace.onDidSaveTextDocument((document) => {
      // Realtime collaboration observes text changes directly. Saving a file must not
      // call the legacy per-document draft or submit endpoints.
      if (isWikiDocument(document)) {
        void updateSyncStatus()
        updateWorkflowStatus()
      }
    }),
    vscode.window.onDidChangeWindowState((state) => { if (state.focused) void retrySyncQueue(true) }),
    vscode.window.onDidChangeActiveTextEditor(async (editor) => {
      if (editor?.document.languageId === 'markdown') {
        await members()
        updateContextKeys()
        updateWorkflowStatus()
      } else {
        updateContextKeys()
        workflowStatus.hide()
      }
    })
  )
  const activeDocument = vscode.window.activeTextEditor?.document
  const runAdversarialOnActivation = vscode.workspace.getConfiguration('pyroWiki').get<boolean>('runAdversarialOnActivation', false)
  if (runAdversarialOnActivation) {
    void vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'PYRo Wiki production adversarial test', cancellable: false }, async () => {
      try {
        const result = await runProductionAdversarialTest(auth, authOutput)
        await vscode.workspace.getConfiguration('pyroWiki').update('runAdversarialOnActivation', false, vscode.ConfigurationTarget.Workspace)
        void vscode.window.showInformationMessage(`Production adversarial test passed and cleaned workspace ${result.workspaceId}.`)
      } catch (error) {
        void vscode.window.showErrorMessage(`Production adversarial test failed: ${error instanceof Error ? error.message : String(error)}`)
      }
    })
  } else if (auth.signedIn && activeDocument && isWikiDocument(activeDocument)) void collaboration.join(activeDocument)
  if (activeDocument?.languageId === 'markdown') {
    void preview.warmup(activeDocument)
    void members().catch((error) => authOutput.appendLine(`[${new Date().toISOString()}] member cache load failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}

export function deactivate(): void {}

export function extendMarkdownIt(md: any): any {
  return extendNativeMarkdownIt(md, () => cachedMembers)
}
