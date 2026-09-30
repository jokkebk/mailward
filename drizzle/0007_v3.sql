CREATE TABLE v3_policies (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES tokens(id), version_no INTEGER NOT NULL,
 text TEXT NOT NULL, rubric_version INTEGER NOT NULL DEFAULT 1, status TEXT NOT NULL DEFAULT 'proposed',
 import_report TEXT, created_by TEXT NOT NULL DEFAULT 'human', created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX idx_v3_policy_account_version ON v3_policies(account_id, version_no);
--> statement-breakpoint
CREATE TABLE v3_assessments (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES tokens(id), thread_id TEXT NOT NULL,
 input_key TEXT NOT NULL, policy_id TEXT NOT NULL REFERENCES v3_policies(id), rubric_version INTEGER NOT NULL,
 model TEXT NOT NULL, actual_model TEXT, representation TEXT NOT NULL, answers TEXT, proposed_action TEXT NOT NULL,
 final_action TEXT NOT NULL, lane TEXT NOT NULL, reason TEXT NOT NULL, priority REAL NOT NULL DEFAULT 0,
 status TEXT NOT NULL, error TEXT, created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_v3_assessment_cache ON v3_assessments(account_id, thread_id, input_key, policy_id, rubric_version, model);
--> statement-breakpoint
CREATE TABLE v3_run_items (
 run_id TEXT NOT NULL REFERENCES runs(id), assessment_id TEXT NOT NULL REFERENCES v3_assessments(id),
 PRIMARY KEY (run_id, assessment_id)
);
--> statement-breakpoint
CREATE TABLE v3_reviews (
 id TEXT PRIMARY KEY, account_id TEXT NOT NULL REFERENCES tokens(id), assessment_id TEXT NOT NULL UNIQUE REFERENCES v3_assessments(id),
 run_id TEXT NOT NULL REFERENCES runs(id), actor TEXT NOT NULL, kind TEXT NOT NULL,
 disposition TEXT NOT NULL, final_disposition TEXT, acknowledged INTEGER NOT NULL DEFAULT 0,
 chip TEXT, note TEXT, action_id TEXT REFERENCES actions(id), execution_status TEXT NOT NULL,
 error TEXT, created_at INTEGER NOT NULL
);
--> statement-breakpoint
CREATE INDEX idx_v3_reviews_run ON v3_reviews(run_id);
--> statement-breakpoint
CREATE TABLE v3_call_logs (
 id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), account_id TEXT NOT NULL REFERENCES tokens(id),
 model TEXT NOT NULL, thread_count INTEGER NOT NULL, prompt_chars INTEGER NOT NULL,
 input_tokens INTEGER, output_tokens INTEGER, duration_ms INTEGER NOT NULL, status TEXT NOT NULL,
 error TEXT, created_at INTEGER NOT NULL
);
