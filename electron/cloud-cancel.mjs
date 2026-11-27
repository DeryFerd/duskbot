// The cancel sheet's words as main sends them to the Admin: the survey that goes with a cancel, and each step of the sheet.
/** The cancel sheet's reasons, as the Admin takes them (shared/billing-api.ts CANCEL_ANSWERS); an older app's still count. */
export const CLOUD_CANCEL_ANSWERS = Object.freeze(["feature", "price", "setup", "broken", "later", "other", "unused", "switching", "skip"]);
/** The one offer the cancel sheet showed for the reason (shared/billing-api.ts RETENTION_OFFERS). */
export const CLOUD_RETENTION_OFFERS = Object.freeze(["discount", "downgrade", "help", "note", "losses", "none"]);
const RETENTION_STEPS = Object.freeze(["reason", "help", "confirm"]);
const RETENTION_OUTCOMES = Object.freeze(["shown", "discount", "downgrade", "helped", "kept", "cancelled"]);
const SURVEY_TEXT_MAX = 2_000;
/** How long the survey and a step of the sheet may take before the cancel goes on without them. */
export const SURVEY_WAIT_MS = 8_000;
const surveyBox = value => typeof value === "string" ? value.trim() : "";
/**
 * The cancel sheet's survey as main sends it: one reason, the offer it showed, and each box trimmed, at most 2,000
 * characters. Words without a reason are kept as `other`; null when nothing was said, and for anything that isn't a
 * survey (it is never sent then).
 */
export function cancelSurvey(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const answer = CLOUD_CANCEL_ANSWERS.includes(input.answer) ? input.answer : null, expected = surveyBox(input.expected), improve = surveyBox(input.improve);
  const offer = CLOUD_RETENTION_OFFERS.includes(input.offer) ? input.offer : null;
  if ((input.answer !== undefined && input.answer !== null && !answer) || expected.length > SURVEY_TEXT_MAX || improve.length > SURVEY_TEXT_MAX) return null;
  if (!answer && !expected && !improve) return null;
  return { answer: answer ?? "other", ...(expected ? { expected } : {}), ...(improve ? { improve } : {}), ...(offer ? { offer } : {}) };
}
/** One step of the cancel sheet as main sends it (shared/billing-api.ts RetentionInput), or null for anything else. */
export function retentionStep(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const note = surveyBox(input.note);
  if (!CLOUD_CANCEL_ANSWERS.includes(input.reason) || !RETENTION_STEPS.includes(input.step) || !RETENTION_OUTCOMES.includes(input.outcome)
    || (input.offer !== undefined && !CLOUD_RETENTION_OFFERS.includes(input.offer)) || note.length > SURVEY_TEXT_MAX) return null;
  return { reason: input.reason, step: input.step, outcome: input.outcome, ...(input.offer ? { offer: input.offer } : {}), ...(note ? { note } : {}) };
}
/** The cancel sheet's recap of the account (shared/account-recap.ts), asked of the Admin with the sign-in. */
export const ACCOUNT_RECAP_ROUTE = "/v1/account/recap";
const RECAP_COUNTS = Object.freeze(["bots", "replies", "activeDays", "longestStreak", "routines", "apps", "computers"]);
const recapCount = value => Number.isSafeInteger(value) && value >= 0;
const short = (value, max) => typeof value === "string" && value.length <= max;
function recapBot(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  const { id, name, color, body, replies } = input;
  if (!short(id, 128) || !id || !short(name, 200) || !short(color, 32) || !/^[a-z]+$/.test(color) || !(body === null || short(body, 64)) || !recapCount(replies)) return null;
  return { id, name, color, body, replies };
}
/** The Admin's recap with only its own fields, each checked; null for anything else, so a page never draws a malformed one. */
export function accountRecapAnswer(input) {
  if (!input || typeof input !== "object" || input.v !== 1 || !Array.isArray(input.crew) || input.crew.length > 6 || !RECAP_COUNTS.every(key => recapCount(input[key]))) return null;
  if (!(input.since === null || (Number.isFinite(input.since) && input.since > 0))) return null;
  const crew = input.crew.map(recapBot), topBot = input.topBot === null ? null : recapBot(input.topBot);
  if (crew.includes(null) || (input.topBot !== null && !topBot)) return null;
  return { v: 1, since: input.since, crew, topBot, ...Object.fromEntries(RECAP_COUNTS.map(key => [key, input[key]])) };
}
