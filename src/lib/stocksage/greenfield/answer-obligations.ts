import type { TemporalInterval } from "../temporal";
import type { FinanceEntity } from "../types";
import type { GreenfieldInformationNeed } from "./planner";
import type { InformationNeed } from "./semantic-schema";

export type AnswerObligationKind =
  | "define"
  | "snapshot"
  | "compare"
  | "explain_cause"
  | "assess_outlook"
  | "verify_listing"
  | "verify_source";

export type AnswerObligationRelationalMode =
  | "none"
  | "entity_vs_entity"
  | "time_vs_time"
  | "entity_and_time";

export type AnswerObligationTemporalMeaning =
  | "snapshot"
  | "window"
  | "contrast";

/**
 * How a successful obligation is published. Deterministic sections do not
 * depend on document retrieval or narrative composition.
 */
export type AnswerObligationPublicationRole =
  | "deterministic"
  | "narrative";

/**
 * Planner-level IR derived from validated semantic v1 output. It is not sent
 * to the semantic model and can evolve without changing the extraction schema.
 */
export type AnswerObligation = {
  id: string;
  sectionId: string;
  kind: AnswerObligationKind;
  sourceNeedKinds: readonly InformationNeed["kind"][];
  /** Empty when the obligation is implied only by the validated intent. */
  sourceNeedIds: readonly string[];
  priority: InformationNeed["priority"];
  entities: readonly FinanceEntity[];
  intervals: readonly TemporalInterval[];
  temporalMeaning: AnswerObligationTemporalMeaning;
  relationalMode: AnswerObligationRelationalMode;
  sourceEntityMentionIds: readonly string[];
  sourceTemporalSpecIds: readonly string[];
  needs: readonly GreenfieldInformationNeed[];
  publicationRole: AnswerObligationPublicationRole;
};

/** Flattens obligation-local needs for the current monolithic engine. */
export function flattenObligationNeeds(
  obligations: readonly AnswerObligation[]
): GreenfieldInformationNeed[] {
  const needs = new Map<string, GreenfieldInformationNeed>();
  for (const obligation of obligations) {
    for (const need of obligation.needs) {
      if (!needs.has(need.id)) needs.set(need.id, need);
    }
  }
  return [...needs.values()];
}
