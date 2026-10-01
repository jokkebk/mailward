/** Dry-run a recipe against stored mail; --apply adopts it (or appends a version) for the account.
 * bun run v3-recipe <accountId> recipe.json [--apply]   No Gmail or model calls.
 */
import { Database } from 'bun:sqlite';
import { readFileSync } from 'node:fs';
import { listRecipes, parseRecipe, recentMatches, saveRecipe } from '../src/lib/server/v3/recipes';

const [accountId, path, ...flags] = process.argv.slice(2);
if (!accountId || !path || flags.some((f) => f !== '--apply')) throw new Error('Usage: bun run v3-recipe <accountId> recipe.json [--apply]');
const spec = parseRecipe(readFileSync(path, 'utf8'));
const apply = flags.includes('--apply');
const db = new Database(process.env.DATABASE_PATH || './data/emails.db', apply ? { readwrite: true } : { readonly: true });
try {
  db.exec('PRAGMA foreign_keys = ON');
  const current = listRecipes(db, accountId).find((r) => r.key === spec.key) ?? null;
  const dryRun = recentMatches(db, accountId, [spec]);
  const preview = { accountId, key: spec.key, replaces: current ? { version: current.version, spec: current.spec } : null, dryRun, gmailActions: 0, reviewRequired: true };
  if (!apply) console.log(JSON.stringify({ ...preview, applied: false }, null, 2));
  else { const saved = saveRecipe(db, accountId, spec, 'weekly-review', 'agent'); console.log(JSON.stringify({ ...preview, applied: true, version: saved.version }, null, 2)); }
} finally { db.close(); }
