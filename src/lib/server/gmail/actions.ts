import { getGmailClient } from './client';

/**
 * Mark an email as read by removing the UNREAD label
 */
export async function markAsRead(accountId: string, messageId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.modify({
		userId: 'me',
		id: messageId,
		requestBody: {
			removeLabelIds: ['UNREAD']
		}
	});
}

/**
 * Archive an email by removing the INBOX label
 */
export async function archiveEmail(accountId: string, messageId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.modify({
		userId: 'me',
		id: messageId,
		requestBody: {
			removeLabelIds: ['INBOX']
		}
	});
}

/**
 * Move email to trash by adding TRASH label
 */
export async function trashEmail(accountId: string, messageId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.trash({
		userId: 'me',
		id: messageId
	});
}

/**
 * Add a label to an email
 */
export async function addLabel(accountId: string, messageId: string, labelId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.modify({
		userId: 'me',
		id: messageId,
		requestBody: {
			addLabelIds: [labelId]
		}
	});
}

/**
 * Batch archive emails by removing the INBOX label
 */
export async function batchArchive(accountId: string, messageIds: string[]): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.batchModify({
		userId: 'me',
		requestBody: { ids: messageIds, removeLabelIds: ['INBOX'] }
	});
}

/**
 * Batch mark emails as read by removing the UNREAD label
 */
export async function batchMarkAsRead(accountId: string, messageIds: string[]): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.batchModify({
		userId: 'me',
		requestBody: { ids: messageIds, removeLabelIds: ['UNREAD'] }
	});
}

/**
 * Batch trash emails (no batch API for trash, so loop individually)
 */
export async function batchTrash(accountId: string, messageIds: string[]): Promise<void> {
	const gmail = await getGmailClient(accountId);
	for (const id of messageIds) {
		await gmail.users.messages.trash({ userId: 'me', id });
	}
}

/**
 * Batch add a label to emails
 */
export async function batchAddLabel(accountId: string, messageIds: string[], labelId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.batchModify({
		userId: 'me',
		requestBody: { ids: messageIds, addLabelIds: [labelId] }
	});
}

/**
 * Remove a label from an email
 */
export async function removeLabel(accountId: string, messageId: string, labelId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.messages.modify({
		userId: 'me',
		id: messageId,
		requestBody: {
			removeLabelIds: [labelId]
		}
	});
}

/**
 * Ensure a label exists, create if it doesn't, and return the label ID
 */
export async function ensureLabelExists(accountId: string, labelName: string): Promise<string> {
	const gmail = await getGmailClient(accountId);

	// List all labels
	const { data } = await gmail.users.labels.list({
		userId: 'me'
	});

	// Check if label already exists
	const existingLabel = data.labels?.find(
		(label) => label.name?.toLowerCase() === labelName.toLowerCase()
	);

	if (existingLabel && existingLabel.id) {
		return existingLabel.id;
	}

	// Create the label if it doesn't exist
	const createResponse = await gmail.users.labels.create({
		userId: 'me',
		requestBody: {
			name: labelName,
			labelListVisibility: 'labelShow',
			messageListVisibility: 'show'
		}
	});

	if (!createResponse.data.id) {
		throw new Error('Failed to create label');
	}

	return createResponse.data.id;
}
