import sanitize from 'sanitize-html';
import type { PreparedMessage, Representation } from '$lib/types/v3';

export const REPRESENTATION_VERSION = 3;
export const DEFAULT_BODY_BUDGET = 5400;
const MAX_UNREAD_MESSAGES = 4;
const MAX_LINKS = 12;

function decode(data: string | undefined): string {
  if (!data) return '';
  try { return Buffer.from(data, 'base64url').toString('utf8'); } catch { return ''; }
}

function headersOf(message: any): Record<string, string> {
  return Object.fromEntries((message.payload?.headers ?? []).map((h: any) => [String(h.name).toLowerCase(), String(h.value ?? '')]));
}

function partsOf(part: any): any[] {
  if (!part) return [];
  return [part, ...(part.parts ?? []).flatMap(partsOf)];
}

function safeUrl(value: string): string | null {
  try {
    const url = new URL(value);
    return ['https:', 'http:', 'mailto:'].includes(url.protocol) ? url.href : null;
  } catch { return null; }
}

// Parse only the explicit Google Calendar English date/time format with an
// unambiguous timezone. Recurring events and unfamiliar formats stay unknown.
export function calendarEndTime(value: string | null): string | null {
  const match = value?.match(/^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) ([A-Z][a-z]{2}) (\d{1,2}), (\d{4}) .+? - (\d{1,2})(?::(\d{2}))?(am|pm) \((EET|EEST|UTC|GMT)\)/);
  if (!match) return null;
  const month = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'].indexOf(match[1]);
  const hour = Number(match[4]) % 12 + (match[6] === 'pm' ? 12 : 0);
  const offset = match[7] === 'EEST' ? 3 : match[7] === 'EET' ? 2 : 0;
  if (month < 0 || Number(match[4]) < 1 || Number(match[4]) > 12 || Number(match[5] ?? 0) > 59 || Number(match[2]) > 31) return null;
  return new Date(Date.UTC(Number(match[3]), month, Number(match[2]), hour - offset, Number(match[5] ?? 0))).toISOString();
}

