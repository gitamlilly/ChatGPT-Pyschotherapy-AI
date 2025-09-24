/*
  app.js
  - Implements the client-side "Companion" behavior.
  - Comments below are summary-level explanations: describe functionality, safety decisions,
    and how/why parts are structured. This is NOT my private chain-of-thought.
*/

/* ----------------------
   Configuration & Safety
   ----------------------
   Rationale (summary): Keep critical safety settings at the top so developers can tune them.
   The app performs simple keyword-based risk detection locally (no external AI required).
*/
const CONFIG = {
  USE_OPENAI: false, // optional: set true and implement server proxy if you want LLM integration (see comments below)
  MIN_RESPONSE_DELAY: 400, // ms - short pause to make bot responses feel paced (UX)
  CRISIS_KEYWORDS: [
    // Patterns that indicate high risk. Keep this conservative and inclusive.
    /suicid/i, /kill myself/i, /end my life/i, /want to die/i, /hurting myself/i,
    /cant go on/i, /cant cope anymore/i, /want to die/i, /no reason to live/i
  ],
  FEELING_KEYWORDS: {
    // Map simple tokens to empathetic reflections / suggested actions
    sad: { label: 'sad', reflect: "It sounds like you're feeling sad.", suggestion: "Would you like to talk about what's making you feel this way?" },
    anxious: { label: 'anxious', reflect: "You seem to be feeling anxious or worried.", suggestion: "Would trying a short breathing exercise help right now?" },
    overwhelmed: { label: 'overwhelmed', reflect: "You're feeling overwhelmed.", suggestion: "Let's try breaking things into small steps—what's one tiny thing you can do?" },
    lonely: { label: 'lonely', reflect: "Feeling lonely can be really hard.", suggestion: "Would you like some small ideas to connect with others or care for yourself?" },
    angry: { label: 'angry', reflect: "You're feeling angry right now.", suggestion: "Would a quick grounding exercise help to reduce the intensity?" },
    depressed: { label: 'depressed', reflect: "Sounds like you're feeling low or depressed.", suggestion: "If this is persistent, reaching out to a professional might help; I can show you resources." }
  }
};

/* ----------------------
   DOM helpers
   ----------------------
   Brief: small utility functions to render messages, scroll, and manage overlays.
*/
const $ = id => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('userInput');
const crisisOverlay = $('crisisOverlay');

/* Add message to chat
   - sender: 'user' or 'bot'
   - text: string (plain text)
   Rationale (summary): Keep rendering logic separated so the UI can be changed independently of behavior.
*/
function addMessage(text, sender='bot') {
  const m = document.createElement('div');
  m.className = `message ${sender}`;
  m.textContent = text;
  messagesEl.appendChild(m);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* ----------------------
   Risk detection
   ----------------------
   - detectCrisis(userText): scans input for high-risk patterns.
   - Safety rationale: If keywords matched, immediately show an overlay with emergency actions and resources.
     This is a conservative, fail-safe approach. For real deployments, use clinician-reviewed triage protocols.
*/
function detectCrisis(text) {
  if (!text) return false;
  const lowered = text.toLowerCase();
  return CONFIG.CRISIS_KEYWORDS.some(re => re.test(lowered));
}

/* ----------------------
   Feeling detection (simple)
   ----------------------
   - Attempt to categorize the user's stated feeling using keyword matching.
   - Rationale: For an offline companion, simple pattern recognition enables reflective, validating responses.
*/
function detectFeeling(text) {
  if (!text) return null;
  const lowered = text.toLowerCase();
  for (const key in CONFIG.FEELING_KEYWORDS) {
    if (lowered.includes(key)) return CONFIG.FEELING_KEYWORDS[key];
  }
  return null;
}

/* ----------------------
   Response generation (local, rule-based)
   ----------------------
   - generateLocalResponse(userText):
       * If crisis detected -> escalate
       * If feeling detected -> reflect + offer suggestion
       * Else -> open-ended empathic prompt
   - Rationale: Rule-based fallback keeps the system predictable and transparent.
*/
function generateLocalResponse(userText) {
  if (detectCrisis(userText)) {
    escalateToCrisis();
    return null;
  }

  const feeling = detectFeeling(userText);
  if (feeling) {
    return `${feeling.reflect} ${feeling.suggestion}`;
  }

  // General empathetic default
  const defaults = [
    "I'm listening — tell me more about that.",
    "That sounds important. What happened?",
    "How long have you been feeling like this?"
  ];
  return defaults[Math.floor(Math.random() * defaults.length)];
}

/* ----------------------
   Crisis handling UI
   ----------------------
   - escalateToCrisis shows overlay with immediate actions and links to helplines.
   - Rationale: When high-risk language is detected, we prioritize clear, visible crisis resources
     and avoid continuing with therapeutic content that could delay emergency help.
*/
function escalateToCrisis() {
  crisisOverlay.hidden = false;
  addMessage("I hear you. I'm concerned for your safety. Please consider contacting emergency services or a crisis line now.", 'bot');
}

/* Hook overlay close button */
$('overlayClose').addEventListener('click', () => {
  crisisOverlay.hidden = true;
});

/* ----------------------
   Interaction handlers
   ---------------------- */
document.getElementById('inputForm').addEventListener('submit', (ev) => {
  ev.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  addMessage(text, 'user');
  inputEl.value = '';
  // Short UX pause before responding
  setTimeout(() => {
    // If configured to use OpenAI (optional), call server API; otherwise local response
    if (CONFIG.USE_OPENAI) {
      // EXPLANATION (summary): If you opt to integrate an LLM, route calls to your server-side proxy
      // to keep the API key secret. This client-side snippet assumes a /api/chat endpoint.
      fetch('/api/chat', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({message:text})
      }).then(r=>r.json()).then(data=>{
        // data should include a safe, moderated "reply" field.
        if (typeof data.reply === 'string') {
          addMessage(data.reply, 'bot');
          // still run crisis detection locally to be conservative
          if (detectCrisis(text)) escalateToCrisis();
        } else {
          addMessage("Sorry, I'm having trouble forming a response right now.", 'bot');
        }
      }).catch(err=>{
        // Fail gracefully to local behavior
        const fallback = generateLocalResponse(text);
        if (fallback) addMessage(fallback, 'bot');
      });
    } else {
      const resp = generateLocalResponse(text);
      if (resp) addMessage(resp, 'bot');
    }
  }, CONFIG.MIN_RESPONSE_DELAY);
});

