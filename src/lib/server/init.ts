import { env } from '$env/dynamic/private';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { mkdirSync, existsSync } from 'fs';
import { dirname } from 'path';
import { markStaleRuns } from './triage/telemetry';

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

	// AI tier: warn (don't fail) if the chosen provider lacks its key — deterministic
	// rules still work, and AI rules degrade gracefully (their batches stay uncovered).
	const provider = (process.env.AI_PROVIDER || 'gemini').toLowerCase();
	const providerKey: Record<string, string> = {
		gemini: 'GEMINI_API_KEY',
		openai: 'OPENAI_API_KEY'
	};
	const keyName = providerKey[provider];
	if (keyName) {
		const value = process.env[keyName];
		if (!value || value.includes('your_') || value.includes('_here')) {
			console.warn(
				`\n⚠️  AI_PROVIDER='${provider}' but ${keyName} is unset — AI-tier rules will be skipped until you set it.\n`
			);
		}
	} else {
		console.warn(`\n⚠️  Unknown AI_PROVIDER='${provider}' (supported: gemini, openai).\n`);
	}
}

/**
 * Apply drizzle-kit migrations. The schema in db/schema.ts is the single source
 * of truth; migrations live in ./drizzle (regenerate with `bunx drizzle-kit generate`).
 */
function runMigrations() {
	console.log('🔄 Applying database migrations...');
	const dbPath = env.DATABASE_PATH || './data/emails.db';
	mkdirSync(dirname(dbPath), { recursive: true });

	const sqlite = new Database(dbPath, { create: true });
	try {
		const db = drizzle(sqlite);
		migrate(db, { migrationsFolder: 'drizzle' });
		console.log('✅ Database schema ready');
	} catch (error) {
		console.error('❌ Failed to migrate database:', error);
		throw error;
	} finally {
		sqlite.close();
	}
}

export function initialize() {
	if (initialized) return;
	console.log('🚀 Initializing Mailward...');
	try {
		validateEnvironment();
		runMigrations();
		markStaleRuns().catch((error) => console.warn('⚠️  Failed to mark stale runs:', error));
		initialized = true;
		console.log('✅ Mailward initialized\n');
	} catch (error) {
		console.error('❌ Initialization failed:', error);
		process.exit(1);
	}
}
