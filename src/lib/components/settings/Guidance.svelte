<script lang="ts">
  import { untrack } from 'svelte';
  import Icon from '$lib/components/v3/Icon.svelte';
  import type { PolicyCard } from '$lib/types/v3';
  import { MAX_WORDS, MIN_WORDS, policyText, wordCount } from '$lib/v3/settings';

  let { original, version, threads, onSave }: {
    original: PolicyCard[]; version: number; threads: number;
    onSave: (cards: PolicyCard[], note: string) => Promise<boolean>;
  } = $props();

  const fresh = () => structuredClone($state.snapshot(original));
  let cards = $state<PolicyCard[]>(untrack(fresh));
  let openId = $state<string | null>(null);
  let note = $state('');
  let saving = $state(false);
  let showText = $state(false);

  // A fresh server copy (after save, restore or reload) replaces the draft.
  let seen = untrack(() => original);
  $effect.pre(() => { if (original !== seen) { seen = original; cards = fresh(); note = ''; } });

  const text = $derived(policyText(cards));
  const words = $derived(wordCount(text));
  const dirty = $derived(JSON.stringify(cards) !== JSON.stringify(original));
  const textChanged = $derived(text !== policyText(original));
  const tooShort = $derived(words < MIN_WORDS), tooLong = $derived(words > MAX_WORDS);

  export function isDirty() { return dirty; }

  function update(id: string, change: Partial<PolicyCard>) { cards = cards.map((c) => (c.id === id ? { ...c, ...change } : c)); }
  function move(i: number, delta: number) {
    const j = i + delta; if (j < 0 || j >= cards.length) return;
    const next = [...cards]; [next[i], next[j]] = [next[j], next[i]]; cards = next;
  }
  function remove(card: PolicyCard) {
    if (card.body.trim() && !confirm(`Remove “${card.title}”? You can restore it from history after saving.`)) return;
    cards = cards.filter((c) => c.id !== card.id);
  }
  function add() {
    const id = crypto.randomUUID().slice(0, 8);
    cards = [...cards, { id, title: 'New guidance', body: '', enabled: true }];
    openId = id;
    queueMicrotask(() => document.getElementById(`title-${id}`)?.focus());
  }
  async function save() {
    saving = true;
    try { if (await onSave($state.snapshot(cards), note)) { openId = null; } } finally { saving = false; }
  }
  const rows = (body: string) => Math.max(3, Math.ceil(body.length / 92) + body.split('\n').length - 1);
</script>

