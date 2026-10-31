// tools/send-messages/do-work/send-via-amazon-ses.cjs
//
// Purpose: message-provider-adapter send script for the "amazon-ses" provider. The same SendEmail call the
// package's bundled AWS SDK made (one message per recipient, UTF-8 subject, HTML body, optional text body), sent
// over HTTPS with Node's own fetch and signed with AWS Signature Version 4, so no SDK has to be installed. Same
// shape as send-via-resend.cjs and send-via-twilio-sms.cjs: per-recipient result, `{ sent: [...] }` on standard
// output, exit 1 when any recipient failed.
//
// Credentials come in the environment of this one process: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY,
// EMAIL_FROM (a sender address verified in SES). The wrapper (send-a-message.mjs) fills the two keys from private
// pipes; they are never in argv or a file.

const crypto = require("node:crypto");

const sha256 = (value) => crypto.createHash("sha256").update(value, "utf8").digest("hex");
const hmac = (key, value) => crypto.createHmac("sha256", key).update(value, "utf8").digest();

// AWS Signature Version 4 for one request. `headers` must already hold host and x-amz-date; every header given
// is signed. Returns the Authorization header value.
function signV4({ method, path, query = "", headers, body, region, service, accessKeyId, secretAccessKey, amzDate }) {
  const day = amzDate.slice(0, 8);
  const names = Object.keys(headers).map((name) => name.toLowerCase()).sort();
  const lowered = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), String(value).trim()]));
  const canonical = [
    method,
    path,
    query,
    names.map((name) => `${name}:${lowered[name]}\n`).join(""),
    names.join(";"),
    sha256(body),
  ].join("\n");
  const scope = `${day}/${region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  const key = hmac(hmac(hmac(hmac(`AWS4${secretAccessKey}`, day), region), service), "aws4_request");
  const signature = crypto.createHmac("sha256", key).update(toSign, "utf8").digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, SignedHeaders=${names.join(";")}, Signature=${signature}`;
}

// The SendEmail query parameters for one recipient.
function sendEmailForm({ fromAddress, recipient, subject, html, text }) {
  const form = new URLSearchParams();
  form.set("Action", "SendEmail");
  form.set("Version", "2010-12-01");
  form.set("Source", fromAddress);
  form.set("Destination.ToAddresses.member.1", recipient);
  form.set("Message.Subject.Data", subject);
  form.set("Message.Subject.Charset", "UTF-8");
  form.set("Message.Body.Html.Data", html);
  form.set("Message.Body.Html.Charset", "UTF-8");
  if (text) {
    form.set("Message.Body.Text.Data", text);
    form.set("Message.Body.Text.Charset", "UTF-8");
  }
  return form.toString();
}

async function sendViaSES(input) {
  const region = process.env.AWS_REGION;
  const accessKeyId = process.env.AWS_ACCESS_KEY_ID;
  const secretAccessKey = process.env.AWS_SECRET_ACCESS_KEY;
  const fromAddress = process.env.EMAIL_FROM;

  if (!region || !accessKeyId || !secretAccessKey || !fromAddress) {
    throw new Error(
      "Missing required AWS credentials: AWS_REGION, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY, EMAIL_FROM"
    );
  }

  const host = `email.${region}.amazonaws.com`;
  const results = [];
  for (const recipient of input.recipients) {
    try {
      const body = sendEmailForm({ fromAddress, recipient, subject: input.subject, html: input.html, text: input.text });
      const amzDate = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
      const headers = { "content-type": "application/x-www-form-urlencoded; charset=utf-8", host, "x-amz-date": amzDate };
      const authorization = signV4({ method: "POST", path: "/", headers, body, region, service: "ses", accessKeyId, secretAccessKey, amzDate });
      const response = await fetch(`https://${host}/`, {
        method: "POST",
        headers: { "content-type": headers["content-type"], "x-amz-date": amzDate, authorization },
        body,
      });
      const responseBody = await response.text();
      if (!response.ok) {
        const message = responseBody.match(/<Message>([^<]*)<\/Message>/)?.[1] || response.statusText;
        throw new Error(`SES ${response.status}: ${message}`);
      }
      results.push({ recipient, messageId: responseBody.match(/<MessageId>([^<]*)<\/MessageId>/)?.[1] });
    } catch (error) {
      results.push({ recipient, error: error instanceof Error ? error.message : String(error) });
    }
  }

  console.log(JSON.stringify({ sent: results }, null, 2));
  if (results.some((result) => result.error)) process.exit(1);
}

async function main() {
  let input;
  try {
    const fs = require("node:fs");
    const path = require("node:path");
    const inputFilePath = path.join(process.cwd(), "input.json");
    const inputData = fs.existsSync(inputFilePath) ? fs.readFileSync(inputFilePath, "utf-8") : null;
    if (inputData && inputData.trim()) {
      input = JSON.parse(inputData);
    } else {
      const argInput = process.argv[2];
      if (!argInput) throw new Error("No input provided via mounted file (input.json) or argv");
      input = JSON.parse(argInput);
    }
  } catch (error) {
    console.error("Error parsing input:", error);
    process.exit(1);
  }

  try {
    await sendViaSES(input);
  } catch (error) {
    console.error("Error sending broadcast:", error);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
} else {
  module.exports = { signV4, sendEmailForm };
}
