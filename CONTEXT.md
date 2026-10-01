# Mailward language

**Assessment**: A durable snapshot of typed judgments and their distributions
for one thread representation under a specific policy, rubric, and model.
Assessment is separate from a review decision and Gmail execution.

**Policy**: Compact, versioned preferences supplied with each Jev request. A new
revision stays review-first and inherits no automation trust. In the UI the
policy is called **guidance**.

**Guidance card**: One titled, switchable part of the policy. Only enabled card
bodies reach Jev; the title is for people.

**Representation**: The bounded, deterministic record of unread content that
Jev sees, including explicit omissions and unavailable evidence.

**Needs action**: Mail requiring the user's action, reply, or decision. It stays
visible as TODO until explicitly completed or otherwise reviewed.

**Worth checking out**: Relevant mail worth reading without an obligation. It
also stays visible as TODO, in its own section.

**Show before clearing**: Mail that warrants a glance before disposal. A model
reading it does not count as human acknowledgement.

**Needs a decision**: Unresolved handling because evidence is missing or
conflicting. A leaning is context, not a firm proposal.

**Disposition**: Intended handling: Trash, Archive, TODO (`label_todo`), or Leave.
Trash uses reversible Gmail trash; Archive clears inbox/unread; TODO preserves
unread state; Leave does not mutate Gmail.

**Done/handled**: A review event saying the attention was satisfied. Its chosen
final handling may archive, trash, label TODO, or leave the thread untouched.
Completion is not a classifier correction.

**Correction**: A different per-email disposition than the proposal, with an
optional chip or note. It is instance feedback, not a new global rule.

**Reviewed set**: Draft per-thread decisions. Editing or accepting a suggestion
does not change Gmail; Apply submits the set for validation and execution.

**Receipt**: A submitted review joined with its actual execution outcome.
Applied actions link to the reversible action ledger; Leave has no action.

**Recipe**: A versioned JSON filter over message metadata that proposes Trash,
Archive or TODO without a Jev call. Recipes are adopted, not enabled: the account
holds its own copy. Matches are reviewable like any assessment. Stored rows call
these rule assessments (`assessment_source = 'rule'`). Distinct from the retired
v2 rule engine, which mixed AI and rule tiers with auto-apply.
