export const MAX_THREADS_PER_RUN = 300;
export const SYNC_WINDOW_DAYS = 28; // how far back "unread in inbox" reaches

// AI tier: threads per classifier call (DESIGN.md §"The daily run" — ~10–20).
export const AI_BATCH_SIZE = 15;

/**
 * Per-(rule, disposition) promotion gate (DESIGN.md §"Promotion to auto-apply").
 * Tunable. Delete demands a tighter bar than archive/label. Used by the promotion
 * helper as decision support; promotion is always suggest-and-confirm.
 */
export const PROMOTION_GATE = {
	trash: { minRun: 20, minApprovalPct: 99 },
	archive: { minRun: 10, minApprovalPct: 95 },
	label_todo: { minRun: 10, minApprovalPct: 95 }
} as const;

export const STORAGE_KEYS = {
	accountId: 'mailward.accountId',
	useJev: 'mailward.useJev'
} as const;
