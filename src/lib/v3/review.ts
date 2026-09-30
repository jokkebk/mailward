import type { Attention, Category, Handling, ReviewDecision, ReviewItem, ReviewKind } from '$lib/types/v3';

// Presentation model for the single review page. Pure and client-safe: it only
// orders and labels stored assessments, so changing it never calls Jev.

export type SectionKey = 'needs_action' | 'worth_reading' | 'decision' | 'show_me' | 'archive' | 'trash';
export type Choice = Handling | 'done';

export interface SectionDef {
  key: SectionKey;
  title: string;
  hint: string;
  /** Bulk action offered in the header; null when rows have no firm proposal. */
  bulk: Handling | null;
}

export const SECTIONS: SectionDef[] = [
  { key: 'needs_action', title: 'Needs action', hint: 'Waiting on you to reply, decide or do something', bulk: 'label_todo' },
  { key: 'worth_reading', title: 'Worth checking out', hint: 'No obligation, but likely worth your time', bulk: 'label_todo' },
  { key: 'decision', title: 'Needs a decision', hint: 'Jev could not settle these, so they are your call', bulk: null },
  { key: 'show_me', title: 'Show before clearing', hint: 'Reminders to see once, then clear', bulk: 'trash' },
  { key: 'archive', title: 'Archive', hint: 'Worth keeping, no attention needed', bulk: 'archive' },
  { key: 'trash', title: 'Trash', hint: 'No attention needed and nothing worth keeping', bulk: 'trash' }
];

/** "Trash all 34", or "Trash remaining 20" once some rows have their own decision. */
export function bulkLabel(action: Handling, n: number, all: boolean): string {
  const scope = all ? 'all' : 'remaining';
  return action === 'label_todo' ? `Mark ${scope} ${n} TODO` : `${ACTION_LABEL[action]} ${scope} ${n}`;
}

export const ACTION_LABEL: Record<Choice, string> = { label_todo: 'TODO', archive: 'Archive', trash: 'Trash', leave: 'Leave', done: 'Done' };
export const APPLIED_LABEL: Record<Handling, string> = { label_todo: 'Marked TODO', archive: 'Archived', trash: 'Trashed', leave: 'Left in inbox' };
export const CATEGORY_LABEL: Record<Category, string> = {
  conversation: 'Conversations', notification: 'Notifications', transaction: 'Receipts & transactions',
  newsletter: 'Newsletters & digests', sales: 'Sales & promotions', other: 'Other'
};
export const CATEGORY_SINGULAR: Record<Category, string> = {
  conversation: 'Conversation', notification: 'Notification', transaction: 'Transaction', newsletter: 'Newsletter', sales: 'Sales', other: 'Other'
};
export const ATTENTION_LABEL: Record<Attention, string> = {
  act: 'Needs action', read: 'Worth reading', glance: 'Show before clearing', none: 'No attention', unclear: 'Unclear'
};
const RULE_GROUPS: Record<string, { title: string; hint: string }> = {
  'calendar-rsvp': { title: 'Calendar replies', hint: 'Bare accept/decline with no note' }
};

export function sectionOf(item: ReviewItem): SectionKey {
  if (item.lane !== 'cleanup') return item.lane;
  // Cleanup always resolves to archive or trash; anything else needs a person.
  return item.proposed_action === 'trash' ? 'trash' : item.proposed_action === 'archive' ? 'archive' : 'decision';
}

/**
 * The option a row pre-marks. Firm for ready proposals (show-before-clearing
 * proposes its after-viewing action); a non-binding leaning for unresolved rows
 * whose attention distribution still points somewhere.
 */
export function suggestionOf(item: ReviewItem): { choice: Handling; firm: boolean } | null {
  if (item.status === 'ready') return { choice: item.lane === 'show_me' ? item.final_action : item.proposed_action, firm: true };
  const a = item.answers;
  if (!a) return null;
  const p = a.attention.probabilities;
  const todo = p.act + p.read;
  const clear = p.none + p.glance;
  if (Math.max(todo, clear) <= p.unclear) return null;
  if (todo >= clear) return { choice: 'label_todo', firm: false };
  if (a.retention.choice === 'keep') return { choice: 'archive', firm: false };
  if (a.retention.choice === 'disposable') return { choice: 'trash', firm: false };
  return null;
}

export function kindFor(item: ReviewItem, disposition: Handling): ReviewKind {
  if (disposition === 'leave') return 'skip';
  const suggestion = suggestionOf(item);
  return suggestion?.firm && suggestion.choice === disposition ? 'approve' : 'correct';
}

/** Default follow-up for Done: the handling Jev intended after attention. */
export function doneFollowUp(item: ReviewItem): Handling {
  return item.final_action === 'label_todo' ? 'archive' : item.final_action;
}

export function decide(item: ReviewItem, choice: Choice, previous?: ReviewDecision): ReviewDecision {
  const kept = { assessmentId: item.id, chip: previous?.chip, note: previous?.note };
  if (choice === 'done') return { ...kept, kind: 'done', disposition: 'leave', finalDisposition: previous?.finalDisposition ?? doneFollowUp(item) };
  return { ...kept, kind: kindFor(item, choice), disposition: choice };
}

