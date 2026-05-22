import express from 'express';
import {
  verifyCopilotStudioSignature,
  translateCopilotStudioPayload,
  toCopilotStudioDecision,
  CopilotStudioPayload,
} from '@armoriq/sdk';
import { enforceToolViaBackend } from './enforce';

const PORT = Number(process.env.PORT ?? 8080);
const ARMORIQ_BACKEND =
  process.env.ARMORIQ_BACKEND_ENDPOINT ?? 'https://api.armoriq.ai';
const ARMORIQ_API_KEY = process.env.ARMORIQ_API_KEY ?? '';
const COPILOT_STUDIO_DEFAULT_SECRET =
  process.env.COPILOT_STUDIO_DEFAULT_SECRET ?? '';

if (!ARMORIQ_API_KEY) {
  console.warn(
    '[armorcopilot-ms] ARMORIQ_API_KEY not set — every request will fail enforcement',
  );
}
if (!COPILOT_STUDIO_DEFAULT_SECRET) {
  console.warn(
    '[armorcopilot-ms] COPILOT_STUDIO_DEFAULT_SECRET not set — HMAC verify will reject every request',
  );
}

const app = express();

app.use(
  express.json({
    limit: '256kb',
    verify: (req, _res, buf) => {
      (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
    },
  }),
);

app.get('/health', (_req, res) => {
  res.status(200).json({
    status: 'ok',
    service: 'armorcopilot-ms',
    version: '0.1.0',
  });
});

app.post('/analyze-tool-execution/:tenantId', async (req, res) => {
  const tenantId = req.params.tenantId;
  const signature = req.header('X-ArmorCopilot-Signature');
  const timestamp = req.header('X-ArmorCopilot-Timestamp');
  const rawBody =
    (req as express.Request & { rawBody?: Buffer }).rawBody ??
    Buffer.from(JSON.stringify(req.body ?? {}));

  const verify = verifyCopilotStudioSignature({
    rawBody,
    signature: signature ?? '',
    timestamp: timestamp ?? '',
    secret: resolveTenantSecret(tenantId),
  });
  if (!verify.ok) {
    return res
      .status(401)
      .json({ action: 'block', reason: `hmac:${verify.reason}` });
  }

  const translated = translateCopilotStudioPayload(
    req.body as CopilotStudioPayload,
  );

  const start = Date.now();
  try {
    const enforced = await enforceToolViaBackend({
      backend: ARMORIQ_BACKEND,
      apiKey: ARMORIQ_API_KEY,
      tenantId,
      tool: translated.toolName,
      args: translated.args,
      userMessage: translated.userMessage,
      agentMetadata: translated.agentMetadata,
      userMetadata: translated.userMetadata,
    });
    const decision = toCopilotStudioDecision(enforced);
    console.log(
      `[armorcopilot-ms] tenant=${tenantId} tool=${translated.toolName} action=${decision.action} took=${Date.now() - start}ms`,
    );
    return res.status(200).json(decision);
  } catch (err) {
    console.error(
      `[armorcopilot-ms] enforce failed for tenant=${tenantId}: ${(err as Error).message}`,
    );
    return res
      .status(200)
      .json({ action: 'allow', reason: 'enforce-unavailable' });
  }
});

function resolveTenantSecret(tenantId: string): string {
  const envKey = `COPILOT_STUDIO_TENANT_${tenantId.replace(/-/g, '_').toUpperCase()}_SECRET`;
  return process.env[envKey] ?? COPILOT_STUDIO_DEFAULT_SECRET;
}

app.listen(PORT, () => {
  console.log(
    `[armorcopilot-ms] listening on :${PORT} backend=${ARMORIQ_BACKEND}`,
  );
});
