import type { CloudCancelAnswer, CloudRetentionOffer, CloudRetentionStep } from "./cloud-account.mjs";
export declare const CLOUD_CANCEL_ANSWERS: readonly CloudCancelAnswer[];
export declare const CLOUD_RETENTION_OFFERS: readonly CloudRetentionOffer[];
export declare const SURVEY_WAIT_MS: number;
/** The survey as main sends it (trimmed; words without a reason as `other`), or null when it says nothing or isn't one. */
export declare function cancelSurvey(input: unknown): { answer: CloudCancelAnswer; expected?: string; improve?: string; offer?: CloudRetentionOffer } | null;
/** A step of the cancel sheet as main sends it, or null when it isn't one. */
export declare function retentionStep(input: unknown): CloudRetentionStep | null;
