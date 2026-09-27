import express from 'express';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { ActivityHandling, EndSensitivity, GoogleGenAI, StartSensitivity, Modality, ThinkingLevel, LiveServerMessage } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { RagEngine, SHARED_OWNER_ID } from './server/rag.ts';
import { extractTextFromPdfBuffer, generateContentWithFallback } from './server/fileProcessor.ts';
import { clearSessionCookie, createSession, getUserFromRequest, isAdminUser, login, logout, publicUser, register, requestPasswordReset, resetPassword, sessionCookie } from './server/auth.ts';
import { getAllStoredUserMemories, getUserMemories, storeImportantVoiceData } from './server/userData.ts';
import {
  ElevenLabsLiveRelay,
  generateElevenLabsSpeech,
  getActiveVoiceId,
  isElevenLabsEnabled,
  listVoiceOptions,
  selectVoice,
} from './server/elevenlabs.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3100);
const app = express();
const server = http.createServer(app);
const BENGALI_GREETING = 'আসসালামু আলাইকুম। আপনাকে আন্তরিক স্বাগতম। আমি কীভাবে আপনাকে সাহায্য করতে পারি?';

function enforceBanglaGreeting(text: string): string {
  const cleaned = (text || '').replace(/\[(.*?)\]|\*\*|\*|_+|`+|#+|>+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return BENGALI_GREETING;

  const startsWithGreeting = /আসসালামু|স্বাগতম/i.test(cleaned.slice(0, 120));
  if (startsWithGreeting) {
    return cleaned;
  }

  return `${BENGALI_GREETING} ${cleaned}`;
}

function sanitizeSpeechText(text: string): string {
  const withGreeting = enforceBanglaGreeting(text);
  const withoutNoise = withGreeting
    .replace(/[\u200B-\u200D\uFEFF]/g, '')
    .replace(/\s*\n\s*/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .replace(/\b(?:\*\*|__|##|###)\b/g, '')
    .replace(/(\s*[-•*]\s*)+/g, ' ')
    .replace(/(\s*\|\s*)+/g, ' ')
    .replace(/\s*[:;]+\s*/g, ': ')
    .trim();

  return withoutNoise.length > 4000 ? withoutNoise.slice(0, 4000).trim() : withoutNoise;
}

function pcmToWav(pcm: Buffer, sampleRate = 24000, channels = 1, bitsPerSample = 16): Buffer {
  const header = Buffer.alloc(44);
  const byteRate = sampleRate * channels * bitsPerSample / 8;
  const blockAlign = channels * bitsPerSample / 8;

  header.write('RIFF', 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVE', 8);
  header.write('fmt ', 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write('data', 36);
  header.writeUInt32LE(pcm.length, 40);

  return Buffer.concat([header, pcm]);
}

async function generateGeminiSpeech(client: GoogleGenAI, text: string): Promise<{ buffer: Buffer; mimeType: string }> {
  const response = await client.models.generateContent({
    model: 'gemini-2.5-flash-preview-tts',
    contents: sanitizeSpeechText(text),
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: {
        voiceConfig: {
          prebuiltVoiceConfig: {
            voiceName: 'Kore',
          },
        },
      },
    },
  });

  const audioPart = response.candidates?.[0]?.content?.parts?.find((part) => part.inlineData?.data);
  const audioData = audioPart?.inlineData?.data;
  if (!audioData) {
    throw new Error('Gemini TTS returned no audio data.');
  }

  const sourceMimeType = audioPart.inlineData?.mimeType || 'audio/L16;rate=24000';
  const audioBuffer = Buffer.from(audioData, 'base64');
  if (sourceMimeType.toLowerCase().startsWith('audio/wav')) {
    return { buffer: audioBuffer, mimeType: 'audio/wav' };
  }

  const sampleRateMatch = sourceMimeType.match(/rate=(\d+)/i);
  return {
    buffer: pcmToWav(audioBuffer, sampleRateMatch ? Number(sampleRateMatch[1]) : 24000),
    mimeType: 'audio/wav',
  };
}
/** Prefer ElevenLabs for a more natural Bangla voice; fall back to Gemini TTS. */
async function generateSpeech(client: GoogleGenAI | null, text: string): Promise<{ buffer: Buffer; mimeType: string }> {
  if (isElevenLabsEnabled()) {
    try {
      return await generateElevenLabsSpeech(sanitizeSpeechText(text));
    } catch (error: any) {
      console.warn('ElevenLabs TTS failed, falling back to Gemini TTS:', error?.message || error);
    }
  }
  if (!client) throw new Error('No TTS provider is configured.');
  return generateGeminiSpeech(client, text);
}

app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Initialize Google GenAI client
const apiKey = process.env.GEMINI_API_KEY || '';
let ai: GoogleGenAI | null = null;
if (apiKey) {
  ai = new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

// Initialize RAG Engine
const ragEngine = new RagEngine(ai || undefined);

// Background initialization of vector embeddings
if (ai) {
  ragEngine.initializeEmbeddings().catch((e) => {
    console.warn('Initial embedding warning:', e?.message || e);
  });
}

// Health check endpoint
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: Boolean(process.env.GEMINI_API_KEY),
    ttsProvider: isElevenLabsEnabled() ? 'elevenlabs' : 'gemini',
  });
});

function requireUser(req: express.Request, res: express.Response) {
  const user = getUserFromRequest(req);
  if (!user) {
    res.status(401).json({ error: 'Please log in to continue.' });
    return undefined;
  }
  return user;
}

function requireAdmin(req: express.Request, res: express.Response) {
  const user = requireUser(req, res);
  if (!user) return undefined;
  if (!isAdminUser(user)) {
    res.status(403).json({ error: 'Administrator access is required.' });
    return undefined;
  }
  return user;
}

app.get('/api/auth/me', (req, res) => {
  const user = getUserFromRequest(req);
  res.json({ user: user ? publicUser(user) : null });
});

app.post('/api/auth/register', (req, res) => {
  try {
    const user = register(req.body.email, req.body.password);
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
    res.status(201).json({ user: publicUser(user) });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Registration failed.' });
  }
});

app.post('/api/auth/login', (req, res) => {
  try {
    const user = login(req.body.email, req.body.password);
    res.setHeader('Set-Cookie', sessionCookie(createSession(user.id)));
    res.json({ user: publicUser(user) });
  } catch (error: any) {
    res.status(401).json({ error: error?.message || 'Login failed.' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  logout(req);
  res.setHeader('Set-Cookie', clearSessionCookie());
  res.status(204).end();
});

app.post('/api/auth/forgot-password', async (req, res) => {
  try {
    await requestPasswordReset(req.body.email);
    res.json({ message: 'If an account exists for that email, a reset link has been sent.' });
  } catch (error: any) {
    res.status(503).json({ error: error?.message || 'Could not send reset email.' });
  }
});

app.post('/api/auth/reset-password', (req, res) => {
  try {
    resetPassword(req.body.token, req.body.password);
    res.json({ message: 'Password updated. You can now log in.' });
  } catch (error: any) {
    res.status(400).json({ error: error?.message || 'Could not reset password.' });
  }
});

// GET Knowledge documents
app.get('/api/rag/documents', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const docs = ragEngine.getAllDocuments(user.id).filter((doc) => !doc.isCustom);
    res.json({ documents: docs });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch documents' });
  }
});

// GET Stored Custom Documents
app.get('/api/rag/custom-documents', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const customDocs = ragEngine.getCustomDocuments(user.id);
    res.json({ documents: customDocs, count: customDocs.length });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to fetch custom documents' });
  }
});

// POST new Knowledge document
app.post('/api/rag/documents', (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const { title, category, content, summary, tags, sourceUrl } = req.body;
    if (!title || !content) {
      return res.status(400).json({ error: 'Title and content are required' });
    }
    const newDoc = ragEngine.addDocument({
      title,
      category: category || 'custom',
      content,
      summary: summary || content.slice(0, 150) + '...',
      tags: Array.isArray(tags) ? tags : [category || 'custom'],
      sourceUrl,
    }, isAdminUser(user) ? SHARED_OWNER_ID : user.id);
    res.json({ document: newDoc });
  } catch (error: any) {
    res.status(500).json({ error: error?.message || 'Failed to add document' });
  }
});

// POST Upload & Index File for RAG (supports TXT, MD, JSON, CSV, PDF)
app.post('/api/rag/upload-file', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const { fileName, fileType, fileBase64 } = req.body;
    if (!fileName || !fileBase64) {
      return res.status(400).json({ error: 'ফাইল নাম ও কন্টেন্ট প্রদান করা আবশ্যক।' });
    }

    let extractedText = '';
    const lowerName = fileName.toLowerCase();
    const isPdf = fileType === 'application/pdf' || lowerName.endsWith('.pdf');

    if (isPdf) {
      const buffer = Buffer.from(fileBase64, 'base64');
      // 1. Attempt fast local PDF text extraction first (no API call needed for text-based PDFs)
      const localExtracted = extractTextFromPdfBuffer(buffer);
      if (ai) {
        // 2. Multimodal AI extraction with model fallback to handle traffic spikes (503/429)
        try {
          extractedText = await generateContentWithFallback(ai, {
            preferredModel: 'gemini-3.8-flash',
            contents: [
              {
                parts: [
                  {
                    inlineData: {
                      mimeType: 'application/pdf',
                      data: fileBase64,
                    },
                  },
                  {
                    text: 'Extract all readable text, data, and structured content from this document verbatim. Preserve original language (Bengali and English).',
                  },
                ],
              },
            ],
          });
        } catch (pdfErr: any) {
          if (localExtracted && localExtracted.trim().length > 60) {
            extractedText = localExtracted.trim();
          } else {
            console.warn('PDF AI extraction error:', pdfErr?.message);
            throw new Error('মডেলটিতে সাময়িক চাপ বেশি রয়েছে। অনুগ্রহ করে কয়েক সেকেন্ড পর পুনরায় চেষ্টা করুন।');
          }
        }
      } else if (localExtracted && localExtracted.trim().length > 60) {
        extractedText = localExtracted.trim();
      } else if (localExtracted && localExtracted.trim()) {
        extractedText = localExtracted.trim();
      }
    } else {
      // Decode UTF-8 plain text (txt, md, json, csv)
      const buffer = Buffer.from(fileBase64, 'base64');
      extractedText = buffer.toString('utf-8');
    }

    if (!extractedText.trim()) {
      return res.status(400).json({ error: 'নথি থেকে কোনো পড়ার উপযোগী টেক্সট পাওয়া যায়নি।' });
    }

    // Generate brief 2-sentence summary in Bengali (safe with fallback)
    let summary = extractedText.slice(0, 160).trim() + '...';
    if (ai) {
      try {
        const sumResult = await generateContentWithFallback(ai, {
          preferredModel: 'gemini-3.1-flash-lite',
          contents: `Provide a 2-sentence summary in authentic Bengali highlighting the main topics and key information in this document:\n\n${extractedText.slice(0, 2000)}`,
        });
        if (sumResult && sumResult.trim()) {
          summary = sumResult.trim();
        }
      } catch (sumErr) {
        console.warn('Summary generation skipped:', sumErr);
      }
    }

    // Index into RAG Engine
    const doc = ragEngine.addDocument({
      title: fileName,
      category: 'custom',
      content: extractedText,
      summary,
      tags: ['uploaded_file', fileName.split('.').pop() || 'file'],
      isCustom: true,
    }, isAdminUser(user) ? SHARED_OWNER_ID : user.id);

    res.json({
      success: true,
      document: doc,
      totalDocuments: ragEngine.getCustomDocuments(user.id).length,
      summary,
    });
  } catch (error: any) {
    console.error('File upload error:', error);
    let friendlyMessage = 'নথি প্রসেসিংয়ে সমস্যা হয়েছে, অনুগ্রহ করে আবার চেষ্টা করুন।';
    const rawMsg = error?.message || '';
    if (rawMsg.includes('503') || rawMsg.includes('UNAVAILABLE') || rawMsg.includes('high demand')) {
      friendlyMessage = 'মডেলটিতে সাময়িক চাপ বেশি রয়েছে। অনুগ্রহ করে কয়েক সেকেন্ড পর পুনরায় চেষ্টা করুন।';
    } else if (rawMsg.includes('429') || rawMsg.includes('RESOURCE_EXHAUSTED')) {
      friendlyMessage = 'অনুরোধের সীমা পূর্ণ হয়েছে, অনুগ্রহ করে কিছুক্ষণ পর চেষ্টা করুন।';
    } else if (typeof rawMsg === 'string' && !rawMsg.startsWith('{') && rawMsg.length < 150) {
      friendlyMessage = rawMsg;
    }
    res.status(500).json({ error: friendlyMessage });
  }
});

// POST Transcribe Audio using gemini-3.5-transcribe
app.post('/api/transcribe', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const startTime = Date.now();
  try {
    if (!ai) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in server environment.' });
    }
    const { audioBase64, mimeType = 'audio/webm' } = req.body;
    if (!audioBase64) {
      return res.status(400).json({ error: 'Audio base64 data is required' });
    }

    const audioPart = {
      inlineData: {
        mimeType,
        data: audioBase64,
      },
    };

    const response = await ai.models.generateContent({
      model: 'gemini-3.5-transcribe',
      contents: {
        parts: [
          audioPart,
          {
            text: 'অডিওটিতে উচ্চারিত কথাগুলো অবিকল খাঁটি প্রমিত বা আঞ্চলিক বাংলাদেশি বাংলায় প্রতিলিপিকরণ (transcribe) করুন। কোনো অনুবাদ করবেন না, শুধু বাংলা টেক্সট দিন।',
          },
        ],
      },
    });

    const transcribedText = response.text?.trim() || '';
    let storedMemory = null;
    if (transcribedText) {
      if (isAdminUser(user)) {
        ragEngine.addDocument({
          title: `Admin voice information - ${new Date().toISOString().slice(0, 10)}`,
          category: 'custom',
          content: transcribedText,
          summary: transcribedText.slice(0, 160) + (transcribedText.length > 160 ? '...' : ''),
          tags: ['admin_voice', 'shared_information'],
          isCustom: true,
        }, SHARED_OWNER_ID);
        storedMemory = true;
      } else {
        try {
          storedMemory = await storeImportantVoiceData(ai, user.id, transcribedText);
        } catch (memoryError: any) {
          console.warn('Voice memory was not stored:', memoryError?.message || memoryError);
        }
      }
    }
    res.json({
      text: transcribedText,
      storedMemory: Boolean(storedMemory),
      durationMs: Date.now() - startTime,
    });
  } catch (error: any) {
    console.error('Transcription error:', error);
    res.status(500).json({ error: error?.message || 'Failed to transcribe audio' });
  }
});

// POST Convert Text to Speech (ElevenLabs, falling back to Gemini)
app.post('/api/tts', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    const { text } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required for TTS' });
    }

    if (!ai && !isElevenLabsEnabled()) {
      return res.status(500).json({ error: 'No TTS provider is configured in server environment.' });
    }

    const audio = await generateSpeech(ai, text);

    res.json({
      audioBase64: audio.buffer.toString('base64'),
      mimeType: audio.mimeType,
    });
  } catch (error: any) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error?.message || 'Failed to generate speech' });
  }
});

// GET Human Bangla voices an admin can choose, and the voice used for every answer (admin)
app.get('/api/admin/voice', async (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  if (!isElevenLabsEnabled()) {
    return res.json({ enabled: false, voiceId: null, voices: [] });
  }
  try {
    const voices = await listVoiceOptions(req.query.refresh === '1');
    res.json({ enabled: true, voiceId: getActiveVoiceId(), voices });
  } catch (error: any) {
    console.error('Voice list error:', error);
    res.status(502).json({ error: 'কণ্ঠের তালিকা লোড করা যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।' });
  }
});

// PUT Select the voice for all users (admin)
app.put('/api/admin/voice', async (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  try {
    const { voiceId } = req.body;
    if (typeof voiceId !== 'string' || !voiceId) {
      return res.status(400).json({ error: 'একটি কণ্ঠ নির্বাচন করুন।' });
    }
    await selectVoice(voiceId, user.email);
    res.json({ voiceId });
  } catch (error: any) {
    if (error?.message === 'UNKNOWN_VOICE') {
      return res.status(400).json({ error: 'এই কণ্ঠটি পাওয়া যায়নি। তালিকা হালনাগাদ করে আবার চেষ্টা করুন।' });
    }
    console.error('Voice update error:', error);
    res.status(500).json({ error: 'কণ্ঠ সংরক্ষণ করা যায়নি। আবার চেষ্টা করুন।' });
  }
});

// POST Speak a short Bangla sample with a voice before selecting it (admin)
app.post('/api/admin/voice/preview', async (req, res) => {
  const user = requireAdmin(req, res);
  if (!user) return;
  try {
    const { voiceId } = req.body;
    if (typeof voiceId !== 'string' || !voiceId) {
      return res.status(400).json({ error: 'একটি কণ্ঠ নির্বাচন করুন।' });
    }
    const audio = await generateElevenLabsSpeech(BENGALI_GREETING, voiceId);
    res.json({ audioBase64: audio.buffer.toString('base64'), mimeType: audio.mimeType });
  } catch (error: any) {
    console.error('Voice preview error:', error);
    res.status(502).json({ error: 'এই কণ্ঠটি এখন শোনানো যাচ্ছে না। আবার চেষ্টা করুন।' });
  }
});

// POST RAG Query handler
app.post('/api/rag/query', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  const startTime = Date.now();
  try {
    if (!ai) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in server environment.' });
    }

    const { message, mode = 'standard', voiceName = 'Kore', enableRag = true, categoryFilter } = req.body;
    if (!message || typeof message !== 'string') {
      return res.status(400).json({ error: 'Valid query message is required' });
    }

    // 1. Retrieve Knowledge Chunks via RAG Engine
    let retrievedSources: any[] = [];
    if (enableRag) {
      retrievedSources = await ragEngine.retrieve(message, 4, categoryFilter, user.id);
    }

    // Always attach user-uploaded and stored files to model context with highest priority
    const adminAccess = isAdminUser(user);
    const customDocs = adminAccess ? ragEngine.getAllCustomDocuments() : ragEngine.getCustomDocuments(user.id);
    const userMemories = adminAccess ? getAllStoredUserMemories() : getUserMemories(user.id);
    let customFilesSection = '';
    if (customDocs.length > 0) {
      customFilesSection =
        `\n\n【ব্যবহারকারীর সংরক্ষিত নথির ডেটা (User Stored Files & Extracted Data - Top Priority)】:\n` +
        customDocs
          .map(
            (cd, idx) =>
              `[নথি ${idx + 1}: ${cd.title} (সংরক্ষণের তারিখ: ${cd.createdAt})]\nসারাংশ: ${cd.summary}\nউদ্ধৃত পূর্ণাঙ্গ ডেটা:\n${cd.content}`
          )
          .join('\n\n');
    }

    const userMemorySection = userMemories.length > 0
      ? `\n\n【ব্যবহারকারীর গুরুত্বপূর্ণ কণ্ঠ-সংরক্ষিত তথ্য】:\n${userMemories.map((memory, idx) =>
        `[স্মৃতি ${idx + 1}: ${memory.createdAt}]\nসারাংশ: ${memory.summary}\nসব তথ্য: ${memory.facts.join('\n')}\nমূল বক্তব্য: ${memory.originalText}`
      ).join('\n\n')}`
      : '';

    // Build Bengali grounding context
    const completeStandardContext = ragEngine.getAllDocuments(user.id)
      .filter((document) => !document.isCustom)
      .map((document) => `[উৎস: ${document.title} (${document.category})]\n${document.content}\nউৎস লিংক: ${document.sourceUrl || 'Online Record/Reference'}\n`)
      .join('\n\n');
    const contextBlock = `${userMemorySection}${customFilesSection}${completeStandardContext ? `\n\n【সম্পূর্ণ সাধারণ রেফারেন্স তথ্যভাণ্ডার】:\n${completeStandardContext}` : ''}`;

    const systemInstruction = `তুমি একজন অত্যন্ত পারদর্শী, জ্ঞানী ও নির্ভরযোগ্য বাংলাদেশি বাংলা ভয়েস এআই এজেন্ট (Bangladeshi Bangla Voice AI Agent)।
    প্রতিটি নতুন কথোপকথনের প্রথম উত্তরের একেবারে শুরুতে অবশ্যই বলবে: "আসসালামু আলাইকুম। আপনাকে আন্তরিক স্বাগতম। আমি কীভাবে আপনাকে সাহায্য করতে পারি?" এরপর ব্যবহারকারীর প্রশ্নের উত্তর দেবে।
তোমার দায়িত্ব ও নির্দেশনা:
১. তুমি একটি AI এর মত কথা না বলে একদম সম্পূর্ণ মানুষের মত করে উত্তর দাও।
২. প্রথম বাক্যটি সর্বদা বাংলা ভাষায় সালাম ও স্বাগতমের সঙ্গে শুরু করো।
৩. ব্যবহারকারী যেসব ফাইল আপলোড করেছেন তার সম্পূর্ণ ডেটা স্থায়ীভাবে সংরক্ষিত রাখা হয়েছে এবং তোমার কাছে সরবরাহ করা হয়েছে। ব্যবহারকারীর প্রশ্ন যদি আপলোডকৃত কোনো ফাইল বা নথির তথ্য সম্পর্কিত হয়, তবে সেই সংরক্ষিত নথির ডেটা সম্পূর্ণভাবে পর্যালোচনা করে সরাসরি ও নির্ভুল প্রমিত বাংলায় উত্তর প্রদান করো।
৪. যদি সাধারণ রেফারেন্স তথ্যভাণ্ডার (RAG Context) থাকে, সেখান থেকেও প্রাসঙ্গিক তথ্য নিয়ে উত্তর দিতে পারো।
৫. কোনো তথ্য জানা না থাকলে বানোয়াট কিছু না বলে শান্তভাবে জানিয়ে দাও।
৬. ব্যবহারকারী যদি নোয়াখালী, চট্টগ্রাম বা সিলেটের আঞ্চলিক উপভাষায় কথা বলেন, তবে তা আন্তরিকভাবে বুঝে প্রমিত বাংলায় প্রাঞ্জল উত্তর দাও।
৭. উত্তরটি মুখে শোনার (TTS) জন্য অত্যন্ত শ্রুতিমধুর, স্পষ্ট, আকর্ষণীয়, স্বাভাবিক ও অনর্থক প্রতীকবিহীন (clean spoken Bengali) করো।
৮. কোনো Markdown, তালিকা, Asterisk, কমান্ড, code block, বা অনাবশ্যক চিহ্ন ব্যবহার করো না; শুধু স্বাভাবিক কথা বলার ভাষায় লিখবে।`;

    const userPrompt = `ব্যবহারকারীর বার্তা বা প্রশ্ন: "${message}"\n\n` +
      (contextBlock ? `${contextBlock}\n\n` : '') +
      `দয়া করে প্রাসঙ্গিক তথ্য ও সংরক্ষিত নথির ডেটার ওপর ভিত্তি করে, AI এর মত কথা না বলে একদম সম্পূর্ণ মানুষের মত করে বলে বাংলায় সম্পূর্ণ সঠিক উত্তর দাও।`;

    let responseText = '';
    let thinkingProcess = '';
    let selectedModel = 'gemini-3.8-flash';

    if (mode === 'high_thinking') {
      selectedModel = 'gemini-3.1-pro-preview';
    } else if (mode === 'fast') {
      selectedModel = 'gemini-3.1-flash-lite';
    }

    responseText = await generateContentWithFallback(ai, {
      preferredModel: selectedModel,
      contents: userPrompt,
      systemInstruction,
    });

    responseText = enforceBanglaGreeting(responseText);

    // Generate the complete Bengali answer with ElevenLabs (or Gemini) TTS. No application-level text cap.
    let audioBase64: string | undefined = undefined;
    let audioMimeType: string | undefined = undefined;
    try {
      const ttsPromise = generateSpeech(ai, responseText);
      const ttsTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TTS timeout')), 30000));
      const ttsResult = (await Promise.race([ttsPromise, ttsTimeout])) as any;
      if (ttsResult?.buffer && Buffer.isBuffer(ttsResult.buffer)) {
        audioBase64 = ttsResult.buffer.toString('base64');
        audioMimeType = ttsResult.mimeType;
      }
    } catch (ttsErr: any) {
      console.warn('TTS inline generation skipped or timed out:', ttsErr?.message);
    }

    const latencyMs = Date.now() - startTime;

    res.json({
      text: responseText,
      thinkingProcess,
      retrievedSources,
      audioBase64,
      audioMimeType,
      latencyMs,
      modelUsed: selectedModel,
    });
  } catch (error: any) {
    console.error('RAG query error:', error);
    res.status(500).json({ error: error?.message || 'Failed to process RAG query' });
  }
});

// Setup WebSocket Server for Live API Real-Time Audio Streaming
const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (request, socket, head) => {
  const { pathname } = new URL(request.url || '', `http://${request.headers.host}`);
  if (pathname === '/ws/live') {
    if (!getUserFromRequest(request)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit('connection', ws, request);
    });
  }
});

