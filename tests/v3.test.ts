import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareMessage, prepareThread, representationHasGap } from '../src/lib/server/v3/representation';
import { buildAssessmentRequest, parseAssessment, resolveHandling } from '../src/lib/server/v3/assessment';
import { getOrCreatePolicy } from '../src/lib/server/v3/policy';
import { sanitizeHtml } from '../src/lib/server/gmail/sanitize';

const b64 = (s: string) => Buffer.from(s).toString('base64url');
function message(id: string, body: string, mime = 'text/plain') {
  return { id, labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'multipart/alternative', headers: [
    { name: 'From', value: 'Person <a@example.test>' }, { name: 'To', value: 'me@example.test' },
    { name: 'Subject', value: 'A request' }, { name: 'Date', value: 'Tue, 29 Sep 2026 09:00:00 +0300' }
  ], parts: [{ mimeType: mime, body: { data: b64(body) } }] } };
}
const choice = (value: string, options: string[]) => ({ type: 'choice', choice: value, confidence: .9, probabilities: Object.fromEntries(options.map((o) => [o, o === value ? 1 : 0])) });
const score = (value: number) => ({ type: 'score', score: value, confidence: 1, probabilities: Object.fromEntries([0,1,2,3].map((i) => [String(i), i === value ? 1 : 0])) });

describe('v3 content and handling', () => {
  test('selects plain alternative, preserves multiple unread requests, and exposes omissions', () => {
    const first = message('m1', 'Please approve this\n\nRegards');
    first.payload.parts.push({ mimeType: 'text/html', body: { data: b64('<script>alert(1)</script>different') } } as any);
    const fetched = new Map<string, any>([['m1', first], ['m2', message('m2', 'Please reply to me')]]);
    const rep = prepareThread('t', ['m1','m2','m3','m4','m5'], fetched);
    expect(rep.messages.map((m) => m.body)).toEqual(['Please approve this\n\nRegards','Please reply to me']);
    expect(rep.unavailable).toEqual(['m3','m4']);
    expect(rep.omittedUnread).toBe(1);
    expect(representationHasGap(rep)).toBe(true);
  });
  test('bounds body from both ends and omits executable markup and unsafe links', () => {
    const html = `<a href="javascript:alert(1)">bad</a><a href="https://example.test/pay?a=1&amp;b=2">Pay receipt</a><img src="https://tracker.test/pixel"><p>Start ${'middle '.repeat(900)} End</p>`;
    const item = prepareMessage(message('m', html, 'text/html'), 300);
    expect(item.body).toContain('Start'); expect(item.body).toContain('End');
    expect(item.body).not.toContain('<img'); expect(item.clipped).toBe(true);
    expect(item.links).toEqual([{ label: 'Pay receipt', url: 'https://example.test/pay?a=1&b=2' }]);
    const safe = sanitizeHtml(html + '<form action="https://evil.test"><input><script>alert(1)</script></form>');
    expect(safe).not.toContain('<img'); expect(safe).not.toContain('javascript:');
    expect(safe).not.toContain('<form'); expect(safe).not.toContain('<script');
  });
  test('bundles all dimensions and maps action versus worthwhile reading', () => {
    const rep = prepareThread('t', ['m1'], new Map([['m1', message('m1', 'Read this')]]));
    const payload = buildAssessmentRequest([rep, rep], 'policy');
    expect(Object.keys(payload.questions)).toHaveLength(12);
    const answers: any = {};
    for (const i of [0, 1]) {
      answers[`t${i}_category`] = choice('newsletter', ['sales','notification','newsletter','transaction','conversation','other']);
      answers[`t${i}_attention`] = choice(i ? 'act' : 'read', ['act','read','glance','none','unclear']);
      answers[`t${i}_retention`] = choice('disposable', ['keep','disposable','unclear']);
      answers[`t${i}_urgency`] = score(1); answers[`t${i}_relevance`] = score(2);
      answers[`t${i}_gap`] = choice('sufficient', ['sufficient','more_body','conversation','attachment','user_context']);
    }
    expect(resolveHandling(parseAssessment(answers, 0), rep).lane).toBe('worth_reading');
    expect(resolveHandling(parseAssessment(answers, 1), rep).lane).toBe('needs_action');
    expect(resolveHandling(parseAssessment(answers, 0), rep).finalAction).toBe('trash');
    answers.t0_attention = choice('none', ['act','read','glance','none','unclear']);
    const clipped = structuredClone(rep);
    clipped.messages[0].clipped = true;
    expect(resolveHandling(parseAssessment(answers, 0), clipped).status).toBe('unresolved');
    answers.t0_attention = choice('unclear', ['act','read','glance','none','unclear']);
    expect(resolveHandling(parseAssessment(answers, 0), rep).status).toBe('unresolved');
    delete answers.t0_retention;
    expect(() => parseAssessment(answers, 0)).toThrow();
  });
  test('additive migration and policy bootstrap leave old tables present', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
    sqlite.query("INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES ('a','x','y',1)").run();
    const policy = getOrCreatePolicy(sqlite, 'a');
    expect(policy.status).toBe('proposed');
    expect(getOrCreatePolicy(sqlite, 'a').id).toBe(policy.id);
    expect(sqlite.query("SELECT name FROM sqlite_master WHERE name = 'actions'").get()).toBeTruthy();
    sqlite.close();
  });
  test('Acme bootstrap gives Jev a policy grounded in existing rules', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
    const account = 'alex@acme.test';
    sqlite.query('INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run(account, 'x', 'y', 1);
    for (const [index, name, action] of [[1, 'Receipts', 'label_todo'], [2, 'Shared developer mailbox cleanup', '["trash","label_todo"]']] as const) {
      sqlite.query('INSERT INTO rules (id,account_id,name,status,current_version_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?)').run(`r${index}`, account, name, 'proposing', `v${index}`, 1, 1);
      sqlite.query('INSERT INTO rule_versions (id,rule_id,version_no,priority,match_criteria,intent,action,tier,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(`v${index}`, `r${index}`, 1, index, '{}', name, action, 'ai', 1);
    }
    const policy = getOrCreatePolicy(sqlite, account);
    const report = JSON.parse(policy.import_report!);
    expect(report.personalized).toBe(true);
    expect(report.sourceRuleCount).toBe(2);
    expect(policy.text).toContain('devs@acme.test');
    expect(policy.text).toContain('receipt');
    const payload = buildAssessmentRequest([], policy.text);
    expect(payload.state.policy).toBe(policy.text);
    sqlite.close();
  });
});
