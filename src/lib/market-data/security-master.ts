import "server-only";

export { normalizeCorporateActions } from "./corporate-action-normalization";
export { createPolygonSecurityMasterAdapter } from "./security-master-polygon";
export { createSecSecurityMasterAdapter } from "./security-master-sec";
export {
  getCorporateActions,
  getCorporateActionsResult,
  getSecurityMasterSnapshot,
  resolveSecurity,
} from "./security-master-service";
export {
  createYahooSecurityMasterAdapter,
  parseYahooCorporateActions,
} from "./security-master-yahoo";
export type {
  CorporateAction,
  CorporateActionKind,
  CorporateActionProviderDiagnostic,
  CorporateActionRange,
  CorporateActionRetrievalResult,
  InstrumentIdentity,
  InstrumentKind,
  IssuerIdentity,
  ProxyIdentity,
  ResolveSecurityQuery,
  SecurityIdentifier,
  SecurityMasterOptions,
  SecurityMasterProviderAdapter,
  SecurityMasterRecord,
  SecurityMasterSnapshot,
} from "./security-master-types";