export function choiceOf(decision: ReviewDecision | undefined): Choice | null {
  if (!decision) return null;
  return decision.kind === 'done' ? 'done' : decision.disposition;
}

/** Show-before-clearing mail must be explicitly seen before it can be trashed. */
export function needsSeen(item: ReviewItem, decision: ReviewDecision): boolean {
  const reminder = item.lane === 'show_me' || decision.chip === 'show_before_clearing';
  return reminder && (decision.disposition === 'trash' || decision.finalDisposition === 'trash');
}

// ── Importance ──────────────────────────────────────────────────────────────
// Jev scores urgency and relevance on 0–3. Obligations sort by urgency first;
// worthwhile reading sorts by relevance first, as the v3 plan specifies.

const MAX_WEIGHT = 3 * 30 + 3 * 13;

export function weight(item: ReviewItem, section: SectionKey): number {
  const u = item.answers?.urgency.score ?? 0;
  const r = item.answers?.relevance.score ?? 0;
  return section === 'worth_reading' ? r * 30 + u * 13 : u * 30 + r * 13;
}

/** 0–3 signal bars; a visual hint for how much a row matters, not a probability. */
export function tier(item: ReviewItem, section: SectionKey): 0 | 1 | 2 | 3 {
  const w = weight(item, section) / MAX_WEIGHT;
  return w >= 0.5 ? 3 : w >= 0.28 ? 2 : w >= 0.12 ? 1 : 0;
}

export function receivedAt(item: ReviewItem): number {
  return Date.parse(item.representation.messages[0]?.date ?? '') || item.created_at;
}

function byImportance(section: SectionKey) {
  return (a: ReviewItem, b: ReviewItem) =>
    weight(b, section) - weight(a, section) || receivedAt(b) - receivedAt(a) || a.id.localeCompare(b.id);
}

// ── Sections and category groups ────────────────────────────────────────────

export interface Subgroup {
  key: string;
  title: string;
  hint: string | null;
  icon: Category | 'calendar';
  rule: boolean;
  rows: ReviewItem[];
}

export interface SectionView {
  def: SectionDef;
  rows: ReviewItem[];
  /** Category groups, only for cleanup sections where Jev's category helps scanning. */
  groups: Subgroup[] | null;
}

function subgroupsOf(rows: ReviewItem[], section: SectionKey): Subgroup[] {
  const map = new Map<string, Subgroup>();
  for (const row of rows) {
    const ruleKey = row.assessment_source === 'rule' ? row.deterministic_rule ?? 'rule' : null;
    const category = row.answers?.category.choice ?? 'other';
    const key = ruleKey ? `rule:${ruleKey}` : category;
    if (!map.has(key)) {
      const rule = ruleKey ? RULE_GROUPS[ruleKey] ?? { title: 'Rule matches', hint: null } : null;
      map.set(key, {
        key, rule: !!ruleKey, rows: [],
        title: rule?.title ?? CATEGORY_LABEL[category],
        hint: rule ? `${rule.hint ?? ''}${rule.hint ? ' · ' : ''}rule v${row.deterministic_version ?? 1}` : null,
        icon: ruleKey === 'calendar-rsvp' ? 'calendar' : category
      });
    }
    map.get(key)!.rows.push(row);
  }
  // Groups follow their most important member, so a risky trash candidate
  // surfaces its whole category first. Rule matches trail Jev-assessed mail.
  const top = (g: Subgroup) => weight(g.rows[0], section);
  return [...map.values()].sort((a, b) => Number(a.rule) - Number(b.rule) || top(b) - top(a) || b.rows.length - a.rows.length || a.key.localeCompare(b.key));
}

export function buildSections(items: ReviewItem[]): { sections: SectionView[]; reviewed: ReviewItem[] } {
  const live = items.filter((i) => !i.review_kind);
  const sections = SECTIONS.map((def) => {
    const rows = live.filter((i) => sectionOf(i) === def.key).sort(byImportance(def.key));
    return { def, rows, groups: def.key === 'archive' || def.key === 'trash' ? subgroupsOf(rows, def.key) : null };
  });
  const order: Record<string, number> = { label_todo: 0, archive: 1, trash: 2, leave: 3 };
  const reviewed = items.filter((i) => i.review_kind).sort((a, b) =>
    (order[a.review_final_disposition ?? a.review_disposition ?? 'leave'] ?? 9) - (order[b.review_final_disposition ?? b.review_disposition ?? 'leave'] ?? 9) || a.id.localeCompare(b.id));
  return { sections, reviewed };
}

// ── Row text ────────────────────────────────────────────────────────────────

