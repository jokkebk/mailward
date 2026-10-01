import type { PolicyCard, RecipeSpec } from '$lib/types/v3';

// Client-side shapes of /api/v3/settings. Pure helpers only.

export interface RecipeStat { key: string; matched: number; reviewed: number; agreed: number; overlaps: string[]; samples: { from: string; subject: string; reviewed: string | null }[] }
export interface MatchReport { scanned: number; days: number; results: RecipeStat[] }
export interface SuggestedCard extends PolicyCard { blurb: string; input?: { key: 'topics'; label: string; placeholder: string } }
export interface JevQuestion { key: string; kind: string; instruction: string; options: { key: string; label: string }[] }

export interface SettingsData {
  accountId: string;
  setupNeeded: boolean;
  policy: { id: string; version: number; cards: PolicyCard[]; words: number; createdBy: string; createdAt: number; note: string | null } | null;
  history: { id: string; version: number; createdBy: string; createdAt: number; note: string | null; words: number; text: string }[];
  agreement: { version: number; comparable: number; matched: number }[];
  lastRunThreads: number;
  recipes: { key: string; version: number; status: 'active' | 'paused'; source: string | null; createdBy: string; updatedAt: number; spec: RecipeSpec }[];
  recipeStats: MatchReport;
  library: { spec: RecipeSpec; version: number; recommended: boolean; adopted: boolean }[];
  fields: Record<string, string>;
  jev: { model: string; rubricVersion: number; shared: string; questions: JevQuestion[] };
  setup: { starter: PolicyCard[]; suggested: SuggestedCard[] };
}

/** Mirrors the server: only enabled bodies reach Jev, separated by blank lines. */
export const policyText = (cards: PolicyCard[]) => cards.filter((c) => c.enabled && c.body.trim()).map((c) => c.body.trim()).join('\n\n');
export const wordCount = (text: string) => (text.trim() ? text.trim().split(/\s+/).length : 0);
export const MAX_WORDS = 1700;
export const MIN_WORDS = 40;

export const RECIPE_ACTION: Record<RecipeSpec['action'], string> = { trash: 'Trash', archive: 'Archive', label_todo: 'TODO' };
export function recipeOutcome(spec: RecipeSpec): string {
  if (spec.action === 'label_todo') return `TODO in ${spec.section === 'worth_reading' ? 'Worth checking out' : 'Needs action'}, then ${spec.then === 'trash' ? 'trash' : spec.then === 'leave' ? 'leave' : 'archive'} when done`;
  return spec.section === 'show_before_clearing' ? `Show once, then ${spec.action}` : `Proposed for ${spec.action}`;
}

export const ACTOR_LABEL: Record<string, string> = {
  human: 'you', setup: 'setup', bootstrap: 'starter', 'weekly-review': 'weekly review', 'quality-audit': 'quality audit',
  'v2-curated-import': 'v2 import', migration: 'migration'
};
export const actorLabel = (actor: string | null | undefined) => (actor ? ACTOR_LABEL[actor] ?? actor : 'unknown');

export function ago(time: number | null | undefined): string {
  if (!time) return '';
  const s = (Date.now() - time) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(time).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: new Date(time).getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export const RECIPE_TEMPLATE = `{
  "key": "my-recipe",
  "title": "What this matches",
  "description": "One sentence a person can check.",
  "action": "archive",
  "match": [
    { "field": "fromDomain", "equals": "example.com" },
    { "field": "subject", "matches": "^Your weekly report" }
  ]
}`;