wss.on('connection', async (clientWs: WebSocket, request: http.IncomingMessage) => {
  console.log('Client connected to Live audio WebSocket');
  let liveSession: any = null;
  let pendingInputTranscript = '';
  // Gemini is still producing the current answer (between its first output and generationComplete)
  let modelGenerating = false;
  // The user talked over the answer: skip the rest of it until Gemini ends that turn
  let dropModelOutput = false;
  // With ElevenLabs, Gemini's reply text is re-voiced and Gemini's own audio is discarded
  const speechRelay = isElevenLabsEnabled()
    ? new ElevenLabsLiveRelay((audio) => {
        if (clientWs.readyState === WebSocket.OPEN) clientWs.send(JSON.stringify({ audio }));
      })
    : null;
  const user = getUserFromRequest(request);
  if (!user) {
    clientWs.close(1008, 'Authentication required');
    return;
  }

  try {
    if (!ai) {
      clientWs.send(JSON.stringify({ error: 'Gemini API Key missing on server' }));
      clientWs.close();
      return;
    }

    // Top knowledge and ALL user-uploaded documents to ground Live API
    const adminAccess = isAdminUser(user);
    const customDocs = adminAccess ? ragEngine.getAllCustomDocuments() : ragEngine.getCustomDocuments(user.id);
    const userMemories = adminAccess ? getAllStoredUserMemories() : getUserMemories(user.id);
    const standardDocs = ragEngine.getAllDocuments(user.id).filter((d) => !d.isCustom);

    let uploadedFilesGrounding = '';
    if (customDocs.length > 0) {
      uploadedFilesGrounding =
        `\n\nCRITICAL USER UPLOADED FILES (HIGHEST PRIORITY):\n` +
        customDocs
          .map((d) => `Document Title: ${d.title}\nContent:\n${d.content}`)
          .join('\n\n') +
        `\nNote: When the user asks questions or speaks about their uploaded file, answer strictly and accurately from the above uploaded document.`;
    }

    const standardKnowledgeSnippets = standardDocs
      .map((d) => `- ${d.title}: ${d.content}\nSource: ${d.sourceUrl || 'সরকারি রেকর্ড'}`)
      .join('\n');

    const storedMemoryGrounding = userMemories.length > 0
      ? `\nIMPORTANT USER MEMORIES:\n${userMemories.map((memory) =>
        `Summary: ${memory.summary}\nFacts: ${memory.facts.join('\n')}\nOriginal statement: ${memory.originalText}`
      ).join('\n\n')}`
      : '';

    const systemInstruction = `You are a Bangladeshi Bangla voice AI agent speaking native, authentic Bengali with high cultural and local knowledge.
  When the session starts you will be asked to greet the user; say exactly: "${BENGALI_GREETING}" Do not repeat the greeting later in the conversation; answer the user's requests naturally.
${uploadedFilesGrounding}
${storedMemoryGrounding}
Standard Knowledge Base Context:
${standardKnowledgeSnippets}
Speak warmly and naturally in Bengali. You prioritize information from user uploaded files when asked.
Talk like a real Bangladeshi person in a friendly conversation, not like a machine reading text. Give complete, well-explained answers: usually several sentences that fully cover what the user asked, with helpful details and examples. Only keep it brief for greetings, small talk, or when the user asks for a short answer. Use natural spoken sentences with proper punctuation (। , ?), and never use lists, symbols, or markdown.`;

    // Connect to Gemini Live API: gemini-3.1-flash-live-preview
    liveSession = await ai.live.connect({
      model: 'gemini-3.1-flash-live-preview',
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: 'Zephyr',
            },
          },
        },
        systemInstruction,
        inputAudioTranscription: {},
        ...(speechRelay ? { outputAudioTranscription: {} } : {}),
        realtimeInputConfig: {
          automaticActivityDetection: {
            // Only clear, sustained speech starts a user turn, not background voices or noise
            startOfSpeechSensitivity: StartSensitivity.START_SENSITIVITY_LOW,
            // Let the user finish: a pause mid-sentence should not make the model answer early.
            // At 800ms a 0.7s pause already let a false start reach the speaker; 1200ms did not.
            endOfSpeechSensitivity: EndSensitivity.END_SENSITIVITY_LOW,
            silenceDurationMs: 1200,
            prefixPaddingMs: 200,
          },
          // The user can talk over the model; it stops and listens
          activityHandling: ActivityHandling.START_OF_ACTIVITY_INTERRUPTS,
        },
      },
      callbacks: {
        onmessage: (message: LiveServerMessage) => {
          const inputTranscript = (message as any).serverContent?.inputTranscription?.text;
          if (inputTranscript) {
            pendingInputTranscript += inputTranscript;
          }
          if ((message as any).serverContent?.turnComplete && pendingInputTranscript.trim()) {
            const transcript = pendingInputTranscript.trim();
            pendingInputTranscript = '';
            if (isAdminUser(user)) {
              ragEngine.addDocument({
                title: `Admin live voice information - ${new Date().toISOString().slice(0, 10)}`,
                category: 'custom',
                content: transcript,
                summary: transcript.slice(0, 160) + (transcript.length > 160 ? '...' : ''),
                tags: ['admin_voice', 'shared_information'],
                isCustom: true,
              }, SHARED_OWNER_ID);
            } else {
              storeImportantVoiceData(ai!, user.id, transcript).catch((memoryError: any) => {
                console.warn('Live voice memory was not stored:', memoryError?.message || memoryError);
              });
            }
          }

          const serverContent = message.serverContent;
          const answerEnded = Boolean(serverContent?.generationComplete || serverContent?.turnComplete || serverContent?.interrupted);
          if (dropModelOutput) {
            // Rest of the answer the user interrupted; wait for Gemini to end that turn
            if (answerEnded) dropModelOutput = false;
          } else if (speechRelay) {
            if (serverContent?.outputTranscription?.text) modelGenerating = true;
            // Speak the model's reply with ElevenLabs
            const outputTranscript = message.serverContent?.outputTranscription?.text;
            if (outputTranscript) speechRelay.pushText(outputTranscript);
            // Gemini delivers the whole answer by generationComplete but holds turnComplete until its
            // own (discarded) audio would finish playing, often 20s later; speak the rest right away.
            if (message.serverContent?.generationComplete || message.serverContent?.turnComplete) speechRelay.flush();
          } else {
            // Model turn audio output
            for (const part of message.serverContent?.modelTurn?.parts || []) {
              const audio = part.inlineData?.data;
              if (audio) modelGenerating = true;
              if (audio && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ audio }));
              }
            }
          }
          if (answerEnded) modelGenerating = false;

          // Real-time interruption event
          if (message.serverContent?.interrupted) {
            speechRelay?.interrupt();
            if (clientWs.readyState === WebSocket.OPEN) {
              clientWs.send(JSON.stringify({ interrupted: true }));
            }
          }

          // If transcription is returned by model
          const parts = message.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.text && clientWs.readyState === WebSocket.OPEN) {
                clientWs.send(JSON.stringify({ text: part.text }));
              }
            }
          }
        },
        onerror: (e: any) => {
          console.warn('Gemini Live session error:', e?.message || e);
        },
        onclose: (e: any) => {
          console.log('Gemini Live session closed:', e?.code, e?.reason || '');
          liveSession = null;
          // Let the client know so it can reconnect instead of streaming into a dead session
          if (clientWs.readyState === WebSocket.OPEN) {
            clientWs.close(1011, 'Live session ended');
          }
        },
      },
    });

    // Speak the welcome greeting as soon as the user starts a voice session
    const { searchParams } = new URL(request.url || '', `http://${request.headers.host}`);
    if (searchParams.get('greet') !== '0') {
      liveSession.sendRealtimeInput({ text: `Greet the user now by saying exactly: "${BENGALI_GREETING}"` });
    }

    clientWs.on('message', (rawData) => {
      try {
        const payload = JSON.parse(rawData.toString());
        if (payload.audio && liveSession) {
          // Send 16kHz PCM audio to Gemini Live API
          liveSession.sendRealtimeInput({
            audio: {
              data: payload.audio,
              mimeType: 'audio/pcm;rate=16000',
            },
          });
        } else if (payload.interrupt) {
          // The user started talking over the answer (detected in the browser): stop speaking now.
          // If Gemini is still writing that answer, skip the rest until it notices the user too.
          speechRelay?.interrupt();
          if (modelGenerating) dropModelOutput = true;
          modelGenerating = false;
          if (clientWs.readyState === WebSocket.OPEN) {
            // Every audio message sent after this acknowledgement belongs to the next answer
            clientWs.send(JSON.stringify({ interruptAck: true }));
          }
        } else if (payload.text && liveSession) {
          liveSession.sendRealtimeInput({
            text: payload.text,
          });
        }
      } catch (err) {
        console.warn('WebSocket input message parse error:', err);
      }
    });

    clientWs.on('close', () => {
      console.log('Client closed Live audio WebSocket');
      speechRelay?.close();
      if (liveSession) {
        try {
          liveSession.close();
        } catch (e) {
          // Session cleanup
        }
      }
    });

    clientWs.on('error', (err) => {
      console.warn('Client WebSocket error:', err);
    });
  } catch (liveErr: any) {
    console.error('Live connect error:', liveErr);
    if (clientWs.readyState === WebSocket.OPEN) {
      clientWs.send(JSON.stringify({ error: liveErr?.message || 'Live session failed' }));
    }
  }
});

// Vite Middleware integration for development and production static serving
async function setupViteMiddleware() {
  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  const startServerOnPort = (port: number) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EADDRINUSE') {
        const nextPort = port + 1;
        console.warn(`Port ${port} is already in use. Retrying on ${nextPort}...`);
        startServerOnPort(nextPort);
        return;
      }
      console.error('Server startup error:', error);
      process.exit(1);
    });

    server.listen(port, '0.0.0.0', () => {
      console.log(`Bangladeshi Bangla Voice AI Server running on http://localhost:${port}`);
    });
  };

  startServerOnPort(PORT);
}

setupViteMiddleware();
