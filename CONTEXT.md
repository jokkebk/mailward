# Mailward

Mailward is an email triage context where rules propose reversible actions for human review and eventual automation.

## Language

**Per-thread disposition review**:
Reviewing each proposed email thread as its own decision, even when multiple threads are grouped under one rule. The user confirms or changes the disposition for each thread rather than approving or rejecting the whole group as a single unit.
_Avoid_: batch amend, selected approve

**AI router rule**:
A rule whose output is an editable set of per-thread disposition recommendations. Unlike a deterministic rule, an AI router rule may recommend different dispositions for different threads in the same review group.
_Avoid_: multi-action deterministic rule

**Skip**:
A per-thread review outcome that leaves the thread untouched and does not count for or against rule promotion. It means the user is not giving useful corrective feedback for that recommendation.
_Avoid_: amend without note

**Correct**:
A per-thread review outcome that leaves the thread untouched while recording corrective feedback against the recommendation. It requires a note because the weekly review needs the user's reason to learn from it.
_Avoid_: skip with note, skip and amend

**Review note**:
Optional human context attached to a per-thread review outcome, except that Correct requires one. Review notes are for later rule analysis, not for immediate Gmail handling.
_Avoid_: amend note

**AI reason**:
The model's rationale for a recommended disposition. It is supporting context for uncertain rows, not the primary review surface.
_Avoid_: showing every rationale inline

**Correction**:
A user's corrective signal that a recommendation should have been different. Choosing a different disposition is negative feedback for the recommendation and positive feedback for the chosen disposition; choosing Correct is a do-nothing correction; choosing Skip is not a correction.
_Avoid_: amend

**Disposition**:
The intended handling outcome for a thread during review: Trash, Archive, TODO, Skip, or Correct. The first three mutate Gmail state; Skip and Correct leave the thread untouched.
_Avoid_: action when referring to Skip or Correct

**TODO**:
A disposition for a thread that needs the user's attention, reading, reply, or decision. TODO is the correct choice when the user wants to be sure the thread remains visible for later handling.
_Avoid_: read later, mark read

**Reviewed set**:
The draft per-thread dispositions in an AI review group at the moment the user submits them. Row changes do not affect Gmail until the reviewed set is applied.
_Avoid_: immediate apply, live edit

**Apply reviewed**:
The submit action for an AI review group. It applies the user's current reviewed set, including unchanged recommendations, changed dispositions, Skips, Corrects, and review notes.
_Avoid_: approve, amend

**Reject group**:
A review outcome for rejecting every recommendation in a group without changing Gmail state. Rejection requires a reason and can optionally suspend the rule until it is revised.
_Avoid_: separate suspend action

**Reset suggestions**:
A review helper that restores every thread in an AI review group to the AI's original recommendations. It does not submit or apply any disposition.
_Avoid_: undo when no action has been applied

**Suggested section**:
The display bucket for threads that share the same AI-recommended disposition. A thread stays in its suggested section while the user edits the reviewed set, even if the user chooses a different disposition.
_Avoid_: live regrouping
