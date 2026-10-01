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
	/* Shared controls; pages may refine them locally. */
	:global(.btn) { display: inline-flex; align-items: center; gap: .4rem; white-space: nowrap; height: 30px; padding: 0 .8rem; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); color: var(--ink); font: inherit; font-size: 12.5px; font-weight: 600; text-decoration: none; cursor: pointer; }
	:global(.btn:hover:not(:disabled)) { border-color: var(--ink-4); }
	:global(.btn.primary) { border-color: var(--ink); background: var(--ink); color: #fff; }
	:global(.btn.primary:hover:not(:disabled)) { background: #2a3445; }
	:global(.btn:disabled) { opacity: .45; cursor: default; }
	:global(.quiet) { height: 28px; padding: 0 .55rem; border: 0; border-radius: 6px; background: none; color: var(--ink-3); font: inherit; font-size: 12.5px; font-weight: 550; text-decoration: none; cursor: pointer; display: inline-flex; align-items: center; gap: .3rem; }
	:global(.quiet:hover:not(:disabled)), :global(.quiet[aria-expanded='true']) { background: var(--sunken); color: var(--ink); }
	:global(.quiet:disabled) { opacity: .45; cursor: default; }
	:global(button:focus-visible), :global(a:focus-visible), :global(select:focus-visible) { outline: 2px solid var(--focus); outline-offset: 1px; }
	.shell {
		max-width: 1320px;
		margin: 0 auto;
		padding: 0 1rem 2rem;
	}
</style>
