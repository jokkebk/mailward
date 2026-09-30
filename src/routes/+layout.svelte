<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>Mailward</title>
</svelte:head>

<div class="shell">
	<header>
		<h1>Mailward</h1>
	</header>
	{@render children()}
</div>

<style>
	:global(body) {
		margin: 0;
		font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
		background: #f5f6f8;
		color: #1d2330;
	}
	.shell {
		max-width: 1120px;
		margin: 0 auto;
		padding: 1rem 1.25rem 4rem;
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0.5rem 0 1rem;
	}
	header h1 {
		font-size: 1.4rem;
		margin: 0;
	}
</style>
