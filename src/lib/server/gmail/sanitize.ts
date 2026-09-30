import sanitize from 'sanitize-html';

/** Restrictive rich-mail view. The iframe also uses sandbox="". */
export function sanitizeHtml(html: string): string {
  return sanitize(html, {
    allowedTags: sanitize.defaults.allowedTags.concat(['span', 'div', 'table', 'thead', 'tbody', 'tr', 'td', 'th', 'center']),
    allowedAttributes: { 'a': ['href', 'target', 'rel'], 'td': ['colspan', 'rowspan'], 'th': ['colspan', 'rowspan'] },
    allowedSchemes: ['http', 'https', 'mailto'],
    allowedSchemesAppliedToAttributes: ['href'],
    allowProtocolRelative: false,
    transformTags: { 'a': sanitize.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer nofollow' }) }
  });
}
