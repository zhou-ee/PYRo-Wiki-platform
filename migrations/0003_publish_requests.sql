CREATE TABLE IF NOT EXISTS publish_requests (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  document_path TEXT NOT NULL,
  revision INTEGER NOT NULL,
  base_github_sha TEXT NOT NULL,
  requester_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK(status IN ('draft','submitted','approved','publishing','published','rejected','conflict','failed')),
  review_by TEXT,
  review_message TEXT,
  github_commit_sha TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  submitted_at TEXT,
  approved_at TEXT,
  published_at TEXT,
  UNIQUE(workspace_id, document_path, revision, requester_id)
);

CREATE INDEX IF NOT EXISTS idx_publish_requests_workspace_status ON publish_requests(workspace_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_publish_requests_requester ON publish_requests(requester_id, updated_at DESC);
