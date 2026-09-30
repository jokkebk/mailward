<script lang="ts">
  import type { Assessment, Representation, ReviewDecision, Handling } from '$lib/types/v3';
  type Item = {
    id: string; thread_id: string; assessment_source?: string; deterministic_rule?: string; deterministic_version?: number; representation: Representation; answers: Assessment | null;
    proposed_action: string; final_action: string; lane: string; reason: string; status: string; error: string | null;
    review_kind: string | null; review_disposition: string | null; review_action_id: string | null;
    execution_status: string | null; action_status: string | null; review_error: string | null;
  };
  let { item, draft, onChange, onUndo, accountId }: {
    item: Item; draft?: ReviewDecision; onChange: (d: ReviewDecision | null) => void;
    onUndo: (id: string) => void; accountId: string;
  } = $props();
  let expanded = $state(false);
  let inspect = $state(false);
  let details = $state(false);
  let full = $state(false);
  let fullContent = $state<{ messages: { id: string; from: string; date: string; html: string | null; text: string | null }[] } | null>(null);
  let fullError = $state('');
  const first = $derived(item.representation.messages[0]);
  const sender = $derived((first?.from || 'Unknown sender').replace(/<[^>]+>/g, '').trim().replace(/^["']|["']$/g, '').trim() || first?.from || 'Unknown');
  const actionLabel: Record<string, string> = { label_todo: 'TODO', archive: 'Archive', trash: 'Trash', leave: 'Leave untouched' };
  const selected = $derived(draft?.kind === 'done' ? 'done' : draft?.disposition ?? '');
  function base(): ReviewDecision { return draft ?? { assessmentId: item.id, disposition: item.proposed_action as Handling, kind: 'approve' }; }
  function setDisposition(value: Handling) {
    onChange({ ...base(), disposition: value, kind: value === 'leave' ? 'skip' : value === item.proposed_action && item.status === 'ready' ? 'approve' : 'correct', finalDisposition: undefined });
  }
  function choose(value: string) {
    if (!value) onChange(null);
    else if (value === 'done') setDone();
    else setDisposition(value as Handling);
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
  <div class="mail-row">
    <button class="expand" aria-expanded={expanded} aria-label={`${expanded ? 'Collapse' : 'Open'} ${first?.subject || 'message'}`} onclick={() => (expanded = !expanded)}>{expanded ? '−' : '+'}</button>
    <span class="sender" title={first?.from}>{sender}</span>
    <button class="subject" title={first?.subject} onclick={() => (expanded = !expanded)}>{first?.subject || '(no subject)'}</button>
    {#if item.assessment_source === 'rule'}<span class="origin rule" title={`${item.deterministic_rule} · v${item.deterministic_version}`}>Rule</span>{/if}
    <span class="reason" title={`${item.reason}${item.error ? ` · ${item.error}` : ''}`}>{item.reason.replace(/^(notification|newsletter|sales|conversation|transaction|other) · /, '')}</span>
    {#if item.review_kind}
      <span class="status">{actionLabel[item.review_disposition ?? ''] ?? item.review_disposition} · {item.action_status ?? item.execution_status}</span>
      {#if item.review_action_id && item.action_status === 'applied'}<button onclick={() => onUndo(item.review_action_id!)}>Undo</button>{/if}
    {:else}
      <select aria-label={`Decision for ${first?.subject || 'message'}`} value={selected} onchange={(e) => choose(e.currentTarget.value)}>
        <option value="">{item.status === 'unresolved' ? 'Choose…' : item.lane === 'show_me' ? 'Show first' : `${actionLabel[item.proposed_action]}?`}</option>
        <option value="label_todo">TODO</option><option value="archive">Archive</option><option value="trash">Trash</option><option value="leave">Leave</option><option value="done">Handled</option>
      </select>
      {#if draft?.kind === 'done'}<select aria-label="After completion" value={draft.finalDisposition} onchange={(e) => onChange({ ...draft!, finalDisposition: e.currentTarget.value as Handling })}><option value="archive">Archive</option><option value="trash">Trash</option><option value="leave">Leave</option></select>{/if}
      {#if draft && item.lane === 'show_me'}<label class="ack" title="I saw this message"><input type="checkbox" checked={draft.acknowledged ?? false} onchange={(e) => onChange({ ...draft!, acknowledged: e.currentTarget.checked })} /> Seen</label>{/if}
    {/if}
  </div>
  {#if expanded}
  <div class="detail-panel">
    <p class="addresses">{first?.from} → {first?.to} · {first?.date}</p>
    <p>{item.assessment_source === 'rule' ? `Rule: ${item.deterministic_rule} · version ${item.deterministic_version}. ` : ''}{item.reason}{item.error ? ` · ${item.error}` : ''}</p>
    <pre class="preview">{first?.body || 'Message content unavailable.'}</pre>
    <div class="row-actions">
      <button onclick={viewFull}>{full ? 'Hide full message' : 'Read full message'}</button>
      <button onclick={() => (inspect = !inspect)}>{inspect ? 'Hide Jev input' : 'What Jev read'}</button>
      <button onclick={() => (details = !details)}>{details ? 'Hide assessment' : 'Why this suggestion'}</button>
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
    {#if draft && !item.review_kind}
      <div class="feedback">
        <label>Feedback <select value={draft.chip ?? ''} onchange={(e) => onChange({ ...draft!, chip: e.currentTarget.value as ReviewDecision['chip'] || undefined })}>
          <option value="">None</option><option value="already_handled">Already handled</option><option value="other_owner">Someone else owns it</option><option value="worth_reading">Worth reading</option><option value="actual_receipt">Actual receipt</option><option value="show_before_clearing">Show before clearing</option>
        </select></label>
        <label>Note <input value={draft.note ?? ''} placeholder="Optional" oninput={(e) => onChange({ ...draft!, note: e.currentTarget.value })} /></label>
      </div>
    {/if}
  </div>
  {/if}
</article>

<style>
  article { border-bottom:1px solid #e1e5ec;background:#fff } article.chosen { background:#edf3ff } article.reviewed { color:#667085 }
  .mail-row { display:flex;align-items:center;gap:8px;height:23px;padding:0 6px;font-size:12px }
  button,select,input { font:inherit;color:inherit } button { cursor:pointer } .expand { border:0;background:none;width:18px;flex-shrink:0;padding:0;color:#64748b }
  .origin { font-size:10px;border-radius:3px;padding:1px 4px;color:#576b8c;background:#edf1f8;flex-shrink:0 }.origin.rule { color:#326960;background:#e8f3ef }
  .sender { width:150px;flex-shrink:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#465366 }
  .subject { flex:1;min-width:0;text-align:left;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border:0;background:none;padding:0;font-weight:500 }
  .subject:hover { text-decoration:underline }.reason { color:#69778b;width:185px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:11px }
  .mail-row select { width:88px;flex-shrink:0;background:transparent;border:1px solid #ccd5e2;border-radius:3px;height:21px;padding:0 3px }
  .chosen .mail-row select { border-color:#5578c5;color:#244994;background:#f7faff }.ack { display:flex;align-items:center;gap:2px;font-size:11px }.ack input { margin:0;accent-color:#4563b3 }.status { font-size:11px }
  .detail-panel { padding:10px 34px;border-top:1px solid #e1e5ec;font-size:13px }.detail-panel p { margin:4px 0 8px }.addresses { color:#69778b }.row-actions,.feedback,.feedback label { display:flex;align-items:center;gap:8px;flex-wrap:wrap }.row-actions button,.feedback input,.feedback select { border:1px solid #c6cedc;background:#fff;border-radius:4px;padding:4px 7px }.feedback { margin-top:10px }
  .preview,.evidence { white-space:pre-wrap;overflow-wrap:anywhere;max-height:22rem;overflow:auto;background:#f4f6fa;padding:10px;font:12px/1.5 ui-monospace,monospace }.preview { max-height:12rem }
  iframe { width:100%;height:25rem;border:1px solid #d9dee8;background:white }.error { color:#ac2b21 }.full-message { border-top:1px solid #d9dee8;padding:.6rem 0 }.facts { color:#596474 }
  @media(max-width:900px) { .sender { width:115px }.reason { width:130px } } @media(max-width:650px) { .reason { display:none }.sender { width:90px }.mail-row { height:32px } }
</style>
