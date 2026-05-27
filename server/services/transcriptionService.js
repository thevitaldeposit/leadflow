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
  const url =
    'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&punctuate=true&diarize=true&language=en';

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

  const alternative = result.results.channels[0].alternatives[0];
  let transcript = alternative.transcript;

  // Format with speaker labels if diarization is present
  const words = alternative.words || [];
  if (words.length && words[0].speaker !== undefined) {
    const segments = [];
    let currentSpeaker = null;
    let currentWords = [];
    for (const word of words) {
      if (word.speaker !== currentSpeaker) {
        if (currentWords.length) {
          segments.push(`[Speaker ${currentSpeaker}]: ${currentWords.join(' ')}`);
        }
        currentSpeaker = word.speaker;
        currentWords = [word.word];
      } else {
        currentWords.push(word.word);
      }
    }
    if (currentWords.length) {
      segments.push(`[Speaker ${currentSpeaker}]: ${currentWords.join(' ')}`);
    }
    transcript = segments.join('\n\n');
  }

  return {
    transcript,
    duration: result.metadata?.duration || null,
    segments: words,
    provider: 'deepgram',
    transcription_seconds: elapsed,
  };
}

async function transcribe(filePath) {
  const provider = process.env.TRANSCRIPTION_PROVIDER;
  const hasOpenAI = !!process.env.OPENAI_API_KEY;
  const hasDeeepgram = !!process.env.DEEPGRAM_API_KEY;

  if (!hasOpenAI && !hasDeeepgram) {
    throw new Error(
      'No transcription API key found. Add OPENAI_API_KEY or DEEPGRAM_API_KEY to your .env file.'
    );
  }

  if (provider === 'deepgram' && hasDeeepgram) return transcribeWithDeeepgram(filePath);
  if (provider === 'openai' && hasOpenAI) return transcribeWithOpenAI(filePath);

  // Auto-select: prefer OpenAI
  if (hasOpenAI) return transcribeWithOpenAI(filePath);
  return transcribeWithDeeepgram(filePath);
}

module.exports = { transcribe };
