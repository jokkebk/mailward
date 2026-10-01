export interface EmailContent {
	html: string | null;
	text: string | null;
}

export function extractBody(payload: any): EmailContent {
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
