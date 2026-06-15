<script lang="ts">
	import type { Snippet } from 'svelte';
	import type { ThreadView } from '$lib/types/rules';

	let {
		items,
		limit = 10,
		dim,
		lead,
		trail
	}: {
		items: ThreadView[];
		limit?: number;
		/** Optional per-row predicate; true rows render dimmed (e.g. unchecked). */
		dim?: (t: ThreadView) => boolean;
		/** Rendered before the meta block (e.g. a checkbox). */
		lead?: Snippet<[ThreadView]>;
		/** Rendered after the age (e.g. action buttons, gmail link). */
		trail?: Snippet<[ThreadView]>;
	} = $props();

	let expanded = $state(false);

	function fmtAge(d: number) {
		return d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`;
	}
</script>

<div class="thread-wrap" class:fade={items.length > limit && !expanded}>
	<ul class="threads">
		{#each expanded ? items : items.slice(0, limit) as t (t.id)}
			<li class:unchecked={dim ? dim(t) : false}>
				{#if lead}{@render lead(t)}{/if}
				<div class="meta">
					<span class="from">{t.from}</span>
					<span class="subj">{t.subject ?? '(no subject)'}</span>
					<span class="snip">{t.snippet}</span>
				</div>
				<span class="age">{fmtAge(t.ageDays)}</span>
				{#if trail}{@render trail(t)}{/if}
			</li>
		{/each}
	</ul>
</div>
{#if items.length > limit}
	<button class="more" onclick={() => (expanded = !expanded)}>
		{expanded ? 'Show less' : `Show ${items.length - limit} more`}
	</button>
{/if}

<style>
	.thread-wrap {
		position: relative;
	}
	.thread-wrap.fade::after {
		content: '';
		position: absolute;
		left: 0;
		right: 0;
		bottom: 0;
		height: 3rem;
		background: linear-gradient(rgba(255, 255, 255, 0), #fff);
		pointer-events: none;
	}
	.more {
		display: block;
		width: 100%;
		margin-top: 0.4rem;
		border: none;
		background: none;
		color: #2f6df6;
		font-size: 0.8rem;
		cursor: pointer;
		padding: 0.3rem 0;
	}
	ul.threads {
		list-style: none;
		margin: 0;
		padding: 0;
	}
	ul.threads li {
		display: flex;
		align-items: center;
		gap: 0.5rem;
		padding: 0.4rem 0;
		border-top: 1px solid #f2f4f7;
	}
	ul.threads li.unchecked {
		opacity: 0.5;
	}
	.meta {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-width: 0;
	}
	.from {
		font-size: 0.78rem;
		color: #475467;
	}
	.subj {
		font-weight: 600;
		font-size: 0.9rem;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.snip {
		font-size: 0.78rem;
		color: #98a2b3;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}
	.age {
		font-size: 0.75rem;
		color: #98a2b3;
		white-space: nowrap;
	}
</style>
