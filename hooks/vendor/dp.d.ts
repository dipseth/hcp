// The slice of @rivers/decision-pipeline that hcp touches. dp.js is the whole
// core plus zod, bundled by build/bundle.sh from github.com/dipseth/decision-pipeline;
// the package ships no declarations, so these follow its src/ by hand.

export type Distributions = Record<string, number[]>

export type DecideRequest = {
  nodeId: string
  nodeVersion: string
  questions: string | null
  input: unknown
  signal?: AbortSignal
}

export type DecideResult = {
  distributions: Distributions
  distributionOptions?: Record<string, string[]>
  value?: unknown
  costUsd?: number
}

export type GenerateRequest = { nodeId: string; prompt: string; route: string; input: unknown }

export type GenerateResult = { value: unknown; costUsd?: number; promptVersion?: string }

export type ScoreRequest = {
  runId: string
  name: string
  value: number
  label?: string
  dataType: string
  comment?: string
}

export type RunRecordNode = {
  id: string
  kind: string
  ms: number
  cost_usd: number
  skipped?: string
  branch?: string
  branch_reason?: string
  distributions?: Distributions
  thresholds?: Record<string, number>
}

export type RunRecord = {
  pipeline: string
  version: string
  run_id: string
  run_key: string
  cost_usd: number
  ms: number
  nodes: RunRecordNode[]
  fact_route: string
  features?: Record<string, number>
}

export type RunResult = {
  output: unknown
  runId: string | null
  runKey: string
  version: string
  route: string
  confidence: number | null
  record: RunRecord
  skipped: Record<string, string>
}

export type PipelinePorts = {
  decide?: (request: DecideRequest) => Promise<DecideResult>
  generate?: (request: GenerateRequest) => Promise<GenerateResult>
  records?: (record: RunRecord) => Promise<void> | void
  scores?: (request: ScoreRequest) => Promise<void> | void
  clock?: () => number
}

export type Pipeline = { readonly id: string; readonly order: readonly string[]; toJSON: () => unknown }

export type NodeRunArgs = {
  input: unknown
  primary: unknown
  thresholds: Record<string, number>
  branches: Record<string, { branch: string; reason?: string; confidence?: number }>
}

/** zod, as bundled with the core: only what the manifest's schemas use. */
export type Schema = { readonly _zod: unknown }
export const z: {
  object: (shape: Record<string, Schema>) => Schema
  string: () => Schema
  unknown: () => Schema
  array: (of: Schema) => Schema
}

export class PipelineContractError extends Error {
  problems: string[]
}

export const definePipeline: (manifest: Record<string, unknown>) => Pipeline

export const runPipeline: (
  pipeline: Pipeline,
  input: unknown,
  ports: PipelinePorts,
  options?: { runKey?: string; trigger?: string },
) => Promise<RunResult>

export const submitFeedback: (
  pipeline: Pipeline,
  submission: { runId: string; runKey?: string; edgeId: string; value?: number; label?: string; comment?: string; sourceId: string },
  ports: PipelinePorts,
) => Promise<{ scored: boolean; warnings: string[] }>

export const JEV_MODEL: string
export const JEV_ENDPOINT: string

export type JevQuestion = { type: 'noul' | 'choice' | 'score'; instructions: string; [key: string]: unknown }
export type JevRequestBody = { model: string; state: unknown; questions: Record<string, JevQuestion> }
export type JevAnswer = { type?: string; noul?: number; probabilities?: Record<string, number>; [key: string]: unknown }
export type JevUsage = { input_tokens?: number; output_tokens?: number }

export const checkJevRequest: (body: JevRequestBody) => string[]
export const jevHeaders: (apiKey: string, body: Pick<JevRequestBody, 'questions'>) => Record<string, string>
export const jevAnswersToDecideResult: (
  answers: Record<string, JevAnswer>,
  options?: { usage?: JevUsage; costUsd?: (usage: JevUsage) => number },
) => DecideResult

export const stableStringify: (value: unknown) => string
export const sha256Hex: (input: string) => string