<div class="cards">
  {#each cards as card, i (card.id)}
    {@const open = openId === card.id}
    <article class="card" class:off={!card.enabled} class:open>
      <div class="head">
        <button class="switch" role="switch" aria-checked={card.enabled} aria-label="{card.enabled ? 'Turn off' : 'Turn on'} {card.title}"
          title={card.enabled ? 'Jev reads this' : 'Kept, but not sent to Jev'} onclick={() => update(card.id, { enabled: !card.enabled })}><i></i></button>
        <button class="summary" aria-expanded={open} onclick={() => (openId = open ? null : card.id)}>
          <span class="title">{card.title || 'Untitled'}</span>
          {#if !open}<span class="preview">{card.body || 'Empty — add the text Jev should read.'}</span>{/if}
        </button>
        <span class="wc">{wordCount(card.body)} w</span>
        <button class="icon" aria-label="Edit {card.title}" aria-expanded={open} onclick={() => (openId = open ? null : card.id)}><span class="chev" class:down={open}><Icon name="chevron" size={12} /></span></button>
      </div>
      {#if open}
        <div class="editor">
          <label class="lbl" for="title-{card.id}">Title <span>for you only, never sent to Jev</span></label>
          <input id="title-{card.id}" class="input" value={card.title} oninput={(e) => update(card.id, { title: e.currentTarget.value })} />
          <label class="lbl" for="body-{card.id}">Guidance <span>exactly what Jev reads</span></label>
          <textarea id="body-{card.id}" class="input body" rows={rows(card.body)} value={card.body} oninput={(e) => update(card.id, { body: e.currentTarget.value })}
            placeholder="Write it as an instruction that stands on its own, e.g. “Receipts from our accounting system are records: archive them.”"></textarea>
          <div class="tools">
            <button class="quiet" disabled={i === 0} onclick={() => move(i, -1)}><Icon name="up" size={13} /> Earlier</button>
            <button class="quiet" disabled={i === cards.length - 1} onclick={() => move(i, 1)}><Icon name="down" size={13} /> Later</button>
            <span class="spacer"></span>
            <button class="quiet danger" onclick={() => remove(card)}>Remove</button>
          </div>
        </div>
      {/if}
    </article>
  {/each}
</div>

<div class="foot">
  <button class="btn" onclick={add}><Icon name="plus" size={13} /> Add guidance</button>
  <button class="quiet" aria-expanded={showText} onclick={() => (showText = !showText)}>{showText ? 'Hide' : 'Show'} what Jev reads</button>
  <span class="spacer"></span>
  <div class="meter" class:bad={tooShort || tooLong} title="Jev reads the whole guidance with every thread, so shorter is cheaper and sharper">
    <span class="bar"><i style:width="{Math.min(100, (words / MAX_WORDS) * 100)}%"></i></span>
    {words.toLocaleString('en-GB')} / {MAX_WORDS.toLocaleString('en-GB')} words
  </div>
</div>
{#if showText}<pre class="assembled">{text || '(nothing switched on)'}</pre>{/if}

{#if dirty}
  <div class="savebar" role="region" aria-label="Unsaved guidance">
    <div class="what">
      <strong>Unsaved guidance</strong>
      <span>{#if tooShort}Guidance needs at least {MIN_WORDS} words switched on.{:else if tooLong}Trim to {MAX_WORDS.toLocaleString('en-GB')} words or fewer.{:else if textChanged}Saves as policy v{version + 1}. The next check reassesses {threads ? `about ${threads}` : 'your'} unread threads with it.{:else}Only titles or switched-off text changed; Jev's input stays the same, so v{version} is updated in place.{/if}</span>
    </div>
    {#if textChanged}<input class="input note" placeholder="What changed? (optional, shown in history)" bind:value={note} />{/if}
    <button class="quiet" onclick={() => (cards = fresh())}>Discard</button>
    <button class="btn primary" disabled={saving || tooShort || tooLong} onclick={save}>{saving ? 'Saving…' : textChanged ? `Save as v${version + 1}` : 'Save'}</button>
  </div>
{/if}

<style>
  .cards { display: flex; flex-direction: column; }
  .card { border-top: 1px solid var(--line); }
  .card:first-child { border-top: 0; }
  .head { display: flex; align-items: center; gap: .7rem; min-height: 50px; padding: 0 .6rem 0 1rem; }
  .card:hover .head, .card.open .head { background: var(--row-hover); }
  .summary { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: .1rem; padding: .55rem 0; border: 0; background: none; text-align: left; font: inherit; color: inherit; cursor: pointer; }
  .title { font-weight: 650; font-size: 13px; color: var(--ink); }
  .preview { overflow: hidden; display: -webkit-box; -webkit-line-clamp: 2; line-clamp: 2; -webkit-box-orient: vertical; color: var(--ink-3); font-size: 12.5px; line-height: 1.45; }
  .off .title { color: var(--ink-3); }
  .off .preview { color: var(--ink-4); text-decoration: line-through; text-decoration-color: color-mix(in srgb, var(--ink-4) 50%, transparent); }
  .wc { color: var(--ink-4); font-size: 11.5px; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .icon { display: grid; place-items: center; width: 28px; height: 28px; border: 0; border-radius: 6px; background: none; color: var(--ink-4); cursor: pointer; }
  .icon:hover { background: var(--sunken); color: var(--ink); }
  .chev { display: flex; transition: transform .15s; }
  .chev.down { transform: rotate(90deg); }

  .switch { position: relative; flex-shrink: 0; width: 30px; height: 18px; padding: 0; border: 0; border-radius: 9px; background: var(--line-strong); cursor: pointer; transition: background .15s; }
  .switch i { position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: #fff; box-shadow: 0 1px 2px rgb(0 0 0 / 25%); transition: transform .15s; }
  .switch[aria-checked='true'] { background: var(--done); }
  .switch[aria-checked='true'] i { transform: translateX(12px); }

  .editor { padding: .2rem 1rem 1rem calc(1rem + 30px + .7rem); background: var(--row-hover); }
  .lbl { display: block; margin: .5rem 0 .3rem; font-size: 11.5px; font-weight: 650; color: var(--ink-2); text-transform: uppercase; letter-spacing: .04em; }
  .lbl span { margin-left: .4rem; font-weight: 500; text-transform: none; letter-spacing: 0; color: var(--ink-4); }
  .input { box-sizing: border-box; width: 100%; padding: .45rem .6rem; border: 1px solid var(--line-strong); border-radius: 7px; background: var(--surface); color: var(--ink); font: inherit; font-size: 13px; }
  .input:focus { outline: 2px solid var(--focus); outline-offset: -1px; border-color: transparent; }
  .body { resize: vertical; line-height: 1.55; field-sizing: content; min-height: 4.5rem; }
  .tools { display: flex; align-items: center; gap: .2rem; margin-top: .5rem; }

  .foot { display: flex; align-items: center; gap: .6rem; flex-wrap: wrap; padding: .7rem 1rem; border-top: 1px solid var(--line); }
  .meter { display: inline-flex; align-items: center; gap: .5rem; color: var(--ink-3); font-size: 12px; font-variant-numeric: tabular-nums; }
  .meter .bar { width: 90px; height: 4px; border-radius: 2px; background: var(--sunken); overflow: hidden; }
  .meter .bar i { display: block; height: 100%; background: var(--ink-4); }
  .meter.bad { color: var(--trash); }
  .meter.bad .bar i { background: var(--trash); }
  .assembled { margin: 0; padding: .9rem 1rem; border-top: 1px solid var(--line); background: var(--sunken); color: var(--ink-2); font: 12px/1.6 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; }

  .savebar {
    position: sticky; bottom: .6rem; z-index: 10; display: flex; align-items: center; gap: .8rem; flex-wrap: wrap;
    margin: .8rem .6rem .6rem; padding: .55rem .6rem .55rem .9rem; border: 1px solid var(--line-strong); border-radius: 10px;
    background: color-mix(in srgb, var(--surface) 94%, transparent); backdrop-filter: blur(8px); box-shadow: 0 6px 24px -12px rgb(24 32 44 / 35%);
  }
  .what { flex: 1; min-width: 14rem; display: flex; flex-direction: column; gap: .1rem; font-size: 12.5px; color: var(--ink-3); }
  .what strong { color: var(--ink); font-size: 13px; }
  .note { width: 18rem; max-width: 100%; height: 30px; padding: 0 .6rem; }
  .spacer { flex: 1; }
  .danger:hover:not(:disabled) { color: var(--trash); }
  @media (max-width: 720px) { .editor { padding-left: 1rem; } .wc { display: none; } .note { width: 100%; } }
</style>
