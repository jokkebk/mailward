import { env } from '$env/dynamic/private';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { Database } from 'bun:sqlite';
import * as schema from './schema';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let _db: ReturnType<typeof drizzle> | null = null;
function getDb() {
	if (!_db) {
		const path = env.DATABASE_PATH || './data/emails.db';
		mkdirSync(dirname(path), { recursive: true });
		const sqlite = new Database(path, { create: true });
		_db = drizzle(sqlite, { schema });
	}
	return _db;
}

export const db = new Proxy({} as ReturnType<typeof drizzle>, {
	get(_, prop) {
		return (getDb() as any)[prop];
	}
});
