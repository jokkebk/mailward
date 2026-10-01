<script lang="ts">
  import type { ReviewDecision, ReviewItem } from '$lib/types/v3';
  import ActionToggle from './v3/ActionToggle.svelte';
  import Icon, { type IconName } from './v3/Icon.svelte';
  import {
    APPLIED_LABEL, ATTENTION_LABEL, CATEGORY_SINGULAR, choiceOf, formatWhen, parseSender, percent, receivedAt,
    reasonSentence, rowTags, ruleIcon, snippet, suggestionOf, tier, type Choice, type SectionKey
  } from '$lib/v3/review';

  let { item, section, accountId, draft, focused = false, expanded = false, onToggle, onChoose, onPatch, onUndo, onFocus }: {
    item: ReviewItem;
    /** Null for an already-reviewed receipt row. */
    section: SectionKey | null;
    accountId: string;
    draft?: ReviewDecision;
    focused?: boolean;
    expanded?: boolean;
    onToggle: () => void;
    onChoose: (choice: Choice | null) => void;
    onPatch: (patch: Partial<ReviewDecision>) => void;
    onUndo: (actionId: string) => void;
    onFocus: () => void;
  } = $props();

  type FullMessage = { id: string; from: string; date: string; html: string | null; text: string | null };
  let panel = $state<'none' | 'full' | 'jev' | 'data'>('none');
  let fullContent = $state<FullMessage[] | null>(null);
  let fullError = $state('');

  const messages = $derived(item.representation.messages);
  const first = $derived(messages[0]);
  const sender = $derived(parseSender(first?.from ?? ''));
  const subject = $derived(first?.subject || '(no subject)');
  const preview = $derived(first ? snippet(first.body, first.subject) : '');
  const time = $derived(receivedAt(item));
  const count = $derived(messages.length + item.representation.omittedUnread);
  const attachments = $derived(messages.flatMap((m) => m.attachments ?? []).filter((a) => !a.inline && !a.calendar));
  const isRule = $derived(item.assessment_source === 'rule');
  const icon = $derived<IconName>(isRule ? ruleIcon(item.deterministic_rule) : item.answers?.category.choice ?? 'other');
  const bars = $derived(section ? tier(item, section) : 0);
  const quiet = $derived((section === 'trash' || section === 'archive') && bars === 0);
  const tags = $derived(section ? rowTags(item, section) : []);
  const suggestion = $derived(suggestionOf(item));
  const choice = $derived(choiceOf(draft));
  const a = $derived(item.answers);
  const signalTitle = $derived(a
    ? `Urgency ${a.urgency.score.toFixed(1)} of 3 · Relevance ${a.relevance.score.toFixed(1)} of 3`
    : isRule ? 'Matched a recipe; Jev was not asked' : 'Not assessed');
  const split = $derived(a
    ? (Object.entries(a.attention.probabilities) as [keyof typeof ATTENTION_LABEL, number][]).filter(([, p]) => p >= .05).sort((x, y) => y[1] - x[1])
    : []);
  const gmailUrl = $derived(`https://mail.google.com/mail/?authuser=${encodeURIComponent(accountId)}#all/${item.thread_id}`);

  const FEEDBACK: { value: NonNullable<ReviewDecision['chip']>; label: string }[] = [
    { value: 'already_handled', label: 'Already handled' }, { value: 'other_owner', label: 'Someone else owns it' },
    { value: 'worth_reading', label: 'Worth reading' }, { value: 'actual_receipt', label: 'Actual receipt' },
    { value: 'show_before_clearing', label: 'Show before clearing' }
  ];

  // Receipt rows describe what actually happened in Gmail, from the ledger.
  const receipt = $derived.by(() => {
    if (!item.review_kind) return null;
    const target = (item.review_kind === 'done' ? item.review_final_disposition : item.review_disposition) ?? 'leave';
    const status = item.action_status ?? item.execution_status;
    const handled = item.review_kind === 'done' ? 'Handled, ' : '';
    if (status === 'failed') return { text: `${APPLIED_LABEL[target]} failed`, tone: 'failed', title: item.review_error ?? undefined };
    if (status === 'undone') return { text: `Undone`, tone: 'undone', title: `${APPLIED_LABEL[target]}, then undone` };
    if (status === 'no_action') return { text: `${handled}${handled ? 'left' : 'Left'} in inbox`, tone: 'leave' };
    if (status === 'pending') return { text: 'Pending', tone: 'leave' };
    return { text: handled ? `${handled}${APPLIED_LABEL[target].toLowerCase()}` : APPLIED_LABEL[target], tone: target };
  });

  function toggleOpen() { onToggle(); onFocus(); }
  async function show(next: typeof panel) {
    panel = panel === next ? 'none' : next;
    if (panel !== 'full' || fullContent) return;
    try {
      const res = await fetch(`/api/v3/thread/${encodeURIComponent(item.thread_id)}/content?accountId=${encodeURIComponent(accountId)}`);
      if (!res.ok) throw new Error('Could not load the full conversation from Gmail.');
      fullContent = (await res.json()).messages;
    } catch (error) { fullError = error instanceof Error ? error.message : String(error); }
  }
