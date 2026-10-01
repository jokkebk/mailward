import { describe, expect, test } from 'bun:test';
import type { Assessment, Category, ReviewItem } from '../src/lib/types/v3';
import { buildSections, decide, formatWhen, kindFor, needsSeen, parseSender, snippet, suggestionOf, tier } from '../src/lib/v3/review';

const choice = <T extends string>(value: T, options: T[], p?: Partial<Record<T, number>>) => ({
  type: 'choice' as const, choice: value, confidence: .9,
  probabilities: Object.fromEntries(options.map((o) => [o, p?.[o] ?? (o === value ? 1 : 0)])) as Record<T, number>
});
const score = (value: number) => ({ type: 'score' as const, score: value, confidence: 1, probabilities: { 0: 0, 1: 0, 2: 0, 3: 0 } });
function answers(category: Category, urgency: number, relevance: number, attention: Partial<Record<'act' | 'read' | 'glance' | 'none' | 'unclear', number>> = { none: 1 }, retention: 'keep' | 'disposable' = 'disposable'): Assessment {
  const top = Object.entries(attention).sort((a, b) => b[1]! - a[1]!)[0][0] as 'none';
  return {
    category: choice(category, ['sales', 'notification', 'newsletter', 'transaction', 'conversation', 'other']),
    attention: choice(top, ['act', 'read', 'glance', 'none', 'unclear'], attention),
    retention: choice(retention, ['keep', 'disposable', 'unclear']),
    urgency: score(urgency), relevance: score(relevance),
    gap: choice('sufficient', ['sufficient', 'more_body', 'conversation', 'attachment', 'user_context'])
  };
}
let n = 0;
function item(overrides: Partial<ReviewItem>): ReviewItem {
  n++;
  return {
    id: `a${String(n).padStart(2, '0')}`, thread_id: `t${n}`, representation: {
      version: 3, threadId: `t${n}`, messageIds: [`m${n}`], omittedUnread: 0, historyNotFetched: true, unavailable: [],
      messages: [{ id: `m${n}`, from: 'x@example.test', subject: 'S', date: `Tue, 29 Sep 2026 0${n % 10}:00:00 +0000`, body: '' } as any]
    },
    answers: null, proposed_action: 'trash', final_action: 'trash', lane: 'cleanup', reason: '', priority: 0, status: 'ready',
    error: null, created_at: 0, review_kind: null, review_disposition: null, review_action_id: null,
    execution_status: null, action_status: null, review_error: null, ...overrides
  };
}

