import { db } from '../db';
import { runs } from '../db/schema';
import { and, eq, notInArray } from 'drizzle-orm';
import { handleReauthCleanup } from '../gmail/reauth';
import { createTriageRun, runTriage } from './run';
import { markStaleRuns } from './telemetry';

const activeJobs = new Map<string, Promise<void>>();

async function markDetachedRunsFailed(accountId: string): Promise<void> {
	const activeRunIds = [...activeJobs.keys()];
	const where =
		activeRunIds.length > 0
			? and(
					eq(runs.accountId, accountId),
					eq(runs.status, 'running'),
					notInArray(runs.id, activeRunIds)
				)
			: and(eq(runs.accountId, accountId), eq(runs.status, 'running'));
	await db.update(runs).set({ status: 'failed', endedAt: new Date() }).where(where);
}

export async function startOrAttachRun(accountId: string, sync: boolean, useJev = false): Promise<string> {
	await markStaleRuns(accountId);

	for (const runId of activeJobs.keys()) {
		const row = await db
			.select({ id: runs.id })
			.from(runs)
			.where(and(eq(runs.id, runId), eq(runs.accountId, accountId), eq(runs.status, 'running')))
			.get();
		if (row) return runId;
	}

	await markDetachedRunsFailed(accountId);
	const runId = await createTriageRun(accountId, sync, useJev);
	const job = runTriage(accountId, { sync, runId, useJev })
		.then(() => undefined)
		.catch(async (error) => {
			await handleReauthCleanup(error, accountId);
			console.error('Run job error:', error);
		})
		.finally(() => {
			activeJobs.delete(runId);
		});
	activeJobs.set(runId, job);
	return runId;
}
