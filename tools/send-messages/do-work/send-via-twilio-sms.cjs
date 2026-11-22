async function sendViaTwilioSms(input, env = process.env) {
  const accountSid = env.TWILIO_ACCOUNT_SID;
  const authToken = env.TWILIO_AUTH_TOKEN;
  const fromNumber = env.TWILIO_FROM_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error(
      "Missing required Twilio credentials: TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER"
    );
  }

  const body = input.text || input.subject || "";
  if (!body) {
    throw new Error("Missing SMS body: provide input.text or input.subject");
  }

  const results = [];
  for (const recipient of input.recipients) {
    const form = new URLSearchParams();
    form.set("From", fromNumber);
    form.set("To", recipient);
    form.set("Body", body);

    let response;
    try {
      response = await fetch(
        `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`,
        {
          method: "POST",
          headers: {
            "authorization": `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString("base64")}`,
            "content-type": "application/x-www-form-urlencoded"
          },
          body: form
        }
      );
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        recipient,
        error: `Twilio outcome unknown: ${errorMessage}`,
        unknown: true
      });
      continue;
    }

    let responseBody;
    try {
      responseBody = await response.text();
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      results.push({
        recipient,
        error: `Twilio ${response.status}: response could not be read: ${errorMessage}`,
        unknown: response.status >= 500 || response.ok
      });
      continue;
    }

    let parsed = null;
    try {
      parsed = JSON.parse(responseBody);
    } catch {
      // A successful HTTP status without a readable provider receipt may still have created the message.
    }

    if (!response.ok) {
      const message = parsed?.message || parsed?.error_message || response.statusText;
      results.push({
        recipient,
        error: `Twilio ${response.status}: ${message}`,
        unknown: response.status >= 500
      });
      continue;
    }

    if (typeof parsed?.sid !== "string" || !/^(SM|MM)[0-9a-fA-F]{32}$/.test(parsed.sid)) {
      results.push({
        recipient,
        error: `Twilio ${response.status}: response did not contain a valid message SID`,
        unknown: true
      });
      continue;
    }

    results.push({ recipient, messageId: parsed.sid });
  }

  return results;
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
    }
    if (inputData && inputData.trim()) {
      input = JSON.parse(inputData);
    } else {
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
    const results = await sendViaTwilioSms(input);
    console.log(JSON.stringify({ sent: results }, null, 2));
    if (results.some((result) => result.error)) process.exit(1);
  } catch (error) {
    console.error("Error sending broadcast:", error);
    process.exit(1);
  }
}

// Run as a script (the provider's adapter process), or imported, when `send(input, env)` sends in the caller's own process
// with the keys and settings handed in env (a site program bundled into one file cannot start this file as a process).
if (require.main === module) {
  main();
}
module.exports = { send: sendViaTwilioSms };
