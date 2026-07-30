CREATE TABLE IF NOT EXISTS document_drafts (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '[]',
  last_author_id TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, document_path)
);

CREATE TABLE IF NOT EXISTS workspace_draft_manifest (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  deleted INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (workspace_id, document_path)
);

CREATE TABLE IF NOT EXISTS workspace_snapshots (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  manifest_json TEXT NOT NULL,
  base_github_sha TEXT,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft','submitted','approved','rejected','publishing','published','failed')),
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS workspace_snapshot_items (
  snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  provenance_json TEXT NOT NULL DEFAULT '[]',
  deleted INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (snapshot_id, document_path)
);

CREATE TABLE IF NOT EXISTS publish_batches (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  snapshot_id TEXT NOT NULL REFERENCES workspace_snapshots(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'submitted' CHECK(status IN ('submitted','approved','rejected','publishing','published','conflict','failed')),
  requester_id TEXT NOT NULL,
  reviewer_id TEXT,
  review_message TEXT,
  github_commit_sha TEXT,
  github_workflow_run_id TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS publish_batch_items (
  batch_id TEXT NOT NULL REFERENCES publish_batches(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (batch_id, document_path)
);

CREATE INDEX IF NOT EXISTS idx_document_drafts_workspace_updated ON document_drafts(workspace_id, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_workspace_snapshots_workspace_created ON workspace_snapshots(workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_batches_workspace_status ON publish_batches(workspace_id, status, updated_at DESC);
