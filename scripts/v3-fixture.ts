/** Safe local preview data. Never uses Gmail or the live database. */
import { Database } from 'bun:sqlite';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { prepareThread } from '../src/lib/server/v3/representation';
import { resolveHandling, V3_MODEL, RUBRIC_VERSION } from '../src/lib/server/v3/assessment';
import { ensureAccountSetup } from '../src/lib/server/v3/settings';
import { adoptLibraryRecipe, firstMatch, listRecipes } from '../src/lib/server/v3/recipes';
import { saveRuleAssessment } from '../src/lib/server/v3/deterministic';
import type { Assessment, Attention, Category, Gap, Retention } from '../src/lib/types/v3';

const CATEGORIES = ['sales','notification','newsletter','transaction','conversation','other'] as const;
const ATTENTION = ['act','read','glance','none','unclear'] as const;
const RETENTION = ['keep','disposable','unclear'] as const;
const GAPS = ['sufficient','more_body','conversation','attachment','user_context'] as const;

const path = process.argv[2] || '/tmp/mailward-v3-fixture.db';
const sqlite = new Database(path, { create: true });
migrate(drizzle(sqlite), { migrationsFolder: 'drizzle' });
const account = 'fixture@example.test';
sqlite.query('INSERT OR IGNORE INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run(account,'fixture','fixture',Date.now()+86400000);
const runId = crypto.randomUUID();
sqlite.query('INSERT INTO runs (id,account_id,started_at,ended_at,scope,status) VALUES (?,?,?,?,?,?)').run(runId,account,Date.now(),Date.now(),'v3','completed');
// The fixture account uses the starter guidance and recipes; a second account
// has no policy yet, to preview the setup flow.
const policyId = ensureAccountSetup(sqlite, account).id;
if (!listRecipes(sqlite, account).some((r) => r.key === 'stripe-receipts')) adoptLibraryRecipe(sqlite, account, 'stripe-receipts', 'fixture');
sqlite.query('INSERT OR IGNORE INTO tokens (id,access_token,refresh_token,expires_at) VALUES (?,?,?,?)').run('new@example.test','fixture','fixture',Date.now()+86400000);
/** A full distribution leaning `conf` towards `choice`, the rest spread evenly, as Jev returns. */
function dist<T extends string>(options: readonly T[], choice: T, conf = .9) {
  const rest = (1 - conf) / (options.length - 1);
  return Object.fromEntries(options.map((o) => [o, o === choice ? conf : rest])) as Record<T, number>;
}
const answer = <T extends string>(options: readonly T[], choice: T, conf = .9) => ({ type: 'choice' as const, choice, confidence: conf, probabilities: dist(options, choice, conf) });
const score = (n: number) => ({ type: 'score' as const, score: n, confidence: .9, probabilities: dist(['0','1','2','3'], String(n)) });
type Example = [subject: string, body: string, from: string, category: Category, attention: Attention, retention: Retention, urgency: number, relevance: number, hoursAgo: number, gap?: Gap];
// A plausible morning inbox: one or two rows per section, cleanup grouped by category.
const examples: Example[] = [
  ['Contract renewal — can you confirm by Friday?','Hi! Our agreement renews on the 1st. Could you confirm the updated seat count by Friday so legal can send the final version?\n\nThanks, Maria','Maria Lindqvist <maria@northwind.test>','conversation','act','keep',3,3,1],
  ['Invoice INV-20931 for September','Please find attached invoice INV-20931 (€1,240.00), due 16 October.','Harbor Supplies <billing@harbor-supplies.test>','transaction','act','keep',2,2,3],
  ['Quick review of the onboarding doc?','I rewrote the first-week checklist. Could you skim it before Thursday’s session and leave comments?','Sam Patel <sam@yourteam.test>','conversation','act','keep',2,3,5],
  ['Agents that check their own work','This week: why self-verification beats bigger prompts, and three patterns from production teams.','Lumen Weekly <digest@lumen.test>','newsletter','read','disposable',0,3,7],
  ['Reminder: 2 expense reports awaiting approval','You have 2 expense reports waiting. Approvals are handled in the HR portal.','HR Portal <noreply@hrportal.test>','notification','glance','disposable',1,1,9],
  ['See attached','Here you go.','Jordan Kim <jordan@partner.test>','other','unclear','unclear',1,1,10,'attachment'],
  ['Your monthly statement is ready','Your September statement for account ending 0042 is now available in online banking.','Fjord Bank <alerts@fjordbank.test>','transaction','none','keep',0,1,12],
  ['Itinerary: Helsinki → Berlin, 14 Oct','Booking ABX42Q confirmed. Departure 08:05, seat 12C.','Travel Desk <trips@traveldesk.test>','transaction','none','keep',0,2,14],
  ['Weekly uptime summary','All 14 monitors healthy. Average response time 182 ms.','Status Bot <status@uptime.test>','notification','none','disposable',0,0,16],
  ['Build passed: main #4812','All checks passed in 6m 12s.','CI <ci@builds.test>','notification','none','disposable',0,0,17],
  ['Webinar: scaling your data stack','Join our product team live next Tuesday for a 45-minute deep dive.','CloudCo Events <events@cloudco.test>','sales','none','disposable',0,0,20],
  ['Your trial ends soon — 30% off annual plans','Upgrade before Sunday and keep every feature.','Spark CRM <hello@sparkcrm.test>','sales','none','disposable',0,0,22]
];
for (const [subject, body, from, category, attention, retention, urgency, relevance, hoursAgo, gap = 'sufficient'] of examples) {
  const at = Date.now() - hoursAgo * 3600_000;
  const id = crypto.randomUUID(); const mid = crypto.randomUUID();
  const message = { id: mid, labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'text/plain', headers: [
    { name: 'From', value: from }, { name: 'To', value: account }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date(at).toUTCString() }
  ], body: { data: Buffer.from(body).toString('base64url') } } };
  const rep = prepareThread(id,[mid],new Map([[mid,message]]));
  const assessment: Assessment = { category: answer(CATEGORIES, category), attention: answer(ATTENTION, attention, attention === 'unclear' ? .4 : .9),
    retention: answer(RETENTION, retention), urgency: score(urgency), relevance: score(relevance), gap: answer(GAPS, gap) };
  const handling = resolveHandling(assessment,rep);
  sqlite.query(`INSERT INTO threads (id,account_id,"from",from_domain,"to",subject,snippet,received_at,is_unread,label_ids,message_ids,synced_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(id,account,from,from.split('@')[1].replace('>',''),account,subject,body,at,JSON.stringify(['INBOX','UNREAD']),JSON.stringify([mid]),Date.now());
  const aid = crypto.randomUUID();
  sqlite.query(`INSERT INTO v3_assessments (id,account_id,thread_id,input_key,policy_id,rubric_version,model,actual_model,representation,answers,proposed_action,final_action,lane,reason,priority,status,created_at)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(aid,account,id,mid,policyId,1,V3_MODEL,V3_MODEL,JSON.stringify(rep),JSON.stringify(assessment),handling.action,handling.finalAction,handling.lane,handling.reason,handling.priority,handling.status,Date.now());
  sqlite.query('INSERT INTO v3_run_items VALUES (?,?)').run(runId,aid);
}
// Recipe matches skip Jev, as in a real run.
const recipes = listRecipes(sqlite, account, true);
const ruleMail: [string, string, string][] = [
  ['Alex Doe <alex@northwind.test>', 'Accepted: Planning @ Thu', 'Alex Doe has accepted this invitation.\n\nPlanning\n\nInvitation from Google Calendar'],
  ['Acme <receipts+x@stripe.com>', 'Your receipt from Acme #2041-3317', 'Amount paid €24.00. Thanks for your business.']
];
for (const [from, subject, body] of ruleMail) {
  const id = crypto.randomUUID(); const mid = crypto.randomUUID();
  const message = { id: mid, labelIds: ['INBOX','UNREAD'], payload: { mimeType: 'multipart/mixed', headers: [
    { name: 'From', value: from }, { name: 'To', value: account }, { name: 'Subject', value: subject }, { name: 'Date', value: new Date().toUTCString() }
  ], parts: [{ mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } }, ...(subject.startsWith('Accepted') ? [{ mimeType: 'text/calendar', filename: 'invite.ics', body: { attachmentId: 'ics' } }] : [])] } };
  const rep = prepareThread(id,[mid],new Map([[mid,message]]));
  const recipe = firstMatch(recipes, rep);
  if (!recipe) { console.warn(`No recipe matched fixture “${subject}”`); continue; }
  sqlite.query(`INSERT INTO threads (id,account_id,"from",from_domain,"to",subject,snippet,received_at,is_unread,label_ids,message_ids,synced_at)
    VALUES (?,?,?,?,?,?,?,?,1,?,?,?)`).run(id,account,from,from.split('@')[1].replace('>',''),account,subject,body,Date.now(),JSON.stringify(['INBOX','UNREAD']),JSON.stringify([mid]),Date.now());
  saveRuleAssessment(sqlite, account, runId, policyId, RUBRIC_VERSION, rep, mid, recipe);
}
sqlite.close();
console.log(`Fixture ready at ${path}`);
