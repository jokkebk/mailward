<script lang="ts">
	let { children } = $props();
</script>

<svelte:head>
	<title>Mailward</title>
</svelte:head>

<div class="shell">
	<header>
		<h1>📬 Mailward</h1>
		<span class="tag" title={`Built ${__BUILD_ID__}`}>v{__APP_VERSION__} · build {__BUILD_ID__} UTC</span>
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
		max-width: 880px;
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
	.tag {
		font-size: 0.75rem;
		color: #6b7280;
		background: #e9ebef;
		padding: 0.15rem 0.5rem;
		border-radius: 999px;
	}
</style>
