// tools/send-messages/do-work/send-via-resend.cjs
//
// Purpose: message-provider-adapter send script for the "resend" provider.
// Sends via the Resend HTTP API (https://api.resend.com/emails) using the
// runtime's native fetch (Node 18+), no SDK bundling required. Same shape
// as send-via-twilio-sms.cjs, an HTTP REST provider with no SDK dependency.
//
// Invariants (see package::broadcast-delivery::contract):
// - provider is selected by data (message-provider-adapter record), never a
//   code branch in the caller. This script is only reached because a
//   message-provider-adapter::resend record named it as process_script_path.
// - credentials are passed via environment variables, never embedded here.
// - per-recipient send and per-recipient result, matching the existing SES
//   and Twilio adapters so send-broadcast's output contract stays
//   provider-agnostic.

async function sendViaResend(input) {
  const apiKey = process.env.RESEND_API_KEY;
  const fromAddress = process.env.EMAIL_FROM;

  if (!apiKey || !fromAddress) {
    throw new Error(
      "Missing required Resend credentials: RESEND_API_KEY, EMAIL_FROM"
    );
  }

  const results = [];
  for (const recipient of input.recipients) {
    try {
      const body = {
        from: fromAddress,
        to: [recipient],
        subject: input.subject,
        html: input.html,
      };
      if (input.text) {
        body.text = input.text;
      }
      // Bounded custom headers (In-Reply-To, References, List-Unsubscribe) and the caller's idempotency key,
      // merged in from the single-recipient email sender this adapter replaced.
      if (input.headers && Object.keys(input.headers).length > 0) {
        body.headers = input.headers;
      }
      const headers = {
        "authorization": `Bearer ${apiKey}`,
        "content-type": "application/json"
      };
      if (typeof input.idempotencyKey === "string" && input.idempotencyKey) {
        headers["idempotency-key"] = input.recipients.length === 1
          ? input.idempotencyKey
          : `${input.idempotencyKey}:${recipient}`;
      }

      const response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers,
        body: JSON.stringify(body)
      });

      const responseBody = await response.text();
      let parsed = {};
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = { raw: responseBody };
      }

      if (!response.ok) {
        const message = parsed.message || parsed.name || response.statusText;
        throw new Error(`Resend ${response.status}: ${message}`);
      }

      results.push({
        recipient,
        messageId: parsed.id
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        recipient,
        error: errorMessage
      });
    }
  }

  console.log(JSON.stringify({ sent: results }, null, 2));
  const failures = results.filter((result) => result.error);
  if (failures.length > 0) {
    process.exit(1);
  }
}

async function main() {
  let input;
  try {
    const fs = await import("fs");
    const path = await import("path");
    const inputFilePath = path.join(process.cwd(), "input.json");
    let inputData = null;
    try {
      if (fs.existsSync(inputFilePath)) {
        inputData = fs.readFileSync(inputFilePath, "utf-8");
      }
    } catch {
      // File doesn't exist or can't be read, try argv next
    }
    if (inputData && inputData.trim()) {
      input = JSON.parse(inputData);
    } else {
      // Fallback to argv, for backward compatibility in dev/testing
      const argInput = process.argv[2];
      if (!argInput) {
        throw new Error("No input provided via mounted file (input.json) or argv");
      }
      input = JSON.parse(argInput);
    }
  } catch (error) {
    console.error("Error parsing input:", error);
    process.exit(1);
  }

  try {
    await sendViaResend(input);
  } catch (error) {
    console.error("Error sending broadcast:", error);
    process.exit(1);
  }
}

main();
