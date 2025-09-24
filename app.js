/*
  app.js — client-side logic for Companion Pro
  - This file contains UI wiring, client-side sentiment scoring, visualization,
    local safety checks, transcript export, and optional server calls.
  - Comments are summary-level: they describe goals, design choices, and safety precautions.
*/

/* -------------------------
   Configuration & constants
   -------------------------
   - Tweakable UI and safety settings are centralized here.
   - Keep sensitive operations (like OpenAI API calls) on the server to avoid exposing keys.
*/
const CONFIG = {
  USE_SERVER_BY_DEFAULT: true,   // toggled by checkbox in UI
  SERVER_ENDPOINT: '/api/chat',  // server endpoint for LLM proxy
  RESPONSE_DELAY_MS: 450,        // small UX pause
  CRISIS_PATTERNS: [
    /suicid/i, /kill myself/i, /end my life/i, /want to die/i, /hurting myself/i,
    /cant go on/i, /no reason to live/i, /die by myself/i
  ]
};

/* -------------------------
   Lightweight lexicon for sentiment/emotion scoring (client-side)
   - Rationale: Instead of heavy ML, a small lexicon provides interpretable scores and updates
     the emotion timeline for the user. This complements server-side models if present.
   - This lexicon maps tokens to simple valence scores and optional emotion labels.
*/
const LEXICON = {
  "happy": { score: 0.9, emotion: "joy" },
  "joy": { score: 0.9, emotion: "joy" },
  "glad": { score: 0.6, emotion: "joy" },
  "excited": { score: 0.8, emotion: "joy" },
  "good": { score: 0.4, emotion: "calm" },

  "sad": { score: -0.8, emotion: "sadness" },
  "depressed": { score: -0.9, emotion: "sadness" },
  "lonely": { score: -0.6, emotion: "sadness" },

  "anxious": { score: -0.7, emotion: "anxiety" },
  "worried": { score: -0.6, emotion: "anxiety" },
  "panic": { score: -0.85, emotion: "anxiety" },
  "overwhelmed": { score: -0.75, emotion: "overwhelm" },

  "angry": { score: -0.6, emotion: "anger" },
  "frustrated": { score: -0.5, emotion: "anger" },

  // neutral or filler tokens cause small movement toward zero
  "okay": { score: 0.0, emotion: "neutral" },
  "fine": { score: 0.1, emotion: "neutral" }
};

/* -------------------------
   DOM refs
   -------------------------*/
const $ = id => document.getElementById(id);
const messagesEl = $('messages');
const inputEl = $('userInput');
const inputForm = $('inputForm');
const breathBtn = $('breathBtn');
const groundBtn = $('groundBtn');
const typingIndicator = $('typingIndicator');
const crisisOverlay = $('crisisOverlay');
const overlayClose = $('overlayClose');
const downloadJsonBtn = $('downloadJson');
const downloadPdfBtn = $('downloadPdf');
const useServerCheckbox = $('useServer');
useServerCheckbox.checked = CONFIG.USE_SERVER_BY_DEFAULT;

/* -------------------------
   Conversation state & transcript
   - transcript stores chronological messages with metadata (sender, text, timestamp, score)
*/
let transcript = [];
let emotionTimeline = []; // { t: timestamp, score: -1..1 }

/* -------------------------
   Emotion chart setup (Chart.js)
   - We present a line chart of sentiment scores across time.
   - Design rationale: visual feedback helps users notice patterns.
*/
const ctx = document.getElementById('emotionChart').getContext('2d');
const chartData = {
  labels: [], // short time labels
  datasets: [{
    label: 'Sentiment score',
    data: [],
    tension: 0.25,
    fill: true,
    backgroundColor: 'rgba(52,102,242,0.08)',
    borderColor: 'rgba(52,102,242,0.95)',
    pointRadius: 3
  }]
};
const emotionChart = new Chart(ctx, {
  type: 'line',
  data: chartData,
  options: {
    responsive: true,
    scales: {
      y: { min: -1, max: 1, ticks: { stepSize: 0.5 } }
    },
    plugins: { legend: { display: false }, tooltip: { enabled: true } }
  }
});

