# @armoriq/armorcopilot-ms

Webhook receiver for Microsoft Copilot Studio's external security webhook (`/analyze-tool-execution`). Deployed as a small standalone HTTPS service that:

1. Verifies the HMAC signature MS Copilot Studio attaches to every webhook call (via `verifyCopilotStudioSignature` from `@armoriq/sdk`)
2. Translates the MS payload to ArmorIQ's tool-call shape
3. Calls the ArmorIQ backend `/iap/sdk/enforce` to get the policy decision
4. Returns `{action: "allow" | "block", reason?}` to MS Copilot Studio within 1000ms

## Local dev

```bash
cp .env.example .env
# fill in ARMORIQ_API_KEY + COPILOT_STUDIO_DEFAULT_SECRET
npm install
npm run dev      # uses tsx watch, listens on :8080
```

Smoke test against a local backend:

```bash
# Health
curl http://localhost:8080/health

# Signed allow call (use the COPILOT_STUDIO_DEFAULT_SECRET from .env)
SECRET="<your secret>"
TS=$(date +%s)
BODY='{"toolDefinition":{"name":"send_email"},"toolInputValues":{"to":"a@b"}}'
SIG=$(node -e "const c=require('crypto'); console.log(c.createHmac('sha256','$SECRET').update('$TS.'+'$BODY').digest('hex'))")
curl -X POST http://localhost:8080/analyze-tool-execution/single-tenant \
  -H "Content-Type: application/json" \
  -H "X-ArmorCopilot-Signature: sha256=$SIG" \
  -H "X-ArmorCopilot-Timestamp: $TS" \
  -d "$BODY"
```

## Deploy (Cloud Run)

```bash
gcloud builds submit --tag gcr.io/<PROJECT>/armorcopilot-ms
gcloud run deploy armorcopilot-ms \
  --image gcr.io/<PROJECT>/armorcopilot-ms \
  --region us-east1 \
  --allow-unauthenticated \
  --min-instances=1 \
  --set-env-vars=ARMORIQ_BACKEND_ENDPOINT=https://api.armoriq.ai \
  --set-secrets=ARMORIQ_API_KEY=armorcopilot-api-key:latest,COPILOT_STUDIO_DEFAULT_SECRET=armorcopilot-studio-secret:latest
```

The HTTPS URL `gcloud run deploy` prints is what gets pasted into the Copilot Studio admin UI.

## Architecture notes (read before changing)

- **Why not put this in conmap-auto?** We did briefly. The webhook is server-side facing Microsoft's planner, so a local plugin pattern (like ArmorClaude / ArmorCodex) doesn't apply. We tried hosting it inline in conmap-auto for latency, but moved out to keep the backend surface clean and follow the "every product is its own deploy" pattern.
- **HMAC verify lives in the SDK** (`@armoriq/sdk/integrations/microsoft_copilot.ts`) so any future ArmorIQ service that fronts Copilot Studio can reuse it.
- **Policy enforce uses the existing `/iap/sdk/enforce` endpoint.** Today we wrap the call in `src/enforce.ts` with a synthetic intent token because the SDK's `session.enforce()` requires a registered plan, which doesn't fit MS's per-call interception model. TODO: add `client.enforceOnce()` to the SDK so this file can drop the manual axios call.
- **Multi-tenant via env vars for v1.** `COPILOT_STUDIO_TENANT_<id-upper-snake>_SECRET` for per-integration secrets, otherwise `COPILOT_STUDIO_DEFAULT_SECRET`. Promote to Secret Manager when there's a third customer.

## Refs

- Microsoft Copilot Studio external security webhooks: https://learn.microsoft.com/en-us/microsoft-copilot-studio/external-security-webhooks-interface-developers
- Parent tracking issue: [armoriq/armorCopilot#1](https://github.com/armoriq/armorCopilot/issues/1)
