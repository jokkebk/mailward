import { describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareMessage, prepareThread, representationHasGap, calendarEndTime } from '../src/lib/server/v3/representation';
import { buildAssessmentRequest, parseAssessment, resolveHandling } from '../src/lib/server/v3/assessment';
import { getOrCreatePolicy, createPolicyRevision, STARTER_POLICY } from '../src/lib/server/v3/policy';
import { deterministicHandling } from '../src/lib/server/v3/deterministic';
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
  test('calendar files and inline logos do not hide handling; actual documents do', () => {
    const mail = message('m', 'A routine notification');
    mail.payload.parts.push({ mimeType:'text/calendar', filename:'invite.ics', body:{attachmentId:'calendar'} } as any);
    mail.payload.parts.push({ mimeType:'image/png', filename:'signature.png', body:{attachmentId:'logo'}, headers:[{name:'Content-ID',value:'<logo>'}] } as any);
    expect(prepareMessage(mail).attachmentsNotRead).toBe(false);
    mail.payload.parts.push({ mimeType:'application/pdf', filename:'contract.pdf', body:{attachmentId:'document'} } as any);
    expect(prepareMessage(mail).attachmentsNotRead).toBe(true);
  });
  test('RSVPs differ from human notes; calendar times expose ended events', () => {
    const mail = message('m', 'Alex has accepted this invitation.\n\nPlanning meeting\nOriginal event description: please bring ideas.');
    mail.payload.headers.find((h) => h.name === 'Subject')!.value = 'Accepted: Planning meeting @ Wed Sep 30, 2026 12pm - 1:30pm (EEST) (Alex)';
    mail.payload.parts.push({mimeType:'text/calendar',filename:'invite.ics',body:{attachmentId:'ics'}} as any);
    const rep = prepareThread('t',['m'],new Map([['m',mail]]));
    expect(rep.messages[0].calendar?.responseOnly).toBe(true);
    expect(rep.messages[0].body).not.toContain('please bring');
    expect(calendarEndTime(rep.messages[0].calendar!.eventTime)).toBe('2026-09-30T10:30:00.000Z');
    const payload = buildAssessmentRequest([rep], 'policy', '2026-09-30T18:37:00.000Z');
    expect(payload.state.threads[0].messages[0].calendar?.ended).toBe(true);
    mail.payload.parts[0].body.data = b64('Alex has accepted this invitation.\n\nI need you to confirm the budget.\n\nPlanning meeting');
    const noted = prepareMessage(mail);
    expect(noted.calendar?.responseOnly).not.toBe(true);
    expect(noted.body).toContain('confirm the budget');
    expect(calendarEndTime('Every 2 weeks from 10am to 11am')).toBeNull();
  });
  test('tracking and padding do not clip a complete body; real long content is bounded', () => {
    const body = '\u034f\u200c'.repeat(2000) + 'Please approve access. https://example.test/access?tracking=' + 'x'.repeat(5000);
    const prepared = prepareMessage(message('m', body), 300);
    expect(prepared.body).toContain('Please approve access');
    expect(prepared.clipped).toBe(false);
    expect(prepared.body).not.toContain('tracking=');
    expect(prepareMessage(message('m', 'Substantive paragraph. '.repeat(500)),300).clipped).toBe(true);
  });
  test('compatible attention choices do not hide TODO; known tasks with gaps remain visible', () => {
    const rep = prepareThread('t',['m'],new Map([['m',message('m','A request')]]));
    const a: any = {category:choice('conversation',['conversation']),attention:{type:'choice',choice:'act',confidence:.12,probabilities:{act:.31,read:.28,none:.29,glance:.1,unclear:.02}},retention:choice('keep',['keep','disposable','unclear']),gap:choice('sufficient',['sufficient']),urgency:score(1),relevance:score(2)};
    expect(resolveHandling(a,rep).action).toBe('label_todo');
    a.category = choice('sales',['sales']);
    expect(resolveHandling(a,rep).status).toBe('unresolved');
    a.category = choice('conversation',['conversation']);
    a.attention.probabilities = {act:.4,read:.03,none:.4,glance:.15,unclear:.02};
    expect(resolveHandling(a,rep).status).toBe('unresolved');
    a.attention = choice('act',['act','read','none','glance','unclear']);
    a.gap = choice('user_context',['sufficient','user_context']);
    expect(resolveHandling(a,rep).lane).toBe('needs_action');
    expect(resolveHandling(a,rep).finalAction).toBe('leave');
    a.attention = choice('glance',['act','read','none','glance','unclear']);a.gap=choice('sufficient',['sufficient']);a.retention=choice('disposable',['keep','disposable','unclear']);
    rep.messages[0].attachmentsNotRead=true;
    expect(resolveHandling(a,rep).status).toBe('unresolved');
  });
  test('deterministic replies exclude notes, documents, missing and mixed messages', () => {
    const mail = message('m', 'Alex has replied "Maybe" to this invitation.\n\nPlanning meeting\nGenerated description');
    mail.payload.headers.find((h) => h.name === 'Subject')!.value = 'Tentatively Accepted: Planning meeting @ Every week';
    mail.payload.parts.push({mimeType:'text/calendar',filename:'invite.ics',body:{attachmentId:'ics'}} as any);
    const rep = prepareThread('t',['m'],new Map([['m',mail]]));
    expect(deterministicHandling(rep)?.action).toBe('trash');
    expect(deterministicHandling(rep)?.status).toBe('ready');
    const note = structuredClone(rep);note.messages[0].calendar!.note = 'Please confirm the budget';
    expect(deterministicHandling(note)).toBeNull();
    const extra = structuredClone(rep);extra.messages.push(prepareMessage(message('new','Please reply')));
    expect(deterministicHandling(extra)).toBeNull();
    const missing = structuredClone(rep);missing.unavailable.push('missing');
    expect(deterministicHandling(missing)).toBeNull();
    const attachment = structuredClone(rep);attachment.messages[0].attachmentsNotRead=true;
    expect(deterministicHandling(attachment)).toBeNull();
    expect(deterministicHandling(prepareThread('fake',['m'],new Map([['m',message('m','Accepted: planning')]])))).toBeNull();
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
  test('new and existing accounts need no v2 tables to select a policy', () => {
    const sqlite = new Database(':memory:');
    migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
    // Prove that policy selection and revision do not depend on retired tables.
    sqlite.exec('DROP TABLE rules; DROP TABLE rule_versions; DROP TABLE verdicts; DROP TABLE actions');
    const account = 'new@example.test';
    sqlite.query('INSERT INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run(account,'x','y',1);
    const policy = getOrCreatePolicy(sqlite,account);
    expect(policy.text).toBe(STARTER_POLICY);
    expect(policy.text).not.toContain('Alex');
    expect(policy.text).not.toContain('Acme');
    expect(JSON.parse(policy.import_report!).source).toBe('v3-starter');
    const revised = createPolicyRevision(sqlite,account,policy.text + '\nPrefer retaining user-specified research references.', 'fixture','Refine preferences');
    expect(revised.version_no).toBe(2);
    expect(getOrCreatePolicy(sqlite,account).id).toBe(revised.id);
    expect(getOrCreatePolicy(sqlite,account).text).toBe(revised.text);
    sqlite.close();
  });
});