/* ----------------------
   Quick tools: Breathing & Grounding
   - These are simple, time-limited interactive exercises implemented purely client-side.
   - Rationale: Simple evidence-informed exercises (e.g. paced breathing, grounding) can help
     short-term regulation. Always recommend professional help if distress persists.
*/
$('breathBtn').addEventListener('click', () => {
  runBreathingExercise();
});
$('groundBtn').addEventListener('click', () => {
  runGroundingExercise();
});

function runBreathingExercise() {
  // Short guided 4-4-4 breathing with visible cues
  const steps = [
    "Find a comfortable seated position. We'll do 4 seconds in, hold 4, out 4.",
    "Inhale... (4)",
    "Hold... (4)",
    "Exhale... (4)"
  ];
  let i = 0;
  addMessage("Let's try a short breathing exercise.", 'bot');
  const t = setInterval(() => {
    if (i >= steps.length) {
      clearInterval(t);
      addMessage("Nice — how do you feel now?", 'bot');
      return;
    }
    addMessage(steps[i], 'bot');
    i++;
  }, 4200); // paced to roughly match 4-second counts
}

function runGroundingExercise() {
  // 5-4-3-2-1 grounding prompt
  addMessage("Let's try a 5-4-3-2-1 grounding exercise. Name: 5 things you can see.", 'bot');
  setTimeout(()=> addMessage("4 things you can feel.", 'bot'), 2200);
  setTimeout(()=> addMessage("3 things you can hear.", 'bot'), 4200);
  setTimeout(()=> addMessage("2 things you can smell (or imagine).", 'bot'), 6200);
  setTimeout(()=> addMessage("1 thing you can taste (or imagine). How was that?", 'bot'), 8200);
}

/* ----------------------
   Initialization: greet
   ---------------------- */
addMessage("Hi — I'm here to listen. What's on your mind today?", 'bot');

/* ----------------------
   OPTIONAL: Server-side LLM integration notes (do not include API keys in client code)
   - If you want to hook an LLM (e.g., OpenAI) for more varied responses, create a small server
     (Node/Express) with an endpoint like /api/chat that:
       * receives the user's message
       * applies safety filters (e.g., block how-to-self-harm requests)
       * forwards a carefully crafted prompt to the LLM
       * returns the LLM reply to this client
   - Rationale (summary): Never expose secret API keys in frontend code. Keep content moderation
     and crisis escalation logic server-side and clinician-reviewed.
*/
