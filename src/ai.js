import axios from "axios";
import dotenv from "dotenv";
dotenv.config();

const PROVIDER = (process.env.AI_PROVIDER || "anthropic").toLowerCase();

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
 * Summarize a single conversation thread.
 * Returns { summary, sentiment, action_needed }
 */
export async function summarizeThread({ contactName, channel, messages }) {
  const transcript = messages
    .map((m) => `${m.direction === "inbound" ? "Contact" : "Us"}: ${m.body || ""}`)
    .join("\n")
    .slice(0, 6000); // keep token cost low

  const prompt = `You are triaging a business's ${channel} conversation thread with a contact named "${contactName || "Unknown"}".
Read the transcript below and respond with ONLY a JSON object (no markdown, no preamble) with these exact keys:
{"summary": "1-2 sentence plain-English synopsis of what's happening and where it stands", "sentiment": "positive" | "neutral" | "negative", "action_needed": true or false}

Transcript:
${transcript}`;

  const raw = await complete(prompt, 300);
  try {
    const clean = raw.replace(/```json|```/g, "").trim();
    const parsed = JSON.parse(clean);
    return {
      summary: parsed.summary || "",
      sentiment: parsed.sentiment || "neutral",
      action_needed: !!parsed.action_needed,
    };
  } catch {
    return { summary: raw.slice(0, 300), sentiment: "neutral", action_needed: false };
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

export default { summarizeThread, buildOverviewReport };
