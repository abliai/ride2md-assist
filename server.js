import express from "express";
import crypto from "crypto";
import getRawBody from "raw-body";

const app = express();

// Verify Slack signatures
function verifySlackSignature(signingSecret, req) {
  const ts = req.headers["x-slack-request-timestamp"];
  const sig = req.headers["x-slack-signature"];
  if (!ts || !sig) return false;
  if (Math.abs(Date.now() / 1000 - Number(ts)) > 300) return false;
  const hmac = crypto.createHmac("sha256", signingSecret);
  const base = `v0:${ts}:${req.rawBody}`;
  hmac.update(base);
  const mySig = `v0=${hmac.digest("hex")}`;
  return crypto.timingSafeEqual(Buffer.from(mySig), Buffer.from(sig));
}

// In-memory tickets (upgrade to Redis later)
const tickets = new Map();

async function postToSlack({ token, channel, text, blocks }) {
  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ channel, text, blocks })
  });
  const data = await r.json();
  if (!data.ok) console.error("Slack post error", data);
  return data;
}

// Raw body for Slack endpoints; JSON elsewhere
app.use(async (req, res, next) => {
  if (req.url.startsWith("/slack/")) {
    req.rawBody = (await getRawBody(req)).toString("utf8");
    if (!verifySlackSignature(process.env.SLACK_SIGNING_SECRET, req)) {
      return res.status(401).send("bad signature");
    }
    req.body = Object.fromEntries(new URLSearchParams(req.rawBody));
    return next();
  } else {
    express.json()(req, res, next);
  }
});

app.get("/health", (_req, res) => res.send("ok"));

// Retell -> create assist ticket
app.post("/assist/request", async (req, res) => {
  const { conversation_id, lang, question, context } = req.body || {};
  const ticket_id = crypto.randomUUID();
  tickets.set(ticket_id, { createdAt: Date.now() });

  const blocks = [
    { type: "header", text: { type: "plain_text", text: `Ride2MD Assist — ${ticket_id}` } },
    { type: "section", text: { type: "mrkdwn", text: `*Lang:* ${lang}\n*Q:* ${question}` } },
    { type: "section", text: { type: "mrkdwn", text: "```" + JSON.stringify({ conversation_id, context }, null, 2) + "```" } },
    { type: "context", elements: [{ type: "mrkdwn", text: "Reply in Slack with: `/answer " + ticket_id + " your answer`" }] }
  ];

  await postToSlack({
    token: process.env.SLACK_BOT_TOKEN,
    channel: process.env.SLACK_CHANNEL_ID,
    text: `Assist ticket ${ticket_id}`,
    blocks
  });

  res.json({ ticket_id });
});

// Retell -> wait for Slack answer
app.get("/assist/wait", async (req, res) => {
  const ticket_id = req.query.ticket_id;
  const timeoutMs = Math.min(120000, (Number(req.query.timeout) || 60) * 1000);

  let answered = false;
  const onAnswer = (ans) => { answered = true; res.json({ status: "answered", answer_en: ans }); };
  tickets.set(ticket_id, { ...(tickets.get(ticket_id) || {}), onAnswer });

  setTimeout(() => { if (!answered) res.json({ status: "timeout" }); }, timeoutMs);
});

// Slack: /answer <ticket_id> <text>
app.post("/slack/command", (req, res) => {
  const { command, text, user_name } = req.body;
  if (command !== "/answer") return res.send("Unknown command.");
  const [ticket_id, ...rest] = (text || "").trim().split(/\s+/);
  const answer = rest.join(" ");
  const t = tickets.get(ticket_id);
  if (!t || !t.onAnswer) return res.send(`Ticket not found or expired: ${ticket_id}`);
  t.onAnswer(answer);
  tickets.delete(ticket_id);
  res.send(`Sent to caller for ${ticket_id} (from ${user_name}).`);
});

// Slack interactivity ack
app.post("/slack/interact", (_req, res) => res.send("ok"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`assist server on :${PORT}`));
