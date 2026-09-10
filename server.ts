import express from 'express';
import http from 'http';
import path from 'path';
import dotenv from 'dotenv';
import { WebSocketServer, WebSocket } from 'ws';
import { GoogleGenAI, Modality, ThinkingLevel, LiveServerMessage } from '@google/genai';
import { createServer as createViteServer } from 'vite';
import { RagEngine } from './server/rag.ts';
import { extractTextFromPdfBuffer, generateContentWithFallback } from './server/fileProcessor.ts';
import { clearSessionCookie, createSession, getUserFromRequest, login, logout, publicUser, register, requestPasswordReset, resetPassword, sessionCookie } from './server/auth.ts';
import { getUserMemories, storeImportantVoiceData } from './server/userData.ts';

dotenv.config();

const PORT = Number(process.env.PORT || 3100);
const app = express();
const server = http.createServer(app);


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
    }, user.id);
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
    }, user.id);

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
      try {
        storedMemory = await storeImportantVoiceData(ai, user.id, transcribedText);
      } catch (memoryError: any) {
        console.warn('Voice memory was not stored:', memoryError?.message || memoryError);
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

// POST Convert Text to Speech using gemini-3.1-flash-tts-preview
app.post('/api/tts', async (req, res) => {
  const user = requireUser(req, res);
  if (!user) return;
  try {
    if (!ai) {
      return res.status(500).json({ error: 'GEMINI_API_KEY is not configured in server environment.' });
    }
    const { text, voiceName = 'Kore' } = req.body;
    if (!text) {
      return res.status(400).json({ error: 'Text is required for TTS' });
    }

    const cleanText = text;

    const response = await ai.models.generateContent({
      model: 'gemini-3.1-flash-tts-preview',
      contents: [
        {
          parts: [
            {
              text: `বাংলা ভাষা ঠিক মানুষের মত করে স্বাভাবিক ও স্পষ্ট বাচনে বলুন: ${cleanText}`,
            },
          ],
        },
      ],
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: voiceName || 'Kore',
            },
          },
        },
      },
    });

    const base64Audio = response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    if (!base64Audio) {
      return res.status(502).json({ error: 'No audio generated by TTS model' });
    }

    res.json({
      audioBase64: base64Audio,
      mimeType: 'audio/pcm;rate=24000',
    });
  } catch (error: any) {
    console.error('TTS error:', error);
    res.status(500).json({ error: error?.message || 'Failed to generate speech' });
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
    const customDocs = ragEngine.getCustomDocuments(user.id);
    const userMemories = getUserMemories(user.id);
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
    প্রথমে তুমি ইউজারকে স্বাগতম জানাবে এবং তুমি কি হেল্প করতে পারবে সেটা ব্যবহারকারীর কাছ থেকে জানতে চাইবে। 
তোমার দায়িত্ব ও নির্দেশনা:
১. তুমি একটি AI এর মত কথা না বলে একদম সম্পূর্ণ মানুষের মত করে উত্তর দাও।
২. ব্যবহারকারী যেসব ফাইল আপলোড করেছেন তার সম্পূর্ণ ডেটা স্থায়ীভাবে সংরক্ষিত রাখা হয়েছে এবং তোমার কাছে সরবরাহ করা হয়েছে। ব্যবহারকারীর প্রশ্ন যদি আপলোডকৃত কোনো ফাইল বা নথির তথ্য সম্পর্কিত হয়, তবে সেই সংরক্ষিত নথির ডেটা সম্পূর্ণভাবে পর্যালোচনা করে সরাসরি ও নির্ভুল প্রমিত বাংলায় উত্তর প্রদান করো।
৩. যদি সাধারণ রেফারেন্স তথ্যভাণ্ডার (RAG Context) থাকে, সেখান থেকেও প্রাসঙ্গিক তথ্য নিয়ে উত্তর দিতে পারো।
৪. কোনো তথ্য জানা না থাকলে বানোয়াট কিছু না বলে শান্তভাবে জানিয়ে দাও।
৫. ব্যবহারকারী যদি নোয়াখালী, চট্টগ্রাম বা সিলেটের আঞ্চলিক উপভাষায় কথা বলেন, তবে তা আন্তরিকভাবে বুঝে প্রমিত বাংলায় প্রাঞ্জল উত্তর দাও।
৬. উত্তরটি মুখে শোনার (TTS) জন্য অত্যন্ত শ্রুতিমধুর, স্পষ্ট, আকর্ষণীয় ও অনর্থক প্রতীকবিহীন (clean spoken Bengali) করো।`;

    const userPrompt = `ব্যবহারকারীর বার্তা বা প্রশ্ন: "${message}"\n\n` +
      (contextBlock ? `${contextBlock}\n\n` : '') +
      `দয়া করে প্রাসঙ্গিক তথ্য ও সংরক্ষিত নথির ডেটার ওপর ভিত্তি করে, AI এর মত কথা না বলে একদম সম্পূর্ণ মানুষের মত করে বলে বাংলায় সম্পূর্ণ সঠিক উত্তর দাও।`;

    let responseText = '';
    let thinkingProcess = '';
    let selectedModel = 'gemini-3.8-flash';

    if (mode === 'high_thinking') {
      selectedModel = 'gemini-3.1-pro-preview';
      const result = await ai.models.generateContent({
        model: selectedModel,
        contents: userPrompt,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.HIGH,
          },
        },
      });
      responseText = result.text || '';
    } else if (mode === 'fast') {
      selectedModel = 'gemini-3.1-flash-lite';
      const result = await ai.models.generateContent({
        model: selectedModel,
        contents: userPrompt,
        config: {
          systemInstruction,
          thinkingConfig: {
            thinkingLevel: ThinkingLevel.MINIMAL,
          },
        },
      });
      responseText = result.text || '';
    } else {
      selectedModel = 'gemini-3.8-flash';
      const result = await ai.models.generateContent({
        model: selectedModel,
        contents: userPrompt,
        config: {
          systemInstruction,
        },
      });
      responseText = result.text || '';
    }

    // Generate Audio via gemini-3.1-flash-tts-preview for seamless voice reply
    let audioBase64: string | undefined = undefined;
    try {
      // Pick first 250 chars of response for instant snappy audio voice reply
      const speechSummary = responseText.replace(/[*#_`>]/g, '').slice(0, 250);
      const ttsPromise = ai.models.generateContent({
        model: 'gemini-3.1-flash-tts-preview',
        contents: [
          {
            parts: [
              {
                text: `স্বাভাবিক বাচনে AI এর মত কথা না বলে একদম সম্পূর্ণ মানুষের মত করে বলুন: ${speechSummary}`,
              },
            ],
          },
        ],
        config: {
          responseModalities: [Modality.AUDIO],
          speechConfig: {
            voiceConfig: {
              prebuiltVoiceConfig: {
                voiceName: voiceName || 'Kore',
              },
            },
          },
        },
      });
      const ttsTimeout = new Promise((_, reject) => setTimeout(() => reject(new Error('TTS timeout')), 4000));
      const ttsResult = (await Promise.race([ttsPromise, ttsTimeout])) as any;
      audioBase64 = ttsResult?.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data;
    } catch (ttsErr: any) {
      console.warn('TTS inline generation skipped or timed out:', ttsErr?.message);
    }

    const latencyMs = Date.now() - startTime;

    res.json({
      text: responseText,
      thinkingProcess,
      retrievedSources,
      audioBase64,
      audioMimeType: audioBase64 ? 'audio/pcm;rate=24000' : undefined,
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
    const customDocs = ragEngine.getCustomDocuments(user.id);
    const userMemories = getUserMemories(user.id);
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
${uploadedFilesGrounding}
${storedMemoryGrounding}
Standard Knowledge Base Context:
${standardKnowledgeSnippets}
Speak concisely, warmly, and naturally in Bengali. You prioritize information from user uploaded files when asked.`;

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
            storeImportantVoiceData(ai!, user.id, transcript).catch((memoryError: any) => {
              console.warn('Live voice memory was not stored:', memoryError?.message || memoryError);
            });
          }

          // Model turn audio output
          const audio = message.serverContent?.modelTurn?.parts?.[0]?.inlineData?.data;
          if (audio && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ audio }));
          }

          // Real-time interruption event
          if (message.serverContent?.interrupted && clientWs.readyState === WebSocket.OPEN) {
            clientWs.send(JSON.stringify({ interrupted: true }));
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
      },
    });

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

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Bangladeshi Bangla Voice AI Server running on http://0.0.0.0:${PORT}`);
  });
}

setupViteMiddleware();
