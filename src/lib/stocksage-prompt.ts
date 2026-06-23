import promptLines from "./stocksage-system-prompt.json";

/**
 * Canonical StockSage system prompt. Single source of truth, kept in a JSON
 * file so it can be consumed by both:
 *   1. this module (the app sends it as a Langflow tweak), and
 *   2. scripts/sync-system-prompt.mjs, which bakes it into the chat flow's
 *      EMBEDDED system_message.
 *
 * Important: the hosted Langflow version silently IGNORES a `system_message`
 * tweak on the Language Model node (verified by probe — the prompt-builder
 * tweaks like live_data DO apply, the LLM system_message one does not). So the
 * prompt that actually drives the model is the one baked into the flow. To
 * change the prompt: edit stocksage-system-prompt.json, run
 * `node scripts/sync-system-prompt.mjs`, then re-import the flow into the Space.
 * The tweak below is kept as a harmless, forward-compatible backup.
 */
export const STOCKSAGE_SYSTEM = (promptLines as string[]).join("\n");
