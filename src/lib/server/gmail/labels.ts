import { getGmailClient } from './client';

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
