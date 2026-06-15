import { getGmailClient } from './client';
import sanitize from 'sanitize-html';

export interface EmailContent {
	html: string | null;
	text: string | null;
}

export async function fetchEmailContent(accountId: string, messageId: string): Promise<EmailContent> {
	const gmail = await getGmailClient(accountId);
	const response = await gmail.users.messages.get({
		userId: 'me',
		id: messageId,
		format: 'full'
	});

	return extractBody(response.data.payload);
}

function extractBody(payload: any): EmailContent {
	let html: string | null = null;
	let text: string | null = null;

	function walk(part: any) {
		if (!part) return;
		if (part.mimeType === 'text/html' && part.body?.data) {
			html = decodeBase64Url(part.body.data);
		} else if (part.mimeType === 'text/plain' && part.body?.data) {
			text = decodeBase64Url(part.body.data);
		}
		if (part.parts) {
			for (const sub of part.parts) walk(sub);
		}
	}

	walk(payload);
	return { html, text };
}

function decodeBase64Url(data: string): string {
	const base64 = data.replace(/-/g, '+').replace(/_/g, '/');
	return Buffer.from(base64, 'base64').toString('utf-8');
}

export function sanitizeHtml(html: string): string {
	return sanitize(html, {
		allowedTags: sanitize.defaults.allowedTags.concat(['img', 'span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'center', 'font']),
		allowedAttributes: {
			...sanitize.defaults.allowedAttributes,
			'*': ['style', 'class', 'id', 'width', 'height', 'align', 'valign', 'bgcolor', 'color'],
			'img': ['src', 'alt', 'width', 'height', 'style'],
			'a': ['href', 'target', 'rel', 'style'],
			'td': ['colspan', 'rowspan', 'width', 'height', 'style', 'align', 'valign', 'bgcolor'],
			'th': ['colspan', 'rowspan', 'width', 'height', 'style', 'align', 'valign'],
			'table': ['width', 'cellpadding', 'cellspacing', 'border', 'style', 'align', 'bgcolor'],
			'font': ['color', 'size', 'face']
		},
		allowedSchemes: ['http', 'https', 'mailto', 'data'],
		transformTags: {
			'a': sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' })
		}
	});
}
