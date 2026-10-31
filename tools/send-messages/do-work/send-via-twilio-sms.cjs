async function sendViaTwilioSms(input) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_FROM_NUMBER;

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
    try {
      const form = new URLSearchParams();
      form.set("From", fromNumber);
      form.set("To", recipient);
      form.set("Body", body);

      const response = await fetch(
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

      const responseBody = await response.text();
      let parsed = {};
      try {
        parsed = JSON.parse(responseBody);
      } catch {
        parsed = { raw: responseBody };
      }

      if (!response.ok) {
        const message = parsed.message || parsed.error_message || response.statusText;
        throw new Error(`Twilio ${response.status}: ${message}`);
      }

      results.push({
        recipient,
        messageId: parsed.sid
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
    await sendViaTwilioSms(input);
  } catch (error) {
    console.error("Error sending broadcast:", error);
    process.exit(1);
  }
}

main();
