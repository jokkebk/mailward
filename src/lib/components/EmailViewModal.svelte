<script lang="ts">
	import type { ThreadView } from '$lib/types/rules';

	let {
		thread,
		accountId,
		onClose
	}: {
		thread: ThreadView;
		accountId: string;
		onClose: () => void;
	} = $props();

	let loading = $state(true);
	let error = $state<string | null>(null);
	let content = $state<{ html: string | null; text: string | null } | null>(null);

	async function load() {
		loading = true;
		error = null;
		content = null;
		try {
			const messageId = thread.messageIds[0];
			const res = await fetch(`/api/messages/${messageId}/content?accountId=${encodeURIComponent(accountId)}`);
			if (res.status === 401) {
				error = 'Re-authentication required — please reconnect the account.';
				return;
			}
			if (!res.ok) throw new Error('request failed');
			content = await res.json();
		} catch {
			error = 'Failed to load email content.';
		} finally {
			loading = false;
		}
	}

	$effect(() => {
		thread;
		load();
	});

	function gmailLink(threadId: string) {
		return `https://mail.google.com/mail/u/0/#inbox/${threadId}`;
	}
</script>

<div
	class="modal-backdrop"
	role="button"
	tabindex="-1"
	aria-label="Close"
	onclick={(e) => e.target === e.currentTarget && onClose()}
	onkeydown={(e) => e.key === 'Escape' && onClose()}
>
	<div class="modal" role="dialog" aria-modal="true" aria-labelledby="email-view-title">
		<div class="modal-head">
			<div class="head-text">
				<strong id="email-view-title">{thread.subject ?? '(no subject)'}</strong>
				<span class="from">{thread.from}</span>
			</div>
			<div class="head-actions">
				<a class="gmail" href={gmailLink(thread.id)} target="_blank" rel="noreferrer">open in Gmail</a>
				<button class="icon-btn" aria-label="Close" onclick={onClose}>×</button>
			</div>
		</div>
		<div class="body">
			{#if loading}
				<p class="status">Loading…</p>
			{:else if error}
				<p class="status error">{error}</p>
			{:else if content?.html}
				<iframe srcdoc={content.html} sandbox="" title="Email content" class="email-iframe"></iframe>
			{:else if content?.text}
				<pre class="email-text">{content.text}</pre>
			{:else}
				<p class="status">No content available.</p>
			{/if}
		</div>
	</div>
</div>

<style>
	.modal-backdrop {
		position: fixed;
		inset: 0;
		z-index: 20;
		display: grid;
		place-items: center;
		background: rgba(15, 23, 42, 0.34);
		padding: 1rem;
	}
	.modal {
		width: min(56rem, 100%);
		max-height: 90vh;
		display: flex;
		flex-direction: column;
		background: #fff;
		border: 1px solid #d0d5dd;
		border-radius: 8px;
		box-shadow: 0 18px 45px rgba(15, 23, 42, 0.2);
		padding: 1rem;
	}
	.modal-head {
		display: flex;
		align-items: flex-start;
		justify-content: space-between;
		gap: 0.75rem;
		margin-bottom: 0.75rem;
	}
	.head-text {
		display: flex;
		flex-direction: column;
		min-width: 0;
	}
	.head-text .from {
		font-size: 0.8rem;
		color: #475467;
	}
	.head-actions {
		display: flex;
		align-items: center;
		gap: 0.75rem;
		flex-shrink: 0;
	}
	.gmail {
		font-size: 0.8rem;
		color: #2f6df6;
		text-decoration: none;
		white-space: nowrap;
	}
	.icon-btn {
		border: none;
		background: none;
		font-size: 1.2rem;
		line-height: 1;
		cursor: pointer;
		color: #667085;
		padding: 0 0.2rem;
	}
	.body {
		overflow-y: auto;
	}
	.status {
		color: #667085;
		font-size: 0.9rem;
	}
	.status.error {
		color: #b42318;
	}
	.email-iframe {
		width: 100%;
		height: 70vh;
		border: 1px solid #eaecf0;
		border-radius: 6px;
		background: #fff;
	}
	.email-text {
		white-space: pre-wrap;
		word-wrap: break-word;
		font-size: 0.85rem;
		margin: 0;
	}
</style>
