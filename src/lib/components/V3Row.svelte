<script lang="ts">
  import type { Assessment, Representation, ReviewDecision, Handling } from '$lib/types/v3';
  type Item = {
    id: string; thread_id: string; representation: Representation; answers: Assessment | null;
    proposed_action: string; final_action: string; lane: string; reason: string; status: string; error: string | null;
    review_kind: string | null; review_disposition: string | null; review_action_id: string | null;
    execution_status: string | null; action_status: string | null; review_error: string | null;
  };
  let { item, draft, onChange, onUndo, accountId }: {
    item: Item; draft?: ReviewDecision; onChange: (d: ReviewDecision | null) => void;
    onUndo: (id: string) => void; accountId: string;
  } = $props();
  let inspect = $state(false);
  let details = $state(false);
  let full = $state(false);
  let fullContent = $state<{ messages: { id: string; from: string; date: string; html: string | null; text: string | null }[] } | null>(null);
  let fullError = $state('');
  const first = $derived(item.representation.messages[0]);
  const actionLabel: Record<string, string> = { label_todo: 'TODO', archive: 'Archive', trash: 'Trash', leave: 'Leave untouched' };
  const selected = $derived(draft?.kind === 'done' ? 'done' : draft?.disposition ?? '');
  function base(): ReviewDecision { return draft ?? { assessmentId: item.id, disposition: item.proposed_action as Handling, kind: 'approve' }; }
  function setDisposition(value: Handling) {
    onChange({ ...base(), disposition: value, kind: value === 'leave' ? 'skip' : value === item.proposed_action && item.status === 'ready' ? 'approve' : 'correct', finalDisposition: undefined });
  }
  function setDone() { onChange({ ...base(), disposition: 'leave', kind: 'done', finalDisposition: item.final_action as Handling }); }
  async function viewFull() {
    full = !full;
    if (!full || fullContent || !first) return;
    try {
      const res = await fetch(`/api/v3/thread/${encodeURIComponent(item.thread_id)}/content?accountId=${encodeURIComponent(accountId)}`);
      if (!res.ok) throw new Error('Could not load full message');
      fullContent = await res.json();
    } catch (error) { fullError = error instanceof Error ? error.message : String(error); }
  }
</script>

