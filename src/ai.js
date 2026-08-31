import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

// Drip/marketing emails tend to repeat the same unsubscribe footer on
// every message — strip it before it eats context and distracts the model.
function cleanBody(body) {
  if (!body) return "";
  const footerMarker = /-?\s*(chris|team)?\s*if you no longer wish to receive these emails[\s\S]*/i;
  return body.replace(footerMarker, "").trim();
}

async function callAnthropic(prompt, maxTokens = 400) {
  const { data } = await axios.post(
    "https://api.anthropic.com/v1/messages",
    {
      model: process.env.ANTHROPIC_MODEL || "claude-haiku-4-5",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json",
      },
      timeout: 30000,
    }
  );
  return data.content.map((b) => b.text || "").join("").trim();
}

async function callOpenAI(prompt, maxTokens = 400) {
  const { data } = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
      max_tokens: maxTokens,
      messages: [{ role: "user", content: prompt }],
    },
    {
      headers: {
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
        "content-type": "application/json",
      },
      timeout: 30000,
    }
  );
  return data.choices[0].message.content.trim();
}

async function complete(prompt, maxTokens = 400) {
  if (PROVIDER === "openai") return callOpenAI(prompt, maxTokens);
  return callAnthropic(prompt, maxTokens);
}

/**
 * Summarize a single conversation thread, and — the main thing this
 * dashboard is for — triage it into a priority tier.
 * Returns { summary, sentiment, action_needed, priority, priority_reason }
 */
export async function summarizeThread({ contactName, channel, messages }) {
  const transcript = messages
    .map((m) => `${m.direction === "inbound" ? "Contact" : "Us"}: ${cleanBody(m.body)}`)
    .join("\n")
    .slice(0, 6000); // keep token cost low

  const prompt = `You are triaging a business's ${channel} conversation thread with a contact named "${contactName || "Unknown"}", to help the owner know what to respond to first.
Read the transcript below and respond with ONLY a JSON object (no markdown, no preamble) with these exact keys:
{
  "summary": "1-2 sentence plain-English synopsis of what's happening and where it stands",
  "sentiment": "positive" | "neutral" | "negative",
  "action_needed": true or false,
  "priority": "urgent" | "high" | "normal" | "low",
  "priority_reason": "under 8 words on why this priority"
}

Priority guide:
- "urgent": time-sensitive, at risk of losing the customer, an explicit complaint, a cancellation/refund/billing issue, or someone directly asking to be contacted/called. Needs a reply today.
- "high": a real open question or request from the contact that's waiting on a reply, no urgency signal but genuinely needs a response soon.
- "normal": contact has replied or engaged but it's informational / no pressure to respond immediately.
- "low": one-way traffic — a drip/marketing email with no reply from the contact, or the thread is already resolved/closed and needs nothing further.

Transcript:
${transcript}`;

  const raw = await complete(prompt, 350);
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    const priority = ["urgent", "high", "normal", "low"].includes(parsed.priority)
      ? parsed.priority
      : "normal";
    return {
      summary: parsed.summary || "",
      sentiment: parsed.sentiment || "neutral",
      action_needed: parsed.action_needed !== undefined ? !!parsed.action_needed : priority === "urgent" || priority === "high",
      priority,
      priority_reason: parsed.priority_reason || "",
    };
  } catch {
    return { summary: raw.slice(0, 300), sentiment: "neutral", action_needed: false, priority: "normal", priority_reason: "" };
  }
}

/**
 * Roll many per-conversation summaries up into one "what's happening" overview.
 */
export async function buildOverviewReport(summaryLines) {
  const joined = summaryLines.slice(0, 300).join("\n").slice(0, 12000);
  const prompt = `Here is a list of one-line summaries, one per open conversation thread in a business's GHL account:

${joined}

Write a short executive overview (5-8 sentences, plain text, no markdown headers) covering: the overall volume/mix of what's coming in, any patterns or recurring issues worth flagging, and which threads most urgently need a human reply. Be direct and specific, not generic.`;

  return complete(prompt, 500);
}

/**
 * Propose 2-3 ready-to-send reply options for a thread, each taking a
 * genuinely different approach (not just reworded restatements).
 */
export async function suggestReplies({ contactName, channel, messages }) {
  const transcript = messages
    .map((m) => `${m.direction === "inbound" ? "Contact" : "Us"}: ${cleanBody(m.body)}`)
    .join("\n")
    .slice(0, 6000);

  const prompt = `You're helping a small business owner reply to a ${channel} conversation with "${contactName || "a contact"}".
Read the transcript below and draft exactly 3 different reply options they could send right now — each a complete, ready-to-send message in a direct, friendly small-business voice (no corporate filler, no "I hope this finds you well"). Make the 3 options genuinely different approaches (for example: a quick direct answer, a more detailed/helpful answer, and one that asks a clarifying question or proposes a next step) — not three rewordings of the same reply. If the thread doesn't need a reply at all (e.g. it already ended cleanly), say so as one of the options instead of inventing one.

Respond with ONLY a JSON object, no markdown, no preamble:
{"suggestions": [{"label": "2-4 word label", "message": "full reply text"}, {"label": "...", "message": "..."}, {"label": "...", "message": "..."}]}

Transcript:
${transcript}`;

  const raw = await complete(prompt, 700);
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed.suggestions) ? parsed.suggestions.slice(0, 3) : [];
  } catch {
    return [{ label: "Suggestion", message: raw.slice(0, 500) }];
  }
}

export default { summarizeThread, buildOverviewReport, suggestReplies };
