import sanitize from 'sanitize-html';
import type { PreparedMessage, Representation } from '$lib/types/v3';

export const REPRESENTATION_VERSION = 1;
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
  body = body.replace(/\r\n/g, '\n').replace(/[\t ]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  // Only strip unmistakable quoted tails; retain uncertain multilingual content.
  const quote = body.search(/\n(?:On .{8,160} wrote:|-----Original Message-----|From: .{3,100}\nSent:)/i);
  if (quote >= 0) body = body.slice(0, quote).trim();
  const originalChars = body.length;
  const clipped = body.length > bodyBudget;
  if (clipped) body = `${body.slice(0, Math.floor(bodyBudget * .7))}\n[…middle omitted…]\n${body.slice(-Math.floor(bodyBudget * .3))}`;
  return {
    id: String(message.id ?? ''), from: headers.from ?? '', to: headers.to ?? '', cc: headers.cc ?? '',
    replyTo: headers['reply-to'] ?? '', deliveredTo: headers['delivered-to'] ?? '',
    subject: headers.subject ?? '', date: headers.date || new Date(Number(message.internalDate) || Date.now()).toISOString(), labels: message.labelIds ?? [],
    body, originalChars, retainedChars: body.length, clipped,
    missingBody: !plain && !html,
    attachmentsNotRead: parts.some((p) => p.filename),
    hasUnsubscribe: Boolean(headers['list-unsubscribe']),
    isCalendarInvite: parts.some((p) => p.mimeType === 'text/calendar') || /^(invitation|updated invitation|accepted|declined):/i.test(headers.subject ?? ''),
    attachments: parts.filter((p) => p.filename).slice(0, 20).map((p) => ({ name: String(p.filename).slice(0, 180), mime: String(p.mimeType ?? '') })),
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
  return { version: 1, threadId, messageIds: selected, omittedUnread: Math.max(0, messageIds.length - selected.length), historyNotFetched: true, messages, unavailable };
}

export function representationHasGap(rep: Representation): boolean {
  return rep.messages.length === 0 || rep.unavailable.length > 0 || rep.omittedUnread > 0 || rep.messages.some((m) => m.missingBody);
}
