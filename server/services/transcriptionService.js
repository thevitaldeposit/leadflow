const fs = require('fs');
const path = require('path');

async function transcribeWithOpenAI(filePath) {
  if (!process.env.OPENAI_API_KEY) {
    throw new Error('OPENAI_API_KEY is not configured in .env');
  }

  const OpenAI = require('openai');
  const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

  console.log('[transcription] Starting OpenAI Whisper transcription...');
  const start = Date.now();

  const response = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1',
    language: 'en',
    prompt:
      'This is a phone call between a business employee and a customer. The call may discuss vehicle sales, trade-ins, appointments, pricing, services, or scheduling.',
    response_format: 'verbose_json',
  });

  const elapsed = (Date.now() - start) / 1000;
  console.log(`[transcription] OpenAI Whisper completed in ${elapsed.toFixed(1)}s`);

  return {
    transcript: response.text,
    duration: response.duration || null,
    segments: response.segments || [],
    provider: 'openai',
    transcription_seconds: elapsed,
  };
}

// Twilio `record-from-answer-dual` records the PARENT call leg on the left channel
// and the CHILD (dialed) leg on the right channel. In this app's inbound flow the
// parent leg is the inbound CALLER (the customer) and the child leg is the OWNER
// (the dialed cell / app <Client>). Deepgram's multichannel response surfaces these
// as results.channels[0] (left) and results.channels[1] (right).
//
// This is the ONLY place a channel index becomes a role label. If a live test call
// shows the roles swapped, flip this single map — that's the entire fix.
const CHANNEL_ROLE = { 0: 'Caller', 1: 'Owner' };

// Build the transcript from a Deepgram (pre-recorded) response.
// - 2+ channels (inbound answered, dual-channel): interleave both channels' words
//   in chronological order and label each turn "Owner:"/"Caller:" per CHANNEL_ROLE,
//   so the summary model reads who-said-what from the physical phone leg instead of
//   guessing. Returns a single labeled string (downstream contract is one string).
// - 1 channel (voicemail MONO, iOS CallKit MONO, manual uploads, any mono file):
//   reproduce the original plain, UNLABELED transcript — no invented roles.
// - 0 channels / malformed: return an empty string rather than throwing.
function assembleTranscriptFromChannels(result) {
  const channels = (result && result.results && result.results.channels) || [];

  // Mono path (or empty): plain transcript, no labels. Behaves exactly as before.
  if (channels.length <= 1) {
    const alt = channels[0] && channels[0].alternatives && channels[0].alternatives[0];
    return { transcript: (alt && alt.transcript) || '', words: (alt && alt.words) || [] };
  }

  // Dual-channel path: tag every word with its channel's role, then interleave.
  const tagged = [];
  channels.forEach((channel, index) => {
    const role = CHANNEL_ROLE[index] || `Speaker ${index}`;
    const alt = channel && channel.alternatives && channel.alternatives[0];
    const words = (alt && alt.words) || [];
    for (const w of words) {
      tagged.push({ role, word: w.word, start: typeof w.start === 'number' ? w.start : 0 });
    }
  });

  // Chronological interleave. Array.prototype.sort is stable in Node, so words that
  // share a start time keep their channel order.
  tagged.sort((a, b) => a.start - b.start);

  // Group consecutive same-role words into one labeled turn.
  const segments = [];
  let currentRole = null;
  let currentWords = [];
  for (const t of tagged) {
    if (t.role !== currentRole) {
      if (currentWords.length) segments.push(`${currentRole}: ${currentWords.join(' ')}`);
      currentRole = t.role;
      currentWords = [t.word];
    } else {
      currentWords.push(t.word);
    }
  }
  if (currentWords.length) segments.push(`${currentRole}: ${currentWords.join(' ')}`);

  return { transcript: segments.join('\n'), words: tagged };
}

async function transcribeWithDeeepgram(filePath) {
  if (!process.env.DEEPGRAM_API_KEY) {
    throw new Error('DEEPGRAM_API_KEY is not configured in .env');
  }

  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = {
    '.mp3': 'audio/mpeg',
    '.m4a': 'audio/mp4',
    '.wav': 'audio/wav',
    '.ogg': 'audio/ogg',
    '.webm': 'audio/webm',
    '.mp4': 'audio/mp4',
  };
  const contentType = mimeMap[ext] || 'audio/mpeg';

  console.log('[transcription] Starting Deepgram transcription...');
  const start = Date.now();

  const audioData = fs.readFileSync(filePath);
  // Diarization (voiceprint-based speaker separation) stays DISABLED for compliance
  // (BIPA) — we do NOT use diarize. Speaker attribution comes from multichannel=true
  // instead: Deepgram transcribes each physical phone leg as its own channel
  // (results.channels[0]=left/parent/caller, channels[1]=right/child/owner). That is
  // telephony-based, not biometric. Mono files (voicemail, iOS, uploads) simply come
  // back as a single channel. Do not re-add diarize without a compliance review.
  const url =
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&language=en&multichannel=true';

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Token ${process.env.DEEPGRAM_API_KEY}`,
      'Content-Type': contentType,
    },
    body: audioData,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deepgram error ${res.status}: ${text}`);
  }

  const result = await res.json();
  const elapsed = (Date.now() - start) / 1000;
  console.log(`[transcription] Deepgram completed in ${elapsed.toFixed(1)}s`);

  // Assemble a single transcript string from the per-channel results: labeled +
  // interleaved for dual-channel calls, plain for mono. (See assembleTranscriptFromChannels.)
  const { transcript, words } = assembleTranscriptFromChannels(result);

  return {
    transcript,
    duration: result.metadata?.duration || null,
    segments: words,
    provider: 'deepgram',
    transcription_seconds: elapsed,
  };
}

async function transcribe(filePath) {
  // OpenAI/Whisper is the explicit default — the non-diarizing, privacy-preserving
  // path. Deepgram is used only when explicitly selected via
  // TRANSCRIPTION_PROVIDER=deepgram (also non-diarizing now), or as a fallback
  // when no OpenAI key is configured.
  const provider = process.env.TRANSCRIPTION_PROVIDER || 'openai';
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasDeeepgram = !!process.env.DEEPGRAM_API_KEY;

  if (!hasOpenAI && !hasDeeepgram) {
    throw new Error(
      'No transcription API key found. Add OPENAI_API_KEY or DEEPGRAM_API_KEY to your .env file.'
    );
  }

  if (provider === 'deepgram' && hasDeeepgram) return transcribeWithDeeepgram(filePath);
  if (provider === 'openai' && hasOpenAI) return transcribeWithOpenAI(filePath);

  // Fallback (requested provider's key missing, or no provider set): prefer OpenAI.
  if (hasOpenAI) return transcribeWithOpenAI(filePath);
  return transcribeWithDeeepgram(filePath);
}

module.exports = { transcribe, assembleTranscriptFromChannels, CHANNEL_ROLE };
