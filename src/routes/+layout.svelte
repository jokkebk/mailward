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
		max-width: 1440px;
		margin: 0 auto;
		padding: .5rem 1rem 2rem;
	}
	header {
		display: flex;
		align-items: baseline;
		gap: 0.75rem;
		padding: 0 0 .3rem;
	}
	header h1 {
		font-size: 1rem;
		margin: 0;
	}
</style>