<article class:chosen={!!draft} class:reviewed={!!item.review_kind}>
  <div class="top">
    <div class="heading">
      <strong>{first?.subject || '(no subject)'}</strong>
      <span>{first?.from || 'Unknown sender'}</span>
    </div>
    <span class="status">{item.review_kind ? `${actionLabel[item.review_disposition ?? ''] ?? item.review_disposition} · ${item.action_status ?? item.execution_status}` : item.status === 'unresolved' ? 'Needs your decision' : `Suggested: ${actionLabel[item.proposed_action]}`}</span>
  </div>
  <p class="reason">{item.reason}{item.error ? ` · ${item.error}` : ''}</p>
  <div class="row-actions">
    <button onclick={viewFull}>{full ? 'Hide message' : 'Read full message'}</button>
    <button onclick={() => (inspect = !inspect)}>{inspect ? 'Hide Jev input' : 'What Jev read'}</button>
    <button onclick={() => (details = !details)}>{details ? 'Hide details' : 'Why this suggestion'}</button>
    {#if item.review_action_id && item.action_status === 'applied'}<button onclick={() => onUndo(item.review_action_id!)}>Undo</button>{/if}
  </div>
  {#if inspect}<pre class="evidence">{JSON.stringify(item.representation, null, 2)}</pre>{/if}
  {#if details}
    {#if item.answers}<p class="facts">Attention: {item.answers.attention.choice} · Keep afterward: {item.answers.retention.choice} · Urgency: {item.answers.attention.choice === 'none' ? 'N/A' : item.answers.urgency.score.toFixed(1)} · Relevance: {item.answers.relevance.score.toFixed(1)}</p>{/if}
    <details><summary>Technical assessment</summary><pre class="evidence">{JSON.stringify({ model: (item as any).actual_model ?? (item as any).model, policyId: (item as any).policy_id, rubricVersion: (item as any).rubric_version, answers: item.answers }, null, 2)}</pre></details>
  {/if}
  {#if full}
    {#if fullError}<p class="error">{fullError}</p>
    {:else if fullContent}
      {#each fullContent.messages as message}
        <div class="full-message"><strong>{message.from}</strong> · {message.date}
          {#if message.html}<iframe title="Sanitized email content" sandbox="" srcdoc={message.html}></iframe>
          {:else if message.text}<pre class="evidence">{message.text}</pre>
          {:else}<p>No body content available.</p>{/if}
        </div>
      {/each}
    {:else}<p>Loading full message…</p>{/if}
  {/if}
  {#if !item.review_kind}
    <div class="review-controls">
      <span class="decision-label">Your decision</span>
      <div class="choices">
        <button class:active={selected === 'label_todo'} onclick={() => setDisposition('label_todo')}>Keep in TODO</button>
        <button class:active={selected === 'archive'} onclick={() => setDisposition('archive')}>Archive</button>
        <button class:active={selected === 'trash'} onclick={() => setDisposition('trash')}>Trash</button>
        <button class:active={selected === 'leave'} onclick={() => setDisposition('leave')}>Leave as is</button>
        <button class:active={selected === 'done'} onclick={setDone}>Already handled</button>
        {#if draft}<button class="clear" onclick={() => onChange(null)}>Clear choice</button>{/if}
      </div>
      {#if draft?.kind === 'done'}
        <label>After completion
          <select value={draft.finalDisposition} onchange={(e) => onChange({ ...draft!, finalDisposition: e.currentTarget.value as Handling })}>
            <option value="archive">Archive</option><option value="trash">Trash</option><option value="leave">Leave untouched</option>
          </select>
        </label>
      {/if}
      {#if draft}
        {#if item.lane === 'show_me' || draft.disposition === 'trash'}<label class="ack"><input type="checkbox" checked={draft.acknowledged ?? false} onchange={(e) => onChange({ ...draft!, acknowledged: e.currentTarget.checked })} /> I saw this message</label>{/if}
        <details class="feedback"><summary>Add feedback or a note</summary><label>Feedback
          <select value={draft.chip ?? ''} onchange={(e) => onChange({ ...draft!, chip: e.currentTarget.value as ReviewDecision['chip'] || undefined })}>
            <option value="">None</option><option value="already_handled">Already handled</option><option value="other_owner">Someone else owns it</option><option value="worth_reading">Worth reading</option><option value="actual_receipt">Actual receipt</option><option value="show_before_clearing">Show before clearing</option>
          </select>
        </label>
        <label class="note">Note <input value={draft.note ?? ''} placeholder="Optional" oninput={(e) => onChange({ ...draft!, note: e.currentTarget.value })} /></label></details>
      {/if}
    </div>
  {/if}
</article>

<style>
  article { background:#fff;border:1px solid #d9dee8;border-radius:10px;padding:.9rem;margin:.55rem 0;box-shadow:0 1px 2px #182b4420 }
  article.chosen { border-color:#516bc7;background:#fafbff } article.reviewed { opacity:.78 }
  .top,.row-actions,.review-controls { display:flex;align-items:center;gap:.7rem;flex-wrap:wrap }
  .top { justify-content:space-between } .heading { display:flex;flex-direction:column;gap:.15rem;min-width:0 }
  .heading strong { overflow-wrap:anywhere } .heading span,.facts,.reason { color:#596474;font-size:.85rem;margin:.35rem 0 }
  .status { background:#eef1f8;color:#394a69;border-radius:99px;padding:.2rem .55rem;font-size:.76rem }
  button,select,input { border:1px solid #c6cedc;border-radius:6px;padding:.32rem .5rem;background:white;color:#26344a;font:inherit }
  button { cursor:pointer } .row-actions { margin:.6rem 0 } .row-actions button { font-size:.75rem }
  .review-controls { border-top:1px solid #e7eaf1;padding-top:.8rem;font-size:.8rem;display:block }.decision-label { display:block;font-weight:700;margin-bottom:.45rem;color:#38455a }.choices { display:flex;gap:.35rem;flex-wrap:wrap;margin-bottom:.6rem }.choices button { font-size:.79rem }.choices button.active { background:#dfe8ff;border-color:#375dc1;color:#213f91;font-weight:700 }.choices button.clear { border:0;color:#596474;text-decoration:underline }
  .review-controls label { display:flex;align-items:center;gap:.35rem;margin:.45rem 0 }.ack input { accent-color:#4563b3 }.feedback { margin:.45rem 0;color:#596474 }.feedback summary { cursor:pointer }
  .note input { min-width:12rem } .evidence { white-space:pre-wrap;overflow-wrap:anywhere;max-height:22rem;overflow:auto;background:#f4f6fa;padding:.7rem;font-size:.75rem }
  iframe { width:100%;height:25rem;border:1px solid #d9dee8;background:white }.error { color:#ac2b21 }
  .full-message { border-top:1px solid #d9dee8;padding:.6rem 0;font-size:.8rem }
</style>
