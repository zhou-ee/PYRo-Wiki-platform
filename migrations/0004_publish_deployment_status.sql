ALTER TABLE publish_requests ADD COLUMN github_workflow_run_id TEXT;
ALTER TABLE publish_requests ADD COLUMN deployment_status TEXT;
ALTER TABLE publish_requests ADD COLUMN deployment_url TEXT;
ALTER TABLE publish_requests ADD COLUMN deployment_error TEXT;
ALTER TABLE publish_requests ADD COLUMN deployment_checked_at TEXT;
ALTER TABLE publish_requests ADD COLUMN deployed_at TEXT;
