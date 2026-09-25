/**
 * How long a sign-in or step-up proof counts as fresh for sensitive actions (credential changes, administration,
 * exports): five minutes. The one value every check uses; the store enforces it inside each transaction.
 */
export const FRESHNESS_WINDOW_MS = 300_000;
