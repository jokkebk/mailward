export type Handling = 'trash' | 'archive' | 'label_todo' | 'leave';
export type Attention = 'act' | 'read' | 'glance' | 'none' | 'unclear';
export type Retention = 'keep' | 'disposable' | 'unclear';
export type Category = 'sales' | 'notification' | 'newsletter' | 'transaction' | 'conversation' | 'other';
export type Gap = 'sufficient' | 'more_body' | 'conversation' | 'attachment' | 'user_context';
export type ReviewKind = 'approve' | 'correct' | 'skip' | 'done';

export interface PreparedMessage {
  id: string;
  from: string;
  to: string;
  cc: string;
  replyTo: string;
  deliveredTo: string;
  subject: string;
  date: string;
  labels: string[];
  body: string;
  originalChars: number;
  retainedChars: number;
  clipped: boolean;
  missingBody: boolean;
  attachmentsNotRead: boolean;
  hasUnsubscribe: boolean;
  isCalendarInvite: boolean;
  attachments: { name: string; mime: string; inline?: boolean; calendar?: boolean }[];
  calendar?: { kind: 'response' | 'invitation' | 'update' | 'other'; eventTime: string | null; note: string | null; generatedDescription: boolean; responseOnly?: boolean; endsAt?: string | null; ended?: boolean | null };
  links: { label: string; url: string }[];
}

export interface Representation {
  version: 1 | 2 | 3;
  threadId: string;
  messageIds: string[];
  omittedUnread: number;
  historyNotFetched: true;
  messages: PreparedMessage[];
  unavailable: string[];
}

export interface ChoiceAnswer<T extends string = string> {
  type: 'choice';
  choice: T;
  probabilities: Record<T, number>;
  confidence: number;
}
export interface ScoreAnswer {
  type: 'score';
  score: number;
  probabilities: Record<string, number>;
  confidence: number;
}
export interface Assessment {
  category: ChoiceAnswer<Category>;
  attention: ChoiceAnswer<Attention>;
  retention: ChoiceAnswer<Retention>;
  urgency: ScoreAnswer;
  relevance: ScoreAnswer;
  gap: ChoiceAnswer<Gap>;
}

export type Lane = 'needs_action' | 'worth_reading' | 'show_me' | 'decision' | 'cleanup';

/** One assessed thread as the review API returns it, joined with any submitted review. */
export interface ReviewItem {
  id: string;
  thread_id: string;
  assessment_source?: string | null;
  deterministic_rule?: string | null;
  deterministic_version?: number | null;
  representation: Representation;
  answers: Assessment | null;
  proposed_action: Handling;
  final_action: Handling;
  lane: Lane;
  reason: string;
  priority: number;
  status: 'ready' | 'unresolved';
  error: string | null;
  created_at: number;
  model?: string;
  actual_model?: string | null;
  policy_id?: string;
  rubric_version?: number;
  review_kind: ReviewKind | null;
  review_disposition: Handling | null;
  review_final_disposition?: Handling | null;
  review_chip?: string | null;
  review_action_id: string | null;
  execution_status: string | null;
  action_status: string | null;
  review_error: string | null;
}

export interface ReviewDecision {
  assessmentId: string;
  disposition: Handling;
  kind: ReviewKind;
  finalDisposition?: Handling;
  acknowledged?: boolean;
  chip?: 'already_handled' | 'other_owner' | 'worth_reading' | 'actual_receipt' | 'show_before_clearing';
  note?: string;
}
