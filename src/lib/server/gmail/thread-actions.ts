import { getGmailClient } from './client';
import { ensureLabelExists } from './actions';

/**
 * Thread-level action verbs. The design triages at the thread level, so these
 * operate on Gmail thread ids and have clean inverses for rollback.
 */

export async function markThreadRead(accountId: string, threadId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.threads.modify({
		userId: 'me',
		id: threadId,
		requestBody: { removeLabelIds: ['UNREAD'] }
	});
}

export async function archiveThread(accountId: string, threadId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	// Archive = remove INBOX, and clear UNREAD (acting means "dealt with").
	await gmail.users.threads.modify({
		userId: 'me',
		id: threadId,
		requestBody: { removeLabelIds: ['INBOX', 'UNREAD'] }
	});
}

export async function trashThread(accountId: string, threadId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.threads.trash({ userId: 'me', id: threadId });
}

export async function untrashThread(accountId: string, threadId: string): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.threads.untrash({ userId: 'me', id: threadId });
}

/** label_todo: add a TODO label; thread stays UNREAD (still needs attention). */
export async function labelThreadTodo(accountId: string, threadId: string): Promise<string> {
	const gmail = await getGmailClient(accountId);
	const labelId = await ensureLabelExists(accountId, 'TODO');
	await gmail.users.threads.modify({
		userId: 'me',
		id: threadId,
		requestBody: { addLabelIds: [labelId] }
	});
	return labelId;
}

export async function modifyThreadLabels(
	accountId: string,
	threadId: string,
	addLabelIds: string[],
	removeLabelIds: string[]
): Promise<void> {
	const gmail = await getGmailClient(accountId);
	await gmail.users.threads.modify({
		userId: 'me',
		id: threadId,
		requestBody: { addLabelIds, removeLabelIds }
	});
}
