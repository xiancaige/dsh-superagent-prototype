/** Type-only management API contract between the web panel and host routes, imported by the panel without bundling host code. */
import type { ModelCatalog } from '@deepseek-ai/dsh-api-session-controller/types'
import type { PromptConfig, Prompts } from './prompts.ts'
import type { PromptsView, StateView, TicketPageView } from './http.ts'
import type { HistoryView } from './settings-history.ts'
import type { OverviewView } from './views/overview.ts'
import type { SettingsView } from './views/settings.ts'
import type { SourceStatusView } from './views/sources.ts'
import type { DecisionListView, SearchView, ThreadDetailView, ThreadListView } from './views/threads.ts'
import type { TicketListView } from './views/tickets.ts'

export const TICKET_FILTERS = ['open', 'person', 'working', 'idle', 'ended'] as const
export const THREAD_FILTERS = ['subscribed', 'evaluating', 'recent', 'all'] as const
export type TicketFilter = typeof TICKET_FILTERS[number]
export type ThreadFilter = typeof THREAD_FILTERS[number]
interface Paged { offset?: number; limit?: number }
/** Whether a context update was already injected into the main Session or is still pending delivery. */
type Delivery = 'injected' | 'pending'

export interface Api {
  'POST local/messages': { body: { id: string; text: string; thread?: string }; response: import('../sources/local.ts').LocalReceipt }
  'GET local/messages': { query: { thread: string }; response: { thread: string; messages: import('../sources/local.ts').LocalMessage[] } }
  'GET state': { response: StateView }
  /** Phase 2 C: the shared TP environment's holder, its heartbeat, and the last release. */
  'GET environment': { response: import('./environment-exclusive.ts').EnvironmentExclusivityView }
  'GET overview': { response: OverviewView }
  'GET search': { query: { q: string }; response: SearchView }
  'GET sources': { response: SourceStatusView[] }
  'GET settings': { response: SettingsView }
  'POST sources/:id/labels': { response: { added: string[] } }
  'GET threads': { query?: Paged & { filter?: ThreadFilter }; response: ThreadListView }
  'GET threads/:key': { query?: { limit?: number; before?: string; around?: string }; response: ThreadDetailView }
  'POST threads/:key/unsubscribe': { response: { removed: boolean; thread: string; context_delivery: Delivery } }
  'POST triggers/:id/requeue': { response: { queued: boolean } }
  'GET decisions': { query?: Paged & { kind?: string; window?: '24h' }; response: DecisionListView }
  'POST decisions/:id/dismiss': { response: { dismissed: true } }
  'GET tickets': { query?: Paged & { state?: TicketFilter }; response: TicketListView }
  'GET tickets/:id': { response: TicketPageView }
  /** Trusted design contract/approval; intentionally no worker approval tool. */
  'GET tickets/:id/design': { response: { designApproval: import('../core/design.ts').DesignApproval | null } }
  'PUT tickets/:id/design': { body: import('../core/design.ts').DesignConfiguration; response: { designApproval: import('../core/design.ts').DesignApproval } }
  'POST tickets/:id/design': { body: import('../core/design.ts').DesignApprovalInput; response: { designApproval: import('../core/design.ts').DesignApproval } }
  /** Trusted operator-attested workflow review, independent of strict test acceptance. */
  'GET tickets/:id/review': { response: { review: import('../core/review.ts').IndependentReview | null } }
  'PUT tickets/:id/review': { body: import('../core/review.ts').ReviewConfiguration; response: { review: import('../core/review.ts').IndependentReview } }
  'POST tickets/:id/review': { body: import('../core/review.ts').ReviewDecisionInput; response: { review: import('../core/review.ts').IndependentReview } }
  'PUT tickets/:id/validation': { body: { enabled: true; contract?: Omit<import('../validation.ts').ValidationContractInput, 'revision'> }; response: { validation: import('../core/validation.ts').StrictValidation } }
  'GET tickets/:id/validation': { response: { validation: import('../core/validation.ts').StrictValidation | null } }
  'POST tickets/:id/retry': { response: { retried: true } }
  'POST tickets/:id/stop': { response: { stopped: true } }
  'GET tickets/:id/delivery': { response: import('../core/delivery.ts').DeliveryState }
  'PUT tickets/:id/delivery': { body: { level: import('../core/delivery.ts').DeliveryLevel; granted: boolean }; response: import('../core/delivery.ts').DeliveryState }
  'POST tickets/:id/delivery': { body: { level: import('../core/delivery.ts').DeliveryLevel; assignmentId: string; requestId: string }; response: import('../core/delivery.ts').DeliveryResult }
  /** Phase 2 C: a person hands the ticket's TP environment over; the host exports the scene first or refuses. */
  'POST tickets/:id/environment/handover': { body: { stop?: boolean }; response: { handedOver: boolean; export?: string; files: number; error?: string } }
  /** Phase 2 C/D: an operator takes the environment again for a ticket that gave it back (for example after acceptance, before delivery). */
  'POST tickets/:id/environment/acquire': { response: { held: true } }
  /** Phase 2 C/D: an operator gives back the environment an ended ticket still holds (editor stopped first). */
  'POST tickets/:id/environment/release': { response: { released: boolean; error?: string } }
  /** Phase 2 D: an operator settles an unresolved delivery attempt against the target's own receipt. */
  'POST tickets/:id/delivery/reconcile': { body: { operationKey: string; result: 'delivered' | 'discarded'; receipt?: string; reason?: string }; response: { state: string } }
  'POST executor/pause': { body: { paused: boolean }; response: { paused: boolean } }
  'PUT settings/:block': { body: { value: unknown; revision: number }; response: { revision: number; restarting: boolean } }
  'GET policy/history': { response: HistoryView }
  'POST policy-sync/:id': { response: { policy: unknown } }
  'POST setup/check': { response: { restarting: true } }
  'GET models': { response: ModelCatalog }
  'GET prompts': { query?: { revision?: number; offset?: number }; response: PromptsView }
  'PUT prompts': { body: { config: PromptConfig; baseRevision: number }; response: { revision: number; context_delivery: Delivery } }
  'POST prompts/preview': { body: PromptConfig; response: ReturnType<Prompts['preview']> }
}
type Path<K> = K extends `${string} ${infer P}` ? P : never
type Params<P> = P extends `${string}:${infer Name}/${infer Rest}` ? Record<Name, string> & Params<Rest>
  : P extends `${string}:${infer Name}` ? Record<Name, string> : unknown
export type RouteParams<K extends keyof Api> = Params<Path<K>>
export type ApiRequest<K extends keyof Api> = RouteParams<K> & Omit<Api[K], 'response'>
export type ApiResponse<K extends keyof Api> = Api[K]['response']
