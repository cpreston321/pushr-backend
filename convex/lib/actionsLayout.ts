/**
 * Shared layout rules for interactive notification actions.
 *
 * iOS categories must be pre-registered by the app (see mobile/lib/push.ts),
 * so the backend can't invent identifiers freely. Both sides agree on a
 * fixed layout:
 *
 *   - Identifier `"reply"`   — the reply action (at most one per push).
 *   - Identifiers `"act_1"`, `"act_2"`, ... — non-reply actions in input
 *     order.
 *   - Category is picked by (non-reply count × presence of reply):
 *
 *        reply | non-reply | categoryId
 *        ------+-----------+---------------------
 *         no   |     1     | pushr.acts.1
 *         no   |     2     | pushr.acts.2
 *         no   |     3     | pushr.acts.3
 *         no   |     4     | pushr.acts.4
 *         yes  |     0     | pushr.acts.reply
 *         yes  |     1     | pushr.acts.reply.1
 *         yes  |     2     | pushr.acts.reply.2
 *         yes  |     3     | pushr.acts.reply.3
 *
 *   - Fallback: when `actions` is absent but the legacy `action` (singular)
 *     field is set we continue to use `pushr.action` for back-compat.
 */

export type NotifAction =
  | {
      kind: 'open_url';
      id: string;
      label: string;
      url: string;
      destructive?: boolean;
    }
  | {
      kind: 'callback';
      id: string;
      label: string;
      /** Required on /notify. Only an MCP agent's question has none: its answer is just recorded. */
      callbackUrl?: string;
      destructive?: boolean;
      authRequired?: boolean;
    }
  | {
      kind: 'reply';
      id: string;
      label: string;
      callbackUrl?: string;
      placeholder?: string;
    };

export const MAX_ACTIONS = 4;

export type ActionLayoutSlot = {
  identifier: string; // "reply" | "act_1" | "act_2" | ...
  action: NotifAction;
};

/**
 * Assign platform identifiers to a list of actions. Throws if the list
 * violates the platform constraints (too many, duplicate ids, >1 reply).
 */
export function layoutActions(actions: NotifAction[]): ActionLayoutSlot[] {
  if (actions.length === 0) return [];
  if (actions.length > MAX_ACTIONS) {
    throw new Error(`at most ${MAX_ACTIONS} actions are supported`);
  }
  const seen = new Set<string>();
  for (const a of actions) {
    if (!a.id || !a.label) throw new Error('each action needs id and label');
    if (seen.has(a.id)) throw new Error(`duplicate action id: ${a.id}`);
    seen.add(a.id);
  }
  const reply = actions.filter((a) => a.kind === 'reply');
  if (reply.length > 1) throw new Error('at most one reply action is allowed');
  const nonReply = actions.filter((a) => a.kind !== 'reply');

  const slots: ActionLayoutSlot[] = [];
  if (reply[0]) slots.push({ identifier: 'reply', action: reply[0] });
  nonReply.forEach((a, i) => slots.push({ identifier: `act_${i + 1}`, action: a }));
  return slots;
}

/**
 * Select the iOS category id for a set of actions.
 */
export function categoryForActions(actions: NotifAction[]): string {
  if (actions.length === 0) return 'pushr.default';
  const reply = actions.some((a) => a.kind === 'reply');
  const nonReplyCount = actions.filter((a) => a.kind !== 'reply').length;
  if (!reply) return `pushr.acts.${nonReplyCount}`;
  return nonReplyCount === 0 ? 'pushr.acts.reply' : `pushr.acts.reply.${nonReplyCount}`;
}

/**
 * Resolve an iOS actionIdentifier (from a notification response) back to
 * the original NotifAction. Returns null if the identifier doesn't match
 * any slot — e.g. "mark_read" or the default tap.
 */
export function resolveActionIdentifier(
  actions: NotifAction[],
  actionIdentifier: string
): NotifAction | null {
  const slots = layoutActions(actions);
  return slots.find((s) => s.identifier === actionIdentifier)?.action ?? null;
}

/**
 * An action as clients may see it. Callback URLs often carry the receiver's
 * secret, so they stay on the server: the app only needs the id, label and
 * kind, and the server looks the URL up again when the action is run.
 */
export function publicAction<A extends NotifAction>(a: A): Omit<A, 'callbackUrl'> {
  if (!('callbackUrl' in a)) return a;
  const { callbackUrl: _omit, ...rest } = a;
  return rest;
}
