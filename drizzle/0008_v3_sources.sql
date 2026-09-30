ALTER TABLE v3_assessments ADD COLUMN assessment_source TEXT NOT NULL DEFAULT 'jev';
--> statement-breakpoint
ALTER TABLE v3_assessments ADD COLUMN deterministic_rule TEXT;
--> statement-breakpoint
ALTER TABLE v3_assessments ADD COLUMN deterministic_version INTEGER;