/* -------------------------
   Utilities: rendering / scrolling
*/
function addMessageToUI(text, sender='bot', meta={}) {
  const m = document.createElement('div');
  m.className = `message ${sender}`;
  const p = document.createElement('div');
  p.className = 'text';
  p.textContent = text;
  m.appendChild(p);

  if (meta && meta.score !== undefined) {
    const mm = document.createElement('div');
    mm.className = 'meta';
    mm.textContent = `${meta.emotion || 'sentiment'} · score ${meta.score.toFixed(2)} · ${new Date(meta.ts).toLocaleTimeString()}`;
    m.appendChild(mm);
  }

  messagesEl.appendChild(m);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

/* -------------------------
   Simple crisis detection (client-side)
   - Acts as a conservative early-warning. Server also re-checks if used.
*/
function detectCrisis(text) {
  if (!text) return false;
  const t = text.toLowerCase();
  return CONFIG.CRISIS_PATTERNS.some(re => re.test(t));
}

/* -------------------------
   Simple lexicon-based scoring
   - Tokenize and average lexicon scores. Returns [-1, 1].
   - Rationale: Transparent, deterministic, and runs offline.
*/
function scoreText(text) {
  if (!text) return 0;
  const tokens = text.toLowerCase().match(/\b[^\s]+\b/g) || [];
  let sum = 0, count = 0, dominantEmotion = null, highestAbs = 0;
  tokens.forEach(tok => {
    if (LEXICON[tok]) {
      const val = LEXICON[tok].score;
      sum += val;
      count++;
      if (Math.abs(val) > highestAbs) {
        highestAbs = Math.abs(val);
        dominantEmotion = LEXICON[tok].emotion;
      }
    }
  });
  const avg = count ? (sum / count) : 0;
  return { score: Math.max(-1, Math.min(1, avg)), emotion: dominantEmotion || 'neutral', count };
}

/* -------------------------
   Update timeline and chart
*/
function pushToTimeline(scoreObj) {
  const timestamp = Date.now();
  emotionTimeline.push({ t: timestamp, ...scoreObj });
  // keep rolling window of last 40 points to avoid overplotting
  if (emotionTimeline.length > 80) emotionTimeline.shift();

  chartData.labels = emotionTimeline.map(e => new Date(e.t).toLocaleTimeString());
  chartData.datasets[0].data = emotionTimeline.map(e => e.score);
  emotionChart.update();
}

/* -------------------------
   Generate local fallback reply (rule-based)
   - If server LLM not used, fallback to predictable, safe replies.
*/
function localReply(userText, scoreObj) {
  // Rules: if crisis -> escalate; if negative -> reflect + suggestion; else general prompt
  if (detectCrisis(userText)) {
    escalateToCrisis();
    return null;
  }

  const s = scoreObj.score;
  if (s <= -0.6) {
    return "I'm sorry you're going through such a hard time. Would you like a grounding or breathing exercise now?";
  } else if (s < -0.2) {
    return "I hear that this is difficult. Tell me more about what's been on your mind.";
  } else if (s > 0.4) {
    return "It's great to hear some positivity. What do you think helped you feel this way?";
  } else {
    const generics = [
      "Tell me more — I'm listening.",
      "That sounds important. How long have you been feeling that way?",
      "Thanks for sharing that with me. What would be helpful right now?"
    ];
    return generics[Math.floor(Math.random() * generics.length)];
  }
}

/* -------------------------
   Show crisis overlay and important actions
*/
function escalateToCrisis() {
  crisisOverlay.hidden = false;
  addMessageToUI("I hear you. I'm worried about your safety. Please consider contacting emergency services or a crisis line now.", 'bot', { ts: Date.now(), score: -1, emotion: 'crisis' });
}

/* wire overlay close */
overlayClose.addEventListener('click', () => { crisisOverlay.hidden = true; });

/* -------------------------
   Transcript management
   - Transcript format: array of { sender:'user'|'bot', text, ts, score, emotion }
   - We store the score/emotion at message time for later review/export.
*/
function pushToTranscript(sender, text, scoreObj={ score:0, emotion:'neutral', count:0 }) {
  const entry = { sender, text, ts: Date.now(), score: scoreObj.score, emotion: scoreObj.emotion, lexCount: scoreObj.count };
  transcript.push(entry);
}

/* -------------------------
   Send message flow (client)
   - Steps:
   // 1) Render user message -> compute score -> push to timeline & transcript
   // 2) Choose: call server LLM (if enabled) OR localReply
   // 3) Show typing indicator, then render response
   - Security: if server is used, server re-checks for crisis and runs moderation
*/
inputForm.addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const text = inputEl.value.trim();
  if (!text) return;
  // render user
  const scoreObj = scoreText(text);
  addMessageToUI(text, 'user', { ts: Date.now(), score: scoreObj.score, emotion: scoreObj.emotion });
  pushToTranscript('user', text, scoreObj);
  pushToTimeline(scoreObj);

  inputEl.value = '';
  typingIndicator.hidden = false;

  // short UX delay
  await new Promise(res => setTimeout(res, CONFIG.RESPONSE_DELAY_MS));

  // If crisis detected client-side: show overlay and short bot message
  if (detectCrisis(text)) {
    typingIndicator.hidden = true;
    escalateToCrisis();
    pushToTranscript('bot', 'Crisis escalation message', { score: -1, emotion: 'crisis' });
    return;
  }

  // choose server vs local
  const useServer = useServerCheckbox.checked;

  if (useServer) {
    // call server endpoint; server will perform safety checks and (optionally) call LLM
    try {
      const resp = await fetch(CONFIG.SERVER_ENDPOINT, {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ message: text })
      });
      if (!resp.ok) throw new Error('Server error');
      const data = await resp.json();
      // server returns { reply, safety: {...} }
      const reply = data.reply || "Sorry, I'm having trouble responding right now.";
      const serverScore = scoreText(reply);
      addMessageToUI(reply, 'bot', { ts: Date.now(), score: serverScore.score, emotion: serverScore.emotion });
      pushToTranscript('bot', reply, serverScore);
      pushToTimeline(serverScore);

      // server may indicate crisis detection
      if (data.safety && data.safety.crisis) {
        escalateToCrisis();
      }
    } catch (err) {
      console.error('Server call failed:', err);
      // graceful fallback to local reply
      const reply = localReply(text, scoreObj);
      if (reply) {
        const rscore = scoreText(reply);
        addMessageToUI(reply, 'bot', { ts: Date.now(), score: rscore.score, emotion: rscore.emotion });
        pushToTranscript('bot', reply, rscore);
        pushToTimeline(rscore);
      }
    } finally {
      typingIndicator.hidden = true;
    }
  } else {
    // local fallback only
    const reply = localReply(text, scoreObj);
    if (reply) {
      const rscore = scoreText(reply);
      addMessageToUI(reply, 'bot', { ts: Date.now(), score: rscore.score, emotion: rscore.emotion });
      pushToTranscript('bot', reply, rscore);
      pushToTimeline(rscore);
    }
    typingIndicator.hidden = true;
  }
});

