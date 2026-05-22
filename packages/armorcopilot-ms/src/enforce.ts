/**
 * Thin wrapper that bridges a Copilot Studio tool invocation to the
 * ArmorIQ policy enforce endpoint.
 *
 * Today this posts directly to `/iap/sdk/enforce` with a stub intent
 * token. The SDK's session.enforce() flow requires a registered plan
 * (via startPlan), which doesn't map cleanly to Copilot Studio's
 * per-call interception model. Refactor TODO: expose a plan-less enforce
 * method on ArmorIQClient so this file can drop the manual axios call.
 *
 * Refs: armoriq/armoriq-sdk-customer-ts → add `client.enforceOnce()`.
 */
import axios from 'axios';

export interface EnforceArgs {
  backend: string;
  apiKey: string;
  tenantId: string;
  tool: string;
  args: Record<string, unknown>;
  userMessage?: string;
  agentMetadata?: Record<string, unknown>;
  userMetadata?: Record<string, unknown>;
}

export interface EnforceResult {
  allowed: boolean;
  action?: 'allow' | 'block' | 'hold';
  reason?: string;
  matchedPolicy?: string;
}

export async function enforceToolViaBackend(
  ea: EnforceArgs,
): Promise<EnforceResult> {
  const payload = {
    tool: ea.tool,
    arguments: ea.args,
    intent_token: { plan: { goal: ea.userMessage ?? '', steps: [] } },
    policy_snapshot: null,
    user_email:
      (ea.userMetadata?.email as string | undefined) ?? undefined,
    agent_id:
      (ea.agentMetadata?.id as string | undefined) ?? 'copilot-studio',
    source: { product: 'armorcopilot-ms', tenantId: ea.tenantId },
  };

  const resp = await axios.post(`${ea.backend}/iap/sdk/enforce`, payload, {
    headers: {
      'X-API-Key': ea.apiKey,
      'Content-Type': 'application/json',
    },
    timeout: 800,
    validateStatus: (s) => s >= 200 && s < 500,
  });

  const data = (resp.data ?? {}) as Record<string, unknown>;
  const allowed = data.allowed !== false;
  const action =
    (data.enforcementAction as 'allow' | 'block' | 'hold' | undefined) ??
    (data.action as 'allow' | 'block' | 'hold' | undefined) ??
    (allowed ? 'allow' : 'block');
  return {
    allowed,
    action,
    reason:
      (data.reason as string | undefined) ?? (data.message as string | undefined),
    matchedPolicy:
      typeof data.matched_policy === 'object'
        ? ((data.matched_policy as { name?: string }).name ?? undefined)
        : ((data.matched_policy as string | undefined) ?? undefined),
  };
}
