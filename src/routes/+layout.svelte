<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>Mailward</title>
</svelte:head>

<div class="shell">
	{@render children()}
</div>

<style>
	:global(:root) {
		/* Ink and paper: cool neutrals so the action colors carry the meaning. */
		--ink: #18202c;
		--ink-2: #3d4757;
		--ink-3: #667085;
		--ink-4: #98a1b0;
		--paper: #f3f5f8;
		--surface: #ffffff;
		--sunken: #eef1f5;
		--line: #e6e9ee;
		--line-strong: #d3d8e0;
		--row-hover: #f8f9fb;
		--row-focus: #f4f7fd;
		--focus: #3563e9;
		/* One color per Gmail outcome, used identically in toggles, tallies and receipts. */
		--todo: #2f5fe0;
		--archive: #0c8a7b;
		--trash: #d43d58;
		--leave: #6b7689;
		--done: #2d8a47;
		--warn: #a45d00;
		--warn-bg: #fdf1dc;
		--time: #b3360f;
		--time-bg: #fde9e2;
	}
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		background: var(--paper);
		color: var(--ink);
		-webkit-font-smoothing: antialiased;
	}
	.shell {
		max-width: 1320px;
		margin: 0 auto;
		padding: 0 1rem 2rem;
	}
</style>
