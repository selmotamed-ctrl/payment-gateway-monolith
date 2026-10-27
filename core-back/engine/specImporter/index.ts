export {
  IntegrationSpecSchema,
  SPEC_VERSION,
  SPEC_TRANSFORM_OPERATIONS,
  SPEC_AUTH_METHODS,
  SPEC_FLOW_PHASES,
  SPEC_PARAMETER_SOURCES,
  SPEC_STEP_TYPES,
  type IntegrationSpec,
  type FlowSpecType,
  type FlowStepSpecType,
  type TestVectorSpecType,
  type RequiredCredentialSpecType,
} from "./specSchema";
export { validateSpecSemantics, type SpecDiagnostic, type SpecSemanticResult } from "./specValidator";
export {
  simulateSpec,
  buildRepairPrompt,
  type VerificationReport,
  type VectorOutcome,
  type VerificationLayer,
  type CollisionResult,
  type SimulateOptions,
} from "./SpecSimulator";
export {
  materializeSpec,
  parseImportRequest,
  type MaterializeInput,
  type MaterializeResult,
  type ImportMode,
} from "./SpecMaterializer";
export { buildTranscriptKit, type TranscriptKit, type TranscriptOptions } from "./TranscriptBuilder";