export function prepareMessage(message: any, bodyBudget = DEFAULT_BODY_BUDGET): PreparedMessage {
  const headers = headersOf(message);
  const parts = partsOf(message.payload);
  const plain = parts.find((p) => !p.filename && p.mimeType?.toLowerCase() === 'text/plain' && p.body?.data);
  const html = parts.find((p) => !p.filename && p.mimeType?.toLowerCase() === 'text/html' && p.body?.data);
  const htmlText = html ? decode(html.body.data) : '';
  const links: PreparedMessage['links'] = [];
  if (htmlText) {
    for (const match of htmlText.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const url = safeUrl(match[1].replace(/&amp;/g, '&'));
      if (url && links.length < MAX_LINKS) links.push({ label: sanitize(match[2], { allowedTags: [], allowedAttributes: {} }).trim().slice(0, 100), url: url.slice(0, 500) });
    }
  }
  let body = plain ? decode(plain.body.data) : htmlText ? sanitize(htmlText.replace(/<br\s*\/?>/gi, '\n').replace(/<\/(p|div|li|tr)>/gi, '\n</$1>'), { allowedTags: [], allowedAttributes: {} }) : '';
  // Tracking URLs and invisible preheader padding are not message content.
  // Keep destinations separately, with domain/path cues in readable text.
  body = body.replace(/[\u034f\u200b-\u200d\u2060\ufeff]/g, '').replace(/https?:\/\/[^\s<>]+/gi, (raw) => {
    if (links.length < MAX_LINKS && !links.some((l) => l.url === raw.slice(0, 500))) links.push({ label: '', url: raw.slice(0, 500) });
    try { const url = new URL(raw); return `[link: ${url.hostname}${url.pathname.slice(0, 100)}]`; } catch { return '[link]'; }
  });
  body = body.replace(/\r\n/g, '\n').replace(/[\t \u00a0]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Only strip unmistakable quoted tails; retain uncertain multilingual content.
  const quote = body.search(/\n(?:On .{8,160} wrote:|-----Original Message-----|From: .{3,100}\nSent:)/i);
  if (quote >= 0) body = body.slice(0, quote).trim();
  const calendarPart = parts.some((p) => /^(text\/calendar|application\/ics)$/i.test(p.mimeType ?? ''));
  const isCalendarInvite = calendarPart || /^(invitation|updated invitation(?: with note)?|accepted|tentatively accepted|declined):/i.test(headers.subject ?? '');
  let calendar: PreparedMessage['calendar'];
  if (isCalendarInvite) {
    const subject = headers.subject ?? '';
    const kind = /^(accepted|tentatively accepted|declined):/i.test(subject) ? 'response' : /^updated invitation/i.test(subject) ? 'update' : /^invitation:/i.test(subject) ? 'invitation' : 'other';
    const noteMatch = body.match(/(?:updated with a note:|has (?:accepted|declined|tentatively accepted) this invitation with a note:)\s*["“]([\s\S]*?)["”]/i);
    calendar = { kind, eventTime: subject.includes(' @ ') ? subject.split(' @ ').slice(1).join(' @ ') : null, note: noteMatch?.[1] ?? null, generatedDescription: calendarPart };
    calendar.endsAt = calendarEndTime(calendar.eventTime);
    // Remove generated recipient roster/footer, retaining human notes,
    // event description, organizer, and optional-attendance information.
    if (calendarPart) body = body.replace(/\nGuests\n[\s\S]*?(?=\nView all guest info)/i, '\n[Calendar guest list omitted]')
      .replace(/\n~~\/\/~~[\s\S]*$/, '').trim();
  }
  if (calendar?.kind === 'response' && calendarPart && !calendar.note) {
    const paragraphs = body.split(/\n\s*\n/);
    const eventTitle = (headers.subject ?? '').replace(/^[^:]+:\s*/, '').split(' @ ')[0].trim().replace(/[–—]/g, '-');
    // Recognize only a bare generated RSVP followed immediately by the event
    // title. A human note between them prevents this reduction.
    if (/ has (?:(?:accepted|declined|tentatively accepted) this invitation|replied "Maybe" to this invitation)\.$/i.test(paragraphs[0]) && paragraphs[1]?.split('\n')[0].trim().replace(/[–—]/g, '-') === eventTitle) {
      calendar.responseOnly = true;
      const organizer = body.match(/\nOrganizer\n([^\n]+)(?:\n([^\n]+))?/i);
      body = `${paragraphs[0]}\n\nEvent: ${eventTitle}\nTime: ${calendar.eventTime ?? 'unknown'}${organizer ? `\nOrganizer: ${organizer[1]} ${organizer[2] ?? ''}` : ''}\n[Generated event description omitted; this response has no human note.]`;
    }
  }
  const attachments = parts.filter((p) => p.filename).map((p) => {
    const h = Object.fromEntries((p.headers ?? []).map((v: any) => [String(v.name).toLowerCase(), String(v.value)])) as Record<string, string>;
    const inline = /^inline\b/i.test(h['content-disposition'] ?? '') || (!!h['content-id'] && /^image\//i.test(p.mimeType ?? ''));
    const calendar = /^(text\/calendar|application\/ics)$/i.test(p.mimeType ?? '') || /\.ics$/i.test(p.filename ?? '');
    return { name: String(p.filename).slice(0, 180), mime: String(p.mimeType ?? ''), inline, calendar };
  });
  const originalChars = body.length;
  const clipped = body.length > bodyBudget;
  if (clipped) body = `${body.slice(0, Math.floor(bodyBudget * .7))}\n[…middle omitted…]\n${body.slice(-Math.floor(bodyBudget * .3))}`;
  return {
    id: String(message.id ?? ''), from: headers.from ?? '', to: headers.to ?? '', cc: headers.cc ?? '',
    replyTo: headers['reply-to'] ?? '', deliveredTo: headers['delivered-to'] ?? '',
    subject: headers.subject ?? '', date: headers.date || new Date(Number(message.internalDate) || Date.now()).toISOString(), labels: message.labelIds ?? [],
    body, originalChars, retainedChars: body.length, clipped,
    missingBody: !plain && !html,
    attachmentsNotRead: attachments.some((a) => !a.inline && !a.calendar),
    hasUnsubscribe: Boolean(headers['list-unsubscribe']),
    isCalendarInvite, calendar, attachments: attachments.slice(0, 20),
    links
  };
}

export function prepareThread(threadId: string, messageIds: string[], fetched: Map<string, any | Error>, bodyBudget = DEFAULT_BODY_BUDGET): Representation {
  const selected = messageIds.slice(0, MAX_UNREAD_MESSAGES);
  const messages: PreparedMessage[] = [];
  const unavailable: string[] = [];
  for (const id of selected) {
    const message = fetched.get(id);
    if (!message || message instanceof Error) { unavailable.push(id); continue; }
    messages.push(prepareMessage(message, Math.max(900, Math.floor(bodyBudget / selected.length))));
  }
  return { version: REPRESENTATION_VERSION, threadId, messageIds: selected, omittedUnread: Math.max(0, messageIds.length - selected.length), historyNotFetched: true, messages, unavailable };
}

export function representationHasGap(rep: Representation): boolean {
  return rep.messages.length === 0 || rep.unavailable.length > 0 || rep.omittedUnread > 0 || rep.messages.some((m) => m.missingBody);
}