/* -------------------------
   Quick tools: Breathing and Grounding
   - These provide immediate, time-bound regulation strategies.
*/
breathBtn.addEventListener('click', () => runBreathingExercise());
groundBtn.addEventListener('click', () => runGroundingExercise());

function runBreathingExercise() {
  addMessageToUI("Let's try 4-4-4 breathing. Breathe in for 4, hold 4, exhale 4. I'll guide you through a few rounds.", 'bot', { ts: Date.now(), score: 0, emotion: 'calm' });
  pushToTranscript('bot', "Guided breathing start", { score: 0, emotion: 'calm' });
  // sequence 3 cycles
  const cues = ["Inhale... 4", "Hold... 4", "Exhale... 4"];
  let round = 0;
  const interval = setInterval(() => {
    if (round >= cues.length * 3) {
      clearInterval(interval);
      addMessageToUI("Nice work — how are you feeling now?", 'bot', { ts: Date.now(), score: 0.1, emotion: 'calm' });
      pushToTranscript('bot', "Breathing complete", { score: 0.1, emotion: 'calm' });
      return;
    }
    addMessageToUI(cues[round % cues.length], 'bot', { ts: Date.now(), score: 0, emotion: 'calm' });
    round++;
  }, 4200);
}

function runGroundingExercise() {
  addMessageToUI("Grounding 5-4-3-2-1: Name 5 things you can see.", 'bot', { ts: Date.now(), score: 0, emotion: 'grounding' });
  setTimeout(() => addMessageToUI("4 things you can feel.", 'bot', { ts: Date.now(), score: 0 }), 2000);
  setTimeout(() => addMessageToUI("3 things you can hear.", 'bot', { ts: Date.now(), score: 0 }), 4200);
  setTimeout(() => addMessageToUI("2 things you can smell (or imagine).", 'bot', { ts: Date.now(), score: 0 }), 6400);
  setTimeout(() => addMessageToUI("1 thing you can taste (or imagine). How was that?", 'bot', { ts: Date.now(), score: 0 }), 8600);
}

/* -------------------------
   Export: JSON & PDF
   - JSON: simple download of transcript
   - PDF: generate minimal PDF with messages (uses jspdf)
   - Rationale: Users often want to save or share session notes with clinicians.
*/
downloadJsonBtn.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(transcript, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `companion_transcript_${new Date().toISOString()}.json`;
  a.click();
  URL.revokeObjectURL(url);
});

downloadPdfBtn.addEventListener('click', async () => {
  // Use jsPDF (UMD loaded as window.jspdf)
  const { jsPDF } = window.jspdf;
  const doc = new jsPDF({ unit: 'pt', format: 'a4' });
  doc.setFontSize(12);
  let y = 40;
  doc.text('Companion Pro — Session Transcript', 40, y);
  y += 20;
  transcript.forEach(entry => {
    const timeStr = new Date(entry.ts).toLocaleString();
    const heading = `${timeStr} — ${entry.sender.toUpperCase()} [${entry.emotion}, ${entry.score.toFixed(2)}]`;
    doc.setFont(undefined, 'bold');
    doc.text(heading, 40, y);
    y += 16;
    doc.setFont(undefined, 'normal');
    // wrap long lines — jsPDF has limited text wrapping, use splitTextToSize
    const lines = doc.splitTextToSize(entry.text, 500);
    lines.forEach(line => {
      doc.text(line, 40, y);
      y += 14;
      if (y > 750) { doc.addPage(); y = 40; }
    });
    y += 10;
  });
  doc.save(`companion_transcript_${new Date().toISOString()}.pdf`);
});

/* -------------------------
   Initialization: greeting
*/
addMessageToUI("Hello — I'm here to listen. You can type anything, try a coping tool, or toggle server LLM for richer responses.", 'bot', { ts: Date.now(), score: 0, emotion: 'neutral' });
pushToTranscript('bot', "Greeting", { score: 0, emotion: 'neutral' });
pushToTimeline({ score: 0, emotion: 'neutral', count: 0 });
