/**
 * server.js
 *
 * Minimal Node/Express server that:
 * - Serves static files (index.html + assets)
 * - Exposes POST /api/chat for an LLM proxy (optional)
 *
 * Security & safety notes (summary-level):
 * - Never embed API keys in client code. Keep them in environment variables.
 * - Server runs a conservative crisis filter server-side and refuses to forward requests that indicate imminent self-harm instructions.
 * - For production: add authentication, rate-limiting, logging controls, and clinician review of prompts & moderation rules.
 */

require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const bodyParser = require('body-parser');
const rateLimit = require('express-rate-limit');

const app = express();
const PORT = process.env.PORT || 3000;

// optional OpenAI integration (only if OPENAI_API_KEY present)
let OpenAI = null;
let openaiClient = null;
if (process.env.OPENAI_API_KEY) {
  try {
    const OpenAIpkg = require('openai');
    OpenAI = OpenAIpkg;
    openaiClient = new OpenAIpkg.OpenAIApi(new OpenAIpkg.Configuration({ apiKey: process.env.OPENAI_API_KEY }));
    console.log('OpenAI client configured.');
  } catch (err) {
    console.warn('OpenAI library not installed or failed to load. LLM calls disabled.');
  }
}

// Simple server-side crisis keywords (more conservative than client)
const CRISIS_PATTERNS = [
  /suicid/i, /kill myself/i, /end my life/i, /want to die/i, /hurting myself/i, /cant go on/i
];

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, '/'))); // serve static files from project root

// Rate limiter to reduce abuse
const limiter = rateLimit({ windowMs: 10 * 1000, max: 10 });
app.use('/api/', limiter);

/* Safety helper: scan text for crisis patterns */
function detectCrisisServer(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return CRISIS_PATTERNS.some(re => re.test(t));
}

/* Example server-side system prompt for an LLM (if used)
   - Encourage empathic, non-prescriptive responses.
   - The prompt explicitly forbids providing instructions for self-harm.
   - Clinicians should review & tune this prompt before deployment.
*/
const SYSTEM_PROMPT = `
You are a supportive, empathic conversational assistant for mental health support.
Follow these rules:
1) Use reflective listening and validation; do not give medical diagnoses.
2) Never provide instructions for self-harm or any illegal/harmful acts.
3) If the user expresses imminent self-harm risk, instruct them to contact emergency services immediately and provide crisis line info.
4) Offer brief coping strategies (grounding, breathing, seeking help) and encourage professional help when appropriate.
Keep responses under 300 words and avoid medical claims.
`;

/* POST /api/chat
   - Body: { message: string }
   - Response: { reply: string, safety: { crisis: bool, moderated: bool } }
   - Behavior:
     1) Run server-side crisis detection. If crisis -> respond with immediate safe text and flag crisis.
     2) If OpenAI client configured -> call LLM with a safe system prompt and return reply.
     3) Else -> use a local deterministic fallback response.
*/
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || typeof message !== 'string') return res.status(400).json({ error: 'Invalid message' });

    const crisis = detectCrisisServer(message);
    if (crisis) {
      // Immediate safe response: do not forward content to LLM to avoid producing unsafe continuations.
      const safeText = "I'm concerned for your safety. If you are in immediate danger, please call your local emergency number now. Would you like crisis line information or someone to contact?";
      return res.json({ reply: safeText, safety: { crisis: true, moderated: true } });
    }

    // If OpenAI is configured, call it
    if (openaiClient) {
      // Compose prompt — we give system-level instructions, then user message.
      const messages = [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: message }
      ];

      // Use the Chat Completions API. This code targets the OpenAI npm package shape.
      try {
        const completion = await openaiClient.createChatCompletion({
          model: process.env.OPENAI_MODEL || 'gpt-4o-mini', // allow env override
          messages,
          max_tokens: 350,
          temperature: 0.7
        });
        const reply = completion.data?.choices?.[0]?.message?.content?.trim();
        if (!reply) throw new Error('Empty reply from LLM');
        // Optionally, basic moderation could be run here (call moderation endpoint) — omitted for brevity
        // Save to a simple transcript log (append)
        try {
          const logEntry = { ts: Date.now(), message, reply };
          fs.appendFileSync('session_log.jsonl', JSON.stringify(logEntry) + '\n');
        } catch (err) { /* nonfatal logging error */ }

        return res.json({ reply, safety: { crisis: false, moderated: false } });
      } catch (openErr) {
        console.error('LLM call error:', openErr.message || openErr);
        // Fall back to deterministic server-side reply
      }
    }

    // Fallback deterministic reply if no LLM or LLM failed
    const fallback = generateDeterministicReply(message);
    return res.json({ reply: fallback, safety: { crisis: false, moderated: false } });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Server error' });
  }
});

/* Deterministic reply function (server fallback)
   - Mirrors client-side localReply but runs on server so client can choose to use it.
   - Keep this simple and safe.
*/
function generateDeterministicReply(text) {
  const lowered = text.toLowerCase();
  if (lowered.includes('help') && lowered.includes('anx')) {
    return "I hear you're feeling anxious. Would you like a short breathing exercise? We can try one together.";
  }
  if (lowered.includes('sad') || lowered.includes('depress')) {
    return "I'm sorry you're feeling sad. Want to tell me more about what's been happening lately?";
  }
  const generics = [
    "Thanks for sharing that — I'm listening. Can you tell me more?",
    "That sounds important. How long have you felt this way?",
    "I appreciate you telling me this. What would help you right now?"
  ];
  return generics[Math.floor(Math.random() * generics.length)];
}

/* start server */
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
  if (!process.env.OPENAI_API_KEY) {
    console.log('Warning: OPENAI_API_KEY not provided — LLM calls disabled (server will use fallback replies).');
  }
});