export function parseSender(from: string): { name: string; address: string; via: string | null } {
  const match = from.match(/^\s*(?:"([^"]*)"|([^<]*?))\s*<([^>]+)>\s*$/);
  let name = (match ? match[1] ?? match[2] : '').trim();
  const address = (match ? match[3] : from).trim();
  let via: string | null = null;
  const list = name.match(/^'?(.+?)'? via (.+)$/);
  const service = name.match(/^(.+?) \((?:via )?([^)]+)\)$/);
  if (list) [name, via] = [list[1], list[2]];
  else if (service) [name, via] = [service[1], service[2]];
  name = name.replace(/^['"]+|['"]+$/g, '').trim();
  return { name: name || address, address, via };
}

const GREETING = /^(?:hi|hello|hey|dear|greetings|hei|moi|moikka|terve|hyvä)\b[^,.!:\n]{0,40}[,.!:]\s*/i;

/** A one-line preview: drops link placeholders, a repeated subject and the greeting. */
export function snippet(body: string, subject: string): string {
  // Link placeholders and the bracket debris HTML-to-text leaves behind ("[ [Miro] ](").
  let text = body.replace(/\[link:[^\]]*\]/g, ' ').replace(/(?:[[\]()]\s*){2,}/g, ' ').replace(/\s+/g, ' ').trim();
  text = text.replace(/^email preview\s*/i, '');
  const s = subject.trim().toLowerCase();
  if (s && text.toLowerCase().startsWith(s)) text = text.slice(s.length).replace(/^[\s:–—-]+/, '');
  return text.replace(GREETING, '').slice(0, 240);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

export function formatWhen(time: number, now = new Date()): string {
  const d = new Date(time);
  if (!Number.isFinite(time)) return '';
  const pad = (n: number) => String(n).padStart(2, '0');
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(now) - startOfDay(d)) / 86_400_000);
  if (days === 0) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (days === 1) return 'Yesterday';
  if (days > 1 && days < 7) return DAYS[d.getDay()];
  return d.getFullYear() === now.getFullYear() ? `${d.getDate()} ${MONTHS[d.getMonth()]}` : `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`;
}

const GAP_LABEL: Record<string, string> = {
  'more body': 'Body incomplete', conversation: 'Needs thread context', attachment: 'Attachment not read', 'user context': 'Needs your context'
};
const UNRESOLVED_LABEL: Record<string, string> = {
  'Assessment unavailable': 'Not assessed',
  'Message content incomplete': 'Incomplete',
  'Attention unclear': 'Needs you?',
  'Attention handling conflicted': 'Needs you?',
  'Sales request or personal obligation?': 'Sales or request?',
  'Retention unclear': 'Keep or not?',
  'Retention conflicted': 'Keep or not?',
  'Inspect omitted content before clearing': 'Clipped'
};

const UNRESOLVED_SENTENCE: Record<string, string> = {
  'Assessment unavailable': 'Jev could not assess this thread',
  'Message content incomplete': 'Part of this message could not be read',
  'Attention unclear': 'Jev cannot tell whether this needs you',
  'Attention handling conflicted': 'Jev is split on whether this needs you',
  'Sales request or personal obligation?': 'This may be a sales pitch rather than a real request',
  'Retention unclear': 'Jev cannot tell whether this is worth keeping',
  'Retention conflicted': 'Jev cannot tell whether this is worth keeping',
  'Inspect omitted content before clearing': 'Part of the message was clipped, so check it before clearing'
};

/** Plain-language reason an unresolved row needs a person. */
export function reasonSentence(item: ReviewItem): string {
  const gap = item.reason.match(/^Needs (.+)$/)?.[1];
  return UNRESOLVED_SENTENCE[item.reason] ?? (gap ? `Missing evidence: ${gap}` : item.reason);
}

/** Short tags explaining a row beyond its section; empty for the ordinary case. */
export function rowTags(item: ReviewItem, section: SectionKey): { text: string; tone: 'warn' | 'time' | 'muted'; title?: string }[] {
  const tags: { text: string; tone: 'warn' | 'time' | 'muted'; title?: string }[] = [];
  if (item.status === 'unresolved') {
    const gap = item.reason.match(/^Needs (.+)$/)?.[1];
    tags.push({ text: UNRESOLVED_LABEL[item.reason] ?? (gap ? GAP_LABEL[gap] ?? item.reason : item.reason), tone: 'warn', title: item.error ? `${item.reason}: ${item.error}` : item.reason });
  } else {
    const gap = item.reason.match(/· needs (.+)$/)?.[1];
    if (gap) tags.push({ text: GAP_LABEL[gap] ?? `Needs ${gap}`, tone: 'warn', title: item.reason });
  }
  const u = item.answers?.urgency.score ?? 0;
  if (section !== 'archive' && section !== 'trash' && item.answers?.attention.choice !== 'none') {
    if (u >= 2.25) tags.push({ text: 'Urgent', tone: 'time', title: `Urgency ${u.toFixed(1)} of 3` });
    else if (u >= 1.5) tags.push({ text: 'Soon', tone: 'time', title: `Urgency ${u.toFixed(1)} of 3` });
  }
  return tags;
}

export function percent(p: number): string {
  return `${Math.round(p * 100)}%`;
}
