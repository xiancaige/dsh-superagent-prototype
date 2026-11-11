/** Reusable proactive-agent core: model, ports, engine and in-memory repositories. */
export * from './model.ts'
export * from './ports.ts'
export { Engine, type EngineForExecutor, type EngineForMainSession, type EngineForPeople, type EngineForSettings, type EngineForSources,
  type EngineOptions, type Outcome, type ReceiveResult, type Reply, type ReplyRequest, type WorkerReport } from './engine.ts'
export { UserError, USER_ERRORS, type UserErrorCode } from './errors.ts'
export { REASONS, reasonText, said, type Reason, type ReasonCode } from './reasons.ts'
export { MemoryRepositories } from './memory.ts'
export { canRetry, ticketStage, type TicketStage } from './stage.ts'
export { key } from './ids.ts'
export { assertTicketValidated } from './validation.ts'
export { acceptanceProfile, assertAdapterForRole, ticketAcceptanceProfile, type AcceptanceProfile } from './acceptance.ts'
export { DELIVERY_LEVELS, type DeliveryLevel, type DeliveryState, type DeliveryAttempt, type DeliveryTarget, type DeliveryResult } from './delivery.ts'
