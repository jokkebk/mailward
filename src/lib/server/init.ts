import { env } from '$env/dynamic/private';
import { Database } from 'bun:sqlite';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';

let initialized = false;

function validateEnvironment() {
	const required = [
		{ key: 'GOOGLE_CLIENT_ID', description: 'Google OAuth Client ID' },
		{ key: 'GOOGLE_CLIENT_SECRET', description: 'Google OAuth Client Secret' },
		{ key: 'GOOGLE_REDIRECT_URI', description: 'Google OAuth Redirect URI' }
	];

	const missing: string[] = [];
	for (const { key, description } of required) {
		const value = process.env[key];
		if (!value || value.includes('your_') || value.includes('_here')) {
			missing.push(`${key} (${description})`);
		}
	}

	if (missing.length > 0) {
		throw new Error(
			[
				'\n❌ Missing or invalid environment variables:',
				...missing.map((m) => `   - ${m}`),
				'\nCopy .env.example to .env and fill in the values (see README / DESIGN.md).\n'
			].join('\n')
		);
	}

	if (!existsSync('.env')) {
		console.warn('\n⚠️  .env file not found. Using environment variables from system.\n');
	}
}

function runMigrations() {
	console.log('🔄 Checking database schema...');
	const dbPath = env.DATABASE_PATH || './data/emails.db';
	mkdirSync(dirname(dbPath), { recursive: true });
	const db = new Database(dbPath, { create: true });

	const migration = `
CREATE TABLE IF NOT EXISTS tokens (
	id text PRIMARY KEY NOT NULL,
	access_token text NOT NULL,
	refresh_token text NOT NULL,
	expires_at integer NOT NULL
);

CREATE TABLE IF NOT EXISTS threads (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL,
	"from" text NOT NULL,
	from_domain text NOT NULL,
	"to" text,
	subject text,
	snippet text,
	received_at integer NOT NULL,
	is_unread integer DEFAULT 1,
	label_ids text,
	message_ids text,
	raw_headers text,
	synced_at integer NOT NULL,
	FOREIGN KEY (account_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS rules (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL,
	name text NOT NULL,
	status text NOT NULL DEFAULT 'proposing',
	current_version_id text,
	created_at integer NOT NULL,
	updated_at integer NOT NULL,
	FOREIGN KEY (account_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS rule_versions (
	id text PRIMARY KEY NOT NULL,
	rule_id text NOT NULL,
	version_no integer NOT NULL,
	priority integer NOT NULL,
	match_criteria text NOT NULL,
	intent text,
	action text NOT NULL,
	tier text NOT NULL DEFAULT 'deterministic',
	needs_body integer DEFAULT 0,
	created_by text NOT NULL DEFAULT 'human',
	change_note text,
	is_current integer DEFAULT 1,
	created_at integer NOT NULL,
	FOREIGN KEY (rule_id) REFERENCES rules(id)
);

CREATE TABLE IF NOT EXISTS runs (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL,
	started_at integer NOT NULL,
	ended_at integer,
	scope text,
	status text NOT NULL DEFAULT 'running',
	FOREIGN KEY (account_id) REFERENCES tokens(id)
);

CREATE TABLE IF NOT EXISTS actions (
	id text PRIMARY KEY NOT NULL,
	run_id text,
	account_id text NOT NULL,
	rule_id text,
	rule_version_id text,
	thread_id text NOT NULL,
	message_ids text,
	action text NOT NULL,
	prior_state text NOT NULL,
	source text NOT NULL,
	confidence text,
	mode text NOT NULL,
	status text NOT NULL DEFAULT 'applied',
	verdict text,
	note text,
	error text,
	created_at integer NOT NULL,
	applied_at integer,
	rolled_back_at integer,
	FOREIGN KEY (account_id) REFERENCES tokens(id),
	FOREIGN KEY (run_id) REFERENCES runs(id)
);

CREATE TABLE IF NOT EXISTS verdicts (
	id text PRIMARY KEY NOT NULL,
	account_id text NOT NULL,
	thread_id text NOT NULL,
	rule_version_id text NOT NULL,
	rule_id text NOT NULL,
	run_id text,
	verdict text NOT NULL,
	exclude_from_metric integer DEFAULT 0,
	note text,
	created_at integer NOT NULL,
	FOREIGN KEY (account_id) REFERENCES tokens(id)
);

CREATE INDEX IF NOT EXISTS idx_verdicts_thread_version ON verdicts(thread_id, rule_version_id);
CREATE INDEX IF NOT EXISTS idx_actions_run ON actions(run_id);
CREATE INDEX IF NOT EXISTS idx_actions_run_rule ON actions(run_id, rule_id);
CREATE INDEX IF NOT EXISTS idx_rule_versions_rule ON rule_versions(rule_id);
`;

	try {
		db.exec(migration);
		console.log('✅ Database schema ready');
	} catch (error) {
		console.error('❌ Failed to initialize database:', error);
		throw error;
	} finally {
		db.close();
	}
}

export function initialize() {
	if (initialized) return;
	console.log('🚀 Initializing Mailward...');
	try {
		validateEnvironment();
		runMigrations();
		initialized = true;
		console.log('✅ Mailward initialized\n');
	} catch (error) {
		console.error('❌ Initialization failed:', error);
		process.exit(1);
	}
}