describe('single review page model', () => {
  test('every live item lands in exactly one section; reviewed items become receipts', () => {
    const items = [
      item({ lane: 'needs_action', proposed_action: 'label_todo' }), item({ lane: 'worth_reading', proposed_action: 'label_todo' }),
      item({ lane: 'decision', proposed_action: 'leave', status: 'unresolved' }), item({ lane: 'show_me', proposed_action: 'leave' }),
      item({ proposed_action: 'archive', final_action: 'archive' }), item({}), item({ review_kind: 'approve', review_disposition: 'trash' })
    ];
    const { sections, reviewed } = buildSections(items);
    expect(sections.map((s) => [s.def.key, s.rows.length])).toEqual([
      ['needs_action', 1], ['worth_reading', 1], ['decision', 1], ['show_me', 1], ['archive', 1], ['trash', 1]
    ]);
    expect(reviewed).toHaveLength(1);
  });

  test('trash groups by Jev category, ordered by their most important member, rules last', () => {
    const items = [
      item({ answers: answers('sales', 0, .2) }),
      item({ assessment_source: 'rule', deterministic_rule: 'calendar-rsvp', deterministic_version: 1 }),
      item({ answers: answers('notification', 0, .3) }),
      item({ answers: answers('notification', 1.2, .7) }),
      item({ answers: answers('sales', .2, .8) })
    ];
    const trash = buildSections(items).sections.find((s) => s.def.key === 'trash')!;
    expect(trash.groups!.map((g) => [g.title, g.rows.length])).toEqual([['Notifications', 2], ['Sales & promotions', 2], ['Calendar replies', 1]]);
    expect(trash.groups![0].rows[0].answers!.urgency.score).toBe(1.2);
    expect(trash.groups![2].hint).toContain('recipe v1');
  });

  test('obligations sort by urgency, worthwhile reading by relevance', () => {
    const urgent = item({ lane: 'needs_action', proposed_action: 'label_todo', answers: answers('notification', 2.5, 1) });
    const relevant = item({ lane: 'needs_action', proposed_action: 'label_todo', answers: answers('notification', 1, 3) });
    const read = [urgent, relevant].map((i) => ({ ...i, id: `r${i.id}`, lane: 'worth_reading' as const }));
    const { sections } = buildSections([relevant, urgent, ...read]);
    expect(sections[0].rows.map((r) => r.id)).toEqual([urgent.id, relevant.id]);
    expect(sections[1].rows.map((r) => r.id)).toEqual([`r${relevant.id}`, `r${urgent.id}`]);
    expect(tier(urgent, 'needs_action')).toBe(3);
    expect(tier(item({}), 'trash')).toBe(0);
  });

  test('show-before-clearing suggests its after-viewing action and approves it', () => {
    const reminder = item({ lane: 'show_me', proposed_action: 'leave', final_action: 'trash' });
    expect(suggestionOf(reminder)).toEqual({ choice: 'trash', firm: true });
    expect(kindFor(reminder, 'trash')).toBe('approve');
    expect(kindFor(reminder, 'archive')).toBe('correct');
    expect(needsSeen(reminder, decide(reminder, 'trash'))).toBe(true);
    expect(needsSeen(reminder, decide(reminder, 'archive'))).toBe(false);
  });

  test('unresolved rows show a non-binding leaning and never count as approval', () => {
    const unsure = item({ lane: 'decision', proposed_action: 'leave', final_action: 'leave', status: 'unresolved', answers: answers('conversation', 1, 2, { act: .3, none: .6, unclear: .1 }, 'keep') });
    expect(suggestionOf(unsure)).toEqual({ choice: 'archive', firm: false });
    expect(kindFor(unsure, 'archive')).toBe('correct');
    expect(suggestionOf(item({ status: 'unresolved', answers: answers('other', 0, 0, { unclear: .7, none: .3 }) }))).toBeNull();
  });

  test('done keeps feedback and defaults to the intended final handling', () => {
    const todo = item({ lane: 'needs_action', proposed_action: 'label_todo', final_action: 'archive' });
    const approved = decide(todo, 'label_todo');
    expect(approved.kind).toBe('approve');
    const done = decide(todo, 'done', { ...approved, chip: 'already_handled', note: 'paid' });
    expect(done).toEqual({ assessmentId: todo.id, kind: 'done', disposition: 'leave', finalDisposition: 'archive', chip: 'already_handled', note: 'paid' });
    expect(decide(todo, 'leave').kind).toBe('skip');
  });

  test('sender and snippet cleanup', () => {
    expect(parseSender(`"'Amazon Web Services' via Devteam" <devs@acme.test>`)).toEqual({ name: 'Amazon Web Services', address: 'devs@acme.test', via: 'Devteam' });
    expect(parseSender('"Eetu Paloheimo (via Google Slides)" <drive@google.com>').via).toBe('Google Slides');
    expect(parseSender('support@expenses.test').name).toBe('support@expenses.test');
    expect(snippet('Email Preview \n Users will be deactivated \n\n Hi Alex Example, \n The following users [link: x.com/a] go', 'Users will be deactivated')).toBe('The following users go');
    expect(snippet('Hi,\n9 members are at their spend limit.', 'x')).toBe('9 members are at their spend limit.');
  });

  test('dates read like a mail client', () => {
    const now = new Date(2026, 8, 30, 18, 0);
    expect(formatWhen(new Date(2026, 8, 30, 9, 5).getTime(), now)).toBe('09:05');
    expect(formatWhen(new Date(2026, 8, 29, 9, 5).getTime(), now)).toBe('Yesterday');
    expect(formatWhen(new Date(2026, 8, 27, 9, 5).getTime(), now)).toBe('Sun');
    expect(formatWhen(new Date(2026, 7, 3).getTime(), now)).toBe('3 Aug');
  });
});
