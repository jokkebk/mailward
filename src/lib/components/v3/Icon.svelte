<script lang="ts" module>
  export type IconName = 'conversation' | 'notification' | 'newsletter' | 'sales' | 'transaction' | 'other' | 'calendar' | 'paperclip' | 'chevron' | 'external' | 'refresh' | 'check' | 'undo'
    | 'gear' | 'plus' | 'up' | 'down' | 'close' | 'zap' | 'book' | 'clock' | 'cpu' | 'arrow' | 'back';
</script>

<script lang="ts">
  let { name, size = 14, title }: { name: IconName; size?: number; title?: string } = $props();
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden={title ? undefined : 'true'} role={title ? 'img' : undefined}>
  {#if title}<title>{title}</title>{/if}
  {#if name === 'conversation'}<path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" />
  {:else if name === 'notification'}<path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" /><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
  {:else if name === 'newsletter'}<path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2Zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2" /><path d="M18 14h-8M15 18h-5M10 6h8v4h-8z" />
  {:else if name === 'sales'}<path d="M12.6 2.6A2 2 0 0 0 11.2 2H4a2 2 0 0 0-2 2v7.2a2 2 0 0 0 .6 1.4l8.7 8.7a2.4 2.4 0 0 0 3.4 0l6.6-6.6a2.4 2.4 0 0 0 0-3.4z" /><circle cx="7.5" cy="7.5" r="1" fill="currentColor" />
  {:else if name === 'transaction'}<path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" /><path d="M16 8h-6a2 2 0 1 0 0 4h4a2 2 0 1 1 0 4H8M12 17.5v-11" />
  {:else if name === 'calendar'}<rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" />
  {:else if name === 'paperclip'}<path d="m21.4 11-9.2 9.2a6 6 0 0 1-8.5-8.5l8.6-8.6A4 4 0 1 1 18 8.8l-8.6 8.6a2 2 0 0 1-2.8-2.8l8.5-8.5" />
  {:else if name === 'chevron'}<path d="m9 18 6-6-6-6" />
  {:else if name === 'external'}<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
  {:else if name === 'refresh'}<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8" /><path d="M21 3v5h-5M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16" /><path d="M8 16H3v5" />
  {:else if name === 'check'}<path d="M20 6 9 17l-5-5" />
  {:else if name === 'undo'}<path d="M9 14 4 9l5-5" /><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />
  {:else if name === 'gear'}<path d="M12.2 2h-.4a2 2 0 0 0-2 2v.2a2 2 0 0 1-1 1.7l-.4.3a2 2 0 0 1-2 0l-.2-.1a2 2 0 0 0-2.7.7l-.2.4a2 2 0 0 0 .7 2.7l.2.1a2 2 0 0 1 1 1.7v.6a2 2 0 0 1-1 1.7l-.2.1a2 2 0 0 0-.7 2.7l.2.4a2 2 0 0 0 2.7.7l.2-.1a2 2 0 0 1 2 0l.4.3a2 2 0 0 1 1 1.7v.2a2 2 0 0 0 2 2h.4a2 2 0 0 0 2-2v-.2a2 2 0 0 1 1-1.7l.4-.3a2 2 0 0 1 2 0l.2.1a2 2 0 0 0 2.7-.7l.2-.4a2 2 0 0 0-.7-2.7l-.2-.1a2 2 0 0 1-1-1.7v-.6a2 2 0 0 1 1-1.7l.2-.1a2 2 0 0 0 .7-2.7l-.2-.4a2 2 0 0 0-2.7-.7l-.2.1a2 2 0 0 1-2 0l-.4-.3a2 2 0 0 1-1-1.7V4a2 2 0 0 0-2-2Z" /><circle cx="12" cy="12" r="3" />
  {:else if name === 'plus'}<path d="M12 5v14M5 12h14" />
  {:else if name === 'up'}<path d="m18 15-6-6-6 6" />
  {:else if name === 'down'}<path d="m6 9 6 6 6-6" />
  {:else if name === 'close'}<path d="M18 6 6 18M6 6l12 12" />
  {:else if name === 'zap'}<path d="M13 2 3 14h9l-1 8 10-12h-9z" />
  {:else if name === 'book'}<path d="M4 19.5v-15A2.5 2.5 0 0 1 6.5 2H20v20H6.5a2.5 2.5 0 0 1 0-5H20" />
  {:else if name === 'clock'}<circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" />
  {:else if name === 'cpu'}<rect width="14" height="14" x="5" y="5" rx="2" /><path d="M9 9h6v6H9zM9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" />
  {:else if name === 'arrow'}<path d="M5 12h14M13 6l6 6-6 6" />
  {:else if name === 'back'}<path d="M19 12H5M11 18l-6-6 6-6" />
  {:else}<circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="1" fill="currentColor" />{/if}
</svg>

<style>
  .icon { display: block; flex-shrink: 0; }
</style>