</script>

<article
  class="row"
  class:focused
  class:open={expanded}
  class:quiet
  class:decided={!!choice}
  class:receipt={!!receipt}
  data-row={item.id}
  tabindex="-1"
  onfocusin={onFocus}
>
  <div class="line">
    <span class="signal" data-tier={bars} title={signalTitle} aria-label={signalTitle}><i></i><i></i><i></i></span>
    <span class="cat" title={isRule ? item.rule_title ?? 'Recipe match' : a ? CATEGORY_SINGULAR[a.category.choice] : 'Unknown kind'}><Icon name={icon} /></span>
    <button class="who" onclick={toggleOpen} aria-expanded={expanded} title={first?.from}>
      <span class="name">{sender.name}</span>
      {#if sender.via}<span class="via">{sender.via}</span>{/if}
      {#if count > 1}<span class="count">{count}</span>{/if}
    </button>
    <button class="what" onclick={toggleOpen} aria-expanded={expanded} title={subject}>
      <span class="subject">{subject}</span>
      {#if preview}<span class="snip">{preview}</span>{/if}
    </button>
    <span class="tags">
      {#if attachments.length}<span class="clip" title={attachments.map((f) => f.name).join('\n')}><Icon name="paperclip" size={12} /></span>{/if}
      {#each tags as tag}<span class="tag {tag.tone}" title={tag.title}>{tag.text}</span>{/each}
    </span>
    <time datetime={new Date(time).toISOString()} title={new Date(time).toLocaleString('en-GB', { dateStyle: 'full', timeStyle: 'short' })}>{formatWhen(time)}</time>
    <div class="decide">
      {#if receipt}
        <span class="outcome {receipt.tone}" title={receipt.title}>{receipt.text}</span>
        {#if item.review_action_id && item.action_status === 'applied'}
          <button class="undo" onclick={() => onUndo(item.review_action_id!)}><Icon name="undo" size={12} /> Undo</button>
        {/if}
      {:else}
        <ActionToggle label={`Decision for ${subject}`} value={choice} suggested={suggestion?.choice ?? null} firm={suggestion?.firm ?? true} onSelect={onChoose} />
      {/if}
    </div>
  </div>

  {#if draft?.kind === 'done'}
    <div class="followup">
      <span>Handled. Afterwards</span>
      <ActionToggle small shortcuts={false} label="After handling" options={['archive', 'trash', 'leave']} value={draft.finalDisposition ?? null}
        onSelect={(c) => onPatch({ finalDisposition: (c ?? draft?.finalDisposition) as ReviewDecision['finalDisposition'] })} />
    </div>
  {/if}

  {#if expanded}
    <div class="detail">
      <p class="meta">
        <span><strong>{sender.name}</strong> {#if sender.address !== sender.name}<span class="addr">&lt;{sender.address}&gt;</span>{/if}</span>
        {#if first?.to}<span>to {first.to}</span>{/if}
        {#if first?.cc}<span>cc {first.cc}</span>{/if}
        <span>{new Date(time).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}</span>
        <a href={gmailUrl} target="_blank" rel="noreferrer noopener">Open in Gmail <Icon name="external" size={11} /></a>
      </p>

      {#if isRule}
        <p class="read">Matched the recipe <a href="/settings#recipes"><strong>{item.rule_title ?? item.deterministic_rule}</strong></a> (v{item.deterministic_version}){item.rule_description ? `: ${item.rule_description}` : '.'} Jev was not asked.</p>
      {:else if a}
        <dl class="read">
          <div><dt>Kind</dt><dd>{CATEGORY_SINGULAR[a.category.choice]}</dd></div>
          <div><dt>Attention</dt><dd>{ATTENTION_LABEL[a.attention.choice]} <span class="p">{percent(a.attention.probabilities[a.attention.choice])}</span></dd></div>
          <div><dt>Afterwards</dt><dd>{a.retention.choice === 'keep' ? 'Keep' : a.retention.choice === 'disposable' ? 'Disposable' : 'Unclear'} <span class="p">{percent(a.retention.probabilities[a.retention.choice])}</span></dd></div>
          <div><dt>Urgency</dt><dd><span class="meter"><i style:width="{(a.urgency.score / 3) * 100}%"></i></span> {a.attention.choice === 'none' ? 'n/a' : a.urgency.score.toFixed(1)}</dd></div>
          <div><dt>Relevance</dt><dd><span class="meter"><i style:width="{(a.relevance.score / 3) * 100}%"></i></span> {a.relevance.score.toFixed(1)}</dd></div>
          {#if a.gap.choice !== 'sufficient'}<div><dt>Missing</dt><dd>{a.gap.choice.replace('_', ' ')}</dd></div>{/if}
        </dl>
        {#if item.status === 'unresolved'}
          <p class="why"><strong>{reasonSentence(item)}.</strong> Its read of the attention needed: {#each split as [key, p], i}{i ? ', ' : ''}{ATTENTION_LABEL[key].toLowerCase()} {percent(p)}{/each}.{suggestion ? ' The dashed option is where it leans.' : ''}</p>
        {/if}
      {:else}
        <p class="why"><strong>{reasonSentence(item)}.</strong> {item.error ?? 'Jev returned no assessment for this thread.'}</p>
      {/if}

      <div class="body">{first?.body?.trim() || 'Message content unavailable.'}</div>
      {#if attachments.length}
        <p class="files"><Icon name="paperclip" size={12} /> {attachments.map((f) => f.name).join(', ')}</p>
      {/if}

      {#if !receipt}
        <div class="feedback" class:inactive={!draft}>
          <span class="label">{draft ? 'Tell Jev' : 'Choose an action to add feedback'}</span>
          {#each FEEDBACK as chip}
            <button class="chip" class:on={draft?.chip === chip.value} disabled={!draft} aria-pressed={draft?.chip === chip.value}
              onclick={() => onPatch({ chip: draft?.chip === chip.value ? undefined : chip.value })}>{chip.label}</button>
          {/each}
          <input class="note" disabled={!draft} value={draft?.note ?? ''} placeholder="Note (optional)" aria-label="Note"
            oninput={(e) => onPatch({ note: e.currentTarget.value || undefined })} />
        </div>
      {/if}

      <div class="tools">
        <button class:on={panel === 'full'} onclick={() => show('full')}>Full conversation</button>
        <button class:on={panel === 'jev'} onclick={() => show('jev')}>What Jev saw</button>
        {#if a}<button class:on={panel === 'data'} onclick={() => show('data')}>Assessment data</button>{/if}
      </div>
      {#if panel === 'jev'}<pre class="raw">{JSON.stringify(item.representation, null, 2)}</pre>{/if}
      {#if panel === 'data'}<pre class="raw">{JSON.stringify({ model: item.actual_model ?? item.model, policyId: item.policy_id, rubricVersion: item.rubric_version, answers: a }, null, 2)}</pre>{/if}
      {#if panel === 'full'}
        {#if fullError}<p class="error">{fullError}</p>
        {:else if fullContent}
          {#each fullContent as message (message.id)}
            <div class="full">
              <p class="meta"><strong>{message.from}</strong><span>{message.date}</span></p>
              {#if message.html}<iframe title="Sanitized email content" sandbox="" srcdoc={message.html}></iframe>
              {:else if message.text}<div class="body">{message.text}</div>
              {:else}<p class="muted">No body content available.</p>{/if}
            </div>
          {/each}
        {:else}<p class="muted">Loading the conversation from Gmail…</p>{/if}
      {/if}
    </div>
  {/if}
</article>

<style>
  .row { position: relative; border-top: 1px solid var(--line); background: var(--surface); scroll-margin: 44px 0 72px; }
  .row:focus { outline: none; }
  .row.focused::before { content: ''; position: absolute; left: 0; top: -1px; bottom: 0; width: 3px; background: var(--focus); z-index: 1; }
  .row.focused > .line, .row.open > .line { background: var(--row-focus); }
  .line {
    display: grid;
    grid-template-columns: 12px 16px var(--who-width) minmax(0, 1fr) auto 3.5rem auto;
    align-items: center;
    column-gap: .6rem;
    min-height: 30px;
    padding: 0 .6rem 0 .75rem;
    font-size: 13px;
  }
  .line:hover { background: var(--row-hover); }

  .signal { display: flex; align-items: flex-end; gap: 1.5px; height: 10px; }
  .signal i { width: 2.5px; border-radius: 1px; background: var(--line-strong); }
  .signal i:nth-child(1) { height: 4px; } .signal i:nth-child(2) { height: 7px; } .signal i:nth-child(3) { height: 10px; }
  .signal[data-tier='1'] i:nth-child(-n + 1), .signal[data-tier='2'] i:nth-child(-n + 2), .signal[data-tier='3'] i { background: var(--ink-2); }
  .cat { color: var(--ink-4); display: flex; }

  .who, .what { display: flex; align-items: baseline; min-width: 0; gap: .4rem; border: 0; background: none; padding: 0; font: inherit; color: inherit; text-align: left; cursor: pointer; white-space: nowrap; }
  .who:focus-visible, .what:focus-visible { outline: 2px solid var(--focus); outline-offset: 2px; border-radius: 3px; }
  .name { overflow: hidden; text-overflow: ellipsis; color: var(--ink); font-weight: 550; }
  .via { flex-shrink: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink-4); font-size: 11.5px; }
  .count { flex-shrink: 0; color: var(--ink-3); font-size: 11.5px; font-variant-numeric: tabular-nums; }
  .subject { flex-shrink: 0; max-width: 100%; overflow: hidden; text-overflow: ellipsis; color: var(--ink); }
  .snip { min-width: 0; overflow: hidden; text-overflow: ellipsis; color: var(--ink-3); }
  .what:hover .subject { text-decoration: underline; text-decoration-color: var(--line-strong); text-underline-offset: 2px; }
  .quiet .name, .quiet .subject { color: var(--ink-2); font-weight: 450; }
  .quiet .snip { color: var(--ink-4); }

  .tags { display: flex; align-items: center; gap: .3rem; justify-self: end; }
  .tag { padding: 1px 6px; border-radius: 4px; font-size: 11px; font-weight: 550; white-space: nowrap; }
  .tag.warn { background: var(--warn-bg); color: var(--warn); }
  .tag.time { background: var(--time-bg); color: var(--time); }
  .tag.muted { background: var(--sunken); color: var(--ink-3); }
  .clip { color: var(--ink-3); display: flex; }
  time { color: var(--ink-3); font-size: 12px; font-variant-numeric: tabular-nums; text-align: right; white-space: nowrap; }
  .decided time { color: var(--ink-4); }
  .decide { display: flex; justify-content: flex-end; align-items: center; gap: .4rem; }

  .outcome { font-size: 12px; font-weight: 600; white-space: nowrap; }
  .outcome.label_todo { color: var(--todo); } .outcome.archive { color: var(--archive); } .outcome.trash { color: var(--trash); }
  .outcome.leave { color: var(--leave); } .outcome.undone { color: var(--ink-4); text-decoration: line-through; } .outcome.failed { color: var(--trash); }
  .undo { display: inline-flex; align-items: center; gap: .25rem; height: 22px; padding: 0 .5rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); color: var(--ink-2); font: inherit; font-size: 11.5px; cursor: pointer; }
  .undo:hover { border-color: var(--ink-3); color: var(--ink); }
  .receipt .name, .receipt .subject { color: var(--ink-2); font-weight: 450; }

  .followup { display: flex; justify-content: flex-end; align-items: center; gap: .5rem; padding: 0 .6rem 6px; font-size: 12px; color: var(--done); font-weight: 550; }

  .detail { padding: .5rem 1.25rem 1rem calc(.75rem + 12px + 16px + 1.2rem); border-top: 1px dashed var(--line); background: var(--row-focus); font-size: 13px; }
  .meta { display: flex; flex-wrap: wrap; gap: .25rem 1rem; margin: 0 0 .5rem; color: var(--ink-3); font-size: 12px; }
  .meta strong { color: var(--ink); font-weight: 600; }
  .addr { color: var(--ink-3); }
  .meta a { display: inline-flex; align-items: center; gap: .2rem; color: var(--todo); text-decoration: none; font-weight: 550; }
  .meta a:hover { text-decoration: underline; }
  .read { display: flex; flex-wrap: wrap; gap: .25rem 1.4rem; margin: 0 0 .6rem; color: var(--ink-2); font-size: 12px; }
  .read div { display: flex; gap: .4rem; align-items: center; }
  .read dt { color: var(--ink-4); }
  .read dd { margin: 0; display: flex; align-items: center; gap: .3rem; color: var(--ink); }
  .read .p { color: var(--ink-3); font-variant-numeric: tabular-nums; }
  .meter { width: 36px; height: 5px; border-radius: 3px; background: var(--line-strong); overflow: hidden; }
  .meter i { display: block; height: 100%; background: var(--ink-2); }
  .why { margin: 0 0 .6rem; padding: .4rem .6rem; border-radius: 6px; background: var(--warn-bg); color: var(--ink-2); font-size: 12.5px; max-width: 72ch; }
  .why strong { color: var(--warn); }
  .body { max-width: 76ch; max-height: 11rem; overflow: auto; margin: 0 0 .5rem; padding: .6rem .8rem; border: 1px solid var(--line); border-radius: 6px; background: var(--surface); color: var(--ink); line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; }
  .files { display: flex; align-items: center; gap: .3rem; margin: 0 0 .5rem; color: var(--ink-3); font-size: 12px; }

  .feedback { display: flex; flex-wrap: wrap; align-items: center; gap: .35rem; margin: .6rem 0 .4rem; }
  .feedback .label { margin-right: .2rem; color: var(--ink-3); font-size: 12px; }
  .feedback.inactive .label { color: var(--ink-4); }
  .chip { height: 24px; padding: 0 .6rem; border: 1px solid var(--line-strong); border-radius: 999px; background: var(--surface); color: var(--ink-2); font: inherit; font-size: 12px; cursor: pointer; }
  .chip:hover:not(:disabled) { border-color: var(--ink-3); }
  .chip.on { background: var(--ink); border-color: var(--ink); color: #fff; }
  .chip:disabled { opacity: .45; cursor: default; }
  .note { flex: 1 1 12rem; max-width: 22rem; height: 24px; padding: 0 .6rem; border: 1px solid var(--line-strong); border-radius: 6px; background: var(--surface); font: inherit; font-size: 12px; color: var(--ink); }
  .note:disabled { opacity: .45; }
  .note:focus { outline: 2px solid var(--focus); outline-offset: -1px; }

  .tools { display: flex; gap: .2rem; margin-top: .3rem; }
  .tools button { height: 24px; padding: 0 .55rem; border: 0; border-radius: 5px; background: none; color: var(--ink-3); font: inherit; font-size: 12px; cursor: pointer; }
  .tools button:hover { background: var(--sunken); color: var(--ink); }
  .tools button.on { background: var(--sunken); color: var(--ink); font-weight: 600; }
  .raw { max-height: 22rem; overflow: auto; padding: .6rem .8rem; border-radius: 6px; background: var(--sunken); font: 11.5px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace; white-space: pre-wrap; overflow-wrap: anywhere; }
  .full { margin-top: .6rem; }
  iframe { width: 100%; max-width: 76ch; height: 26rem; border: 1px solid var(--line); border-radius: 6px; background: #fff; }
  .error { color: var(--trash); }
  .muted { color: var(--ink-3); }

  /* Mid widths: a two-line mail-client row keeps the subject readable beside the toggle. */
  @media (min-width: 721px) and (max-width: 1000px) {
    .line { grid-template-columns: 12px 16px minmax(0, 1fr) auto 3.5rem auto; grid-template-areas: 'sig cat who tags time decide' '. . what what what decide'; row-gap: 1px; padding-block: 5px; }
    .signal { grid-area: sig; } .cat { grid-area: cat; } .who { grid-area: who; } .tags { grid-area: tags; } time { grid-area: time; }
    .what { grid-area: what; } .decide { grid-area: decide; padding-left: .4rem; }
  }
  @media (max-width: 720px) {
    .line { grid-template-columns: 12px 16px minmax(0, 1fr) auto; grid-template-areas: 'sig cat who time' '. . what what' '. . tags tags' 'decide decide decide decide'; row-gap: 2px; padding: .45rem .6rem; }
    .signal { grid-area: sig; } .cat { grid-area: cat; } .who { grid-area: who; } time { grid-area: time; }
    .what { grid-area: what; flex-direction: column; gap: 0; } .what .snip { max-width: 100%; }
    .tags { grid-area: tags; justify-self: start; } .tags:empty { display: none; }
    .decide { grid-area: decide; margin-top: .3rem; }
    .detail { padding-left: 1rem; }
  }
</style>
