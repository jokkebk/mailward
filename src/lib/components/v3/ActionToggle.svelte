<script lang="ts" module>
  import type { Choice } from '$lib/v3/review';
  export const ALL_CHOICES: Choice[] = ['label_todo', 'archive', 'trash', 'leave', 'done'];
  export const SHORTCUT: Record<Choice, string> = { label_todo: 't', archive: 'e', trash: '#', leave: 'l', done: 'd' };
  const HELP: Record<Choice, string> = {
    label_todo: 'Keep in the inbox with the TODO label', archive: 'Archive and mark read', trash: 'Move to trash and mark read',
    leave: 'Leave untouched in the inbox', done: 'Already handled; then archive, trash or leave it'
  };
</script>

<script lang="ts">
  import { ACTION_LABEL } from '$lib/v3/review';

  let { value, suggested = null, firm = true, options = ALL_CHOICES, label, small = false, shortcuts = true, onSelect }: {
    value: Choice | null;
    /** Jev's proposal (firm) or unconfirmed leaning (not firm). */
    suggested?: Choice | null;
    firm?: boolean;
    options?: Choice[];
    label: string;
    small?: boolean;
    shortcuts?: boolean;
    /** Called with null when the chosen option is clicked again. */
    onSelect: (choice: Choice | null) => void;
  } = $props();

  function title(option: Choice) {
    const hint = suggested === option ? (firm ? ' · Jev suggests this' : ' · Jev leans this way but is unsure') : '';
    return `${HELP[option]}${hint}${shortcuts ? ` (${SHORTCUT[option]})` : ''}`;
  }
</script>

<div class="toggle" class:small role="radiogroup" aria-label={label}>
  {#each options as option (option)}
    <button
      type="button"
      role="radio"
      aria-checked={value === option}
      class="opt {option}"
      class:on={value === option}
      class:suggested={suggested === option && firm}
      class:leaning={suggested === option && !firm}
      title={title(option)}
      onclick={(e) => { e.stopPropagation(); onSelect(value === option ? null : option); }}
    >{ACTION_LABEL[option]}</button>
  {/each}
</div>

<style>
  .toggle {
    display: inline-flex;
    flex-shrink: 0;
    border: 1px solid var(--line-strong);
    border-radius: 6px;
    background: var(--surface);
    overflow: hidden;
  }
  .opt {
    --c: var(--ink-2);
    position: relative;
    min-width: 3.1rem;
    height: 22px;
    padding: 0 .5rem;
    border: 0;
    border-left: 1px solid var(--line);
    background: transparent;
    color: var(--ink-3);
    font: inherit;
    font-size: 11.5px;
    font-weight: 500;
    cursor: pointer;
  }
  .opt:first-child { border-left: 0; }
  .opt.label_todo { --c: var(--todo); }
  .opt.archive { --c: var(--archive); }
  .opt.trash { --c: var(--trash); }
  .opt.leave { --c: var(--leave); }
  .opt.done { --c: var(--done); }
  .opt:hover { background: color-mix(in srgb, var(--c) 9%, transparent); color: var(--c); }
  .opt:focus-visible { outline: 2px solid var(--focus); outline-offset: -2px; z-index: 1; }
  /* Jev's proposal: tinted text with an inner ring, so an untouched column reads as a set of suggestions. */
  .opt.suggested { color: var(--c); font-weight: 650; box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--c) 55%, transparent); border-radius: 5px; }
  .opt.leaning { color: var(--c); }
  .opt.leaning::after {
    content: ''; position: absolute; inset: 3px; border: 1px dashed color-mix(in srgb, var(--c) 70%, transparent); border-radius: 4px; pointer-events: none;
  }
  .opt.on, .opt.on:hover { background: var(--c); color: #fff; font-weight: 650; box-shadow: none; border-left-color: var(--c); }
  .opt.on + .opt { border-left-color: var(--c); }
  .opt.on.leaning::after { display: none; }
  .small .opt { height: 20px; min-width: 0; font-size: 11px; padding: 0 .55rem; }
  @media (max-width: 720px) {
    .toggle { width: 100%; }
    .opt { flex: 1; min-width: 0; height: 30px; font-size: 12.5px; }
  }
</style>
