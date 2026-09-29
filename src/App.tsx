/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef } from 'react';
import {
  Mic,
  Volume2,
  Sparkles,
  AlertCircle,
  UploadCloud,
  Database,
  FileText,
  Trash2,
  X,
  ChevronDown,
  ChevronUp,
  CheckCircle2,
} from 'lucide-react';
import { BargeInDetector, GaplessPcmPlayer, MainSpeakerGate, float32ToInt16PCM, arrayBufferToBase64 } from './utils/audioUtils';
import { KnowledgeDocument, ModelMode } from './types';
import { AuthScreen } from './components/AuthScreen';
import { VoiceSettingsPanel } from './components/VoiceSettingsPanel';

type VoiceState = 'idle' | 'connecting' | 'listening' | 'speaking' | 'error';

// Reconnects in a row without the AI ever answering before the voice session gives up
const MAX_LIVE_RECONNECTS = 3;

const MODE_OPTIONS: { key: ModelMode; label: string }[] = [
  { key: 'high_thinking', label: 'Deep thinking' },
  { key: 'fast', label: 'Fast' },
  { key: 'standard', label: 'Standard' },
];

const formatNumber = (value: number) => value.toLocaleString('en-US');

/** Admin voice notes are titled like "Admin live voice information - 2026-09-25" or "Admin voice note - 2026-09-27" */
function displayDocTitle(title: string): string {
  const match = title.match(/^Admin (?:live )?voice (?:information|note) - (\d{4}-\d{2}-\d{2})$/);
  return match ? `Admin voice note - ${formatDate(match[1])}` : title;
}

function formatDate(isoDate: string): string {
  const date = new Date(isoDate);
  return Number.isNaN(date.getTime()) ? isoDate : date.toLocaleDateString('en-GB', { year: 'numeric', month: 'long', day: 'numeric' });
}

export default function App() {
  const [user, setUser] = useState<{ id: string; email: string; createdAt: string; isAdmin?: boolean } | null>(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [selectedMode, setSelectedMode] = useState<ModelMode>('standard');
  const [voiceState, setVoiceState] = useState<VoiceState>('idle');
  const [volumeLevel, setVolumeLevel] = useState<number>(0);
  const [statusMessage, setStatusMessage] = useState<string>('Tap the button to talk');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [isVoicePanelOpen, setIsVoicePanelOpen] = useState(false);

  const readJsonResponse = async <T,>(response: Response, fallbackMessage: string): Promise<T> => {
    const rawText = await response.text();
    if (!rawText) {
      throw new Error(fallbackMessage);
    }

    try {
      return JSON.parse(rawText) as T;
    } catch {
      const trimmed = rawText.replace(/\s+/g, ' ').slice(0, 220);
      const contentType = response.headers.get('content-type') || '';
      const serverHint = contentType.includes('text/html') || !trimmed
        ? 'The server did not respond correctly. Make sure it is running and try again.'
        : fallbackMessage;
      throw new Error(serverHint);
    }
  };

  // File Upload for RAG state
  const [isUploading, setIsUploading] = useState<boolean>(false);
  const [isDragging, setIsDragging] = useState<boolean>(false);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Stored Documents & LLM Access State
  const [storedDocs, setStoredDocs] = useState<KnowledgeDocument[]>([]);
  const [isDocsModalOpen, setIsDocsModalOpen] = useState<boolean>(false);
  const [expandedDocId, setExpandedDocId] = useState<string | null>(null);
  const [isDeletingId, setIsDeletingId] = useState<string | null>(null);
  const [uploadSuccessMsg, setUploadSuccessMsg] = useState<string | null>(null);

  // Audio Playback Player (24kHz for Gemini Live & Speech Audio)
  const pcmPlayerRef = useRef<GaplessPcmPlayer | null>(null);
  const mp3AudioRef = useRef<HTMLAudioElement | null>(null);

  // Live WebSocket & Media Stream references
  const liveWsRef = useRef<WebSocket | null>(null);
  const shouldReconnectLiveRef = useRef(false);
  const liveReconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const liveHasConnectedRef = useRef(false);
  const liveReconnectAttemptsRef = useRef(0);
  const micAudioCtxRef = useRef<AudioContext | null>(null);
  const micMediaStreamRef = useRef<MediaStream | null>(null);
  const scriptProcessorRef = useRef<ScriptProcessorNode | null>(null);
  // Talking over the AI stops it; audio for the interrupted reply is ignored until the server confirms
  const bargeInRef = useRef(new BargeInDetector());
  const awaitingInterruptAckRef = useRef(false);
  // Only the person at the mic is sent to the model; side voices and noise become silence
  const speakerGateRef = useRef(new MainSpeakerGate());

  // Fallback recorder for voice queries if WS is closed
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  // Fetch stored custom documents from persistent storage
  const fetchStoredDocuments = async () => {
    try {
      const res = await fetch('/api/rag/custom-documents');
      if (res.ok) {
        const data = await readJsonResponse<{ documents?: KnowledgeDocument[] }>(res, 'Could not load the stored documents.');
        setStoredDocs(data.documents || []);
      }
    } catch (e) {
      console.warn('Could not load stored documents:', e);
    }
  };

  useEffect(() => {
    fetch('/api/auth/me')
      .then(async (res) => {
        const data = await readJsonResponse<{ user?: { id: string; email: string; createdAt: string; isAdmin?: boolean } | null }>(res, 'Could not check the login status.');
        setUser(data.user || null);
        if (data.user?.isAdmin) fetchStoredDocuments();
      })
      .catch(() => setUser(null))
      .finally(() => setAuthChecked(true));
    pcmPlayerRef.current = new GaplessPcmPlayer(24000);
    pcmPlayerRef.current.setOnEnded(() => {
      setVoiceState((current) => (current === 'speaking' ? 'listening' : current));
      setStatusMessage('Listening... go ahead');
    });

    return () => {
      stopVoiceSession();
      if (pcmPlayerRef.current) {
        pcmPlayerRef.current.stop();
      }
    };
  }, []);

  const handleLogout = async () => {
    stopVoiceSession();
    await fetch('/api/auth/logout', { method: 'POST' });
    setUser(null);
    setStoredDocs([]);
    setIsVoicePanelOpen(false);
  };


  const stopVoiceSession = () => {
    shouldReconnectLiveRef.current = false;
    liveHasConnectedRef.current = false;
    if (liveReconnectTimerRef.current) {
      clearTimeout(liveReconnectTimerRef.current);
      liveReconnectTimerRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }
    if (liveWsRef.current) {
      if (liveWsRef.current.readyState === WebSocket.OPEN) {
        liveWsRef.current.close();
      }
      liveWsRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {
        // ignore
      }
    }
    if (micMediaStreamRef.current) {
      micMediaStreamRef.current.getTracks().forEach((track) => track.stop());
      micMediaStreamRef.current = null;
    }
    if (pcmPlayerRef.current) {
      pcmPlayerRef.current.stop();
    }
    if (mp3AudioRef.current) {
      mp3AudioRef.current.pause();
      mp3AudioRef.current.currentTime = 0;
      mp3AudioRef.current = null;
    }
    setVoiceState('idle');
    setVolumeLevel(0);
    setStatusMessage('Tap the button to talk');
  };

  const releaseLiveTransport = () => {
    if (micMediaStreamRef.current) {
      micMediaStreamRef.current.getTracks().forEach((track) => track.stop());
      micMediaStreamRef.current = null;
    }
    if (scriptProcessorRef.current) {
      scriptProcessorRef.current.disconnect();
      scriptProcessorRef.current = null;
    }
    if (micAudioCtxRef.current) {
      micAudioCtxRef.current.close().catch(() => {});
      micAudioCtxRef.current = null;
    }
  };

  const startVoiceSession = async (isReconnect = false) => {
    shouldReconnectLiveRef.current = true;
    if (!isReconnect) liveReconnectAttemptsRef.current = 0;
    setErrorMessage(null);
    setVoiceState('connecting');
    setStatusMessage('Connecting...');

    try {
      if (!pcmPlayerRef.current) {
        pcmPlayerRef.current = new GaplessPcmPlayer(24000);
      }
      const pcmPlayer = pcmPlayerRef.current;
      await pcmPlayer.resume();

      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsUrl = `${protocol}//${window.location.host}/ws/live${isReconnect ? '?greet=0' : ''}`;
      const ws = new WebSocket(wsUrl);
      liveWsRef.current = ws;
      awaitingInterruptAckRef.current = false;
      bargeInRef.current.reset();
      speakerGateRef.current = new MainSpeakerGate();

      ws.onopen = async () => {
        liveHasConnectedRef.current = true;
        try {
          const stream = await navigator.mediaDevices.getUserMedia({
            audio: {
              sampleRate: 16000,
              channelCount: 1, // mono: one voice, one channel
              echoCancellation: true,
              noiseSuppression: true,
              // Automatic gain boosts the mic whenever the user is quiet, making voices across the room
              // as loud as the user's; without it the person at the mic stays clearly louder.
              autoGainControl: false,
              // Isolates the main voice where the browser supports it; ignored elsewhere
              voiceIsolation: true,
            } as MediaTrackConstraints,
          });
          // The session ended (e.g. a server error) while the browser was asking for the mic
          if (liveWsRef.current !== ws) {
            stream.getTracks().forEach((track) => track.stop());
            return;
          }
          micMediaStreamRef.current = stream;

          const AudioCtxClass = window.AudioContext || (window as any).webkitAudioContext;
          const audioCtx = new AudioCtxClass({ sampleRate: 16000 });
          micAudioCtxRef.current = audioCtx;

          const source = audioCtx.createMediaStreamSource(stream);
          // Remove low rumble (fans, traffic, desk bumps) below the speaking voice
          const rumbleFilter = audioCtx.createBiquadFilter();
          rumbleFilter.type = 'highpass';
          rumbleFilter.frequency.value = 100;
          // 1024 samples = 64ms frames, so the model hears the user (and barge-in reacts) quickly
          const processor = audioCtx.createScriptProcessor(1024, 1, 1);
          scriptProcessorRef.current = processor;

          processor.onaudioprocess = (e) => {
            if (ws.readyState !== WebSocket.OPEN) return;

            const inputData = e.inputBuffer.getChannelData(0);

            // Compute volume level
            let sum = 0;
            for (let i = 0; i < inputData.length; i++) {
              sum += inputData[i] * inputData[i];
            }
            const rms = Math.sqrt(sum / inputData.length);
            const normVolume = Math.min(100, Math.round(rms * 450));
            setVolumeLevel(normVolume);

            const sendAudio = (samples: Float32Array) => {
              ws.send(JSON.stringify({ audio: arrayBufferToBase64(float32ToInt16PCM(samples)) }));
            };

            // Send 16kHz PCM audio. While the AI is speaking, send silence so its own voice picked up
            // by the mic is not mistaken for the user, but watch for the user talking over it.
            const player = pcmPlayerRef.current;
            const aiSpeaking = (player?.isPlaying ?? false) && !awaitingInterruptAckRef.current;
            if (!aiSpeaking) {
              bargeInRef.current.reset();
              const mainSpeaker = speakerGateRef.current.process(inputData, rms);
              if (mainSpeaker.length > 0) mainSpeaker.forEach(sendAudio);
              else sendAudio(new Float32Array(inputData.length));
              return;
            }
            // Side voices must not interrupt either: require the main speaker's level
            const userSpeech = bargeInRef.current.process(inputData, rms, speakerGateRef.current.threshold());
            if (!userSpeech) {
              sendAudio(new Float32Array(inputData.length));
              return;
            }
            // The user started talking: stop the AI at once and let the model hear them from the start
            player?.stop();
            awaitingInterruptAckRef.current = true;
            ws.send(JSON.stringify({ interrupt: true }));
            userSpeech.forEach(sendAudio);
            speakerGateRef.current.forceOpen();
            setVoiceState('listening');
            setStatusMessage('Listening... go ahead');
          };

          source.connect(rumbleFilter);
          rumbleFilter.connect(processor);
          processor.connect(audioCtx.destination);

          setVoiceState('listening');
          setStatusMessage('Listening... speak in Bangla');
        } catch (err: any) {
          console.error('Microphone error:', err);
          setErrorMessage('Microphone permission is required.');
          stopVoiceSession();
        }
      };

      ws.onmessage = (event) => {
        try {
          const data = JSON.parse(event.data);

          if (data.error) {
            console.error('Live error:', data.error);
            setErrorMessage(data.error);
            stopVoiceSession();
            return;
          }

          if (data.interruptAck) {
            awaitingInterruptAckRef.current = false;
          }

          // The AI answered, so the connection works: allow fresh reconnects later
          if (data.audio) liveReconnectAttemptsRef.current = 0;

          // Skip what is left of a reply the user talked over
          if (data.audio && !awaitingInterruptAckRef.current) {
            setVoiceState('speaking');
            setStatusMessage('AI is answering...');
            pcmPlayerRef.current?.queuePcmBase64(data.audio);
          }

          if (data.interrupted) {
            pcmPlayerRef.current?.stop();
            setVoiceState('listening');
            setStatusMessage('Listening... go ahead');
          }
        } catch (err) {
          console.warn('WS message error:', err);
        }
      };

      ws.onerror = (err) => {
        console.warn('Live WebSocket error:', err);
      };

      ws.onclose = () => {
        liveWsRef.current = null;
        if (shouldReconnectLiveRef.current) {
          const wasConnected = liveHasConnectedRef.current;
          liveHasConnectedRef.current = false;
          if (wasConnected && liveReconnectAttemptsRef.current >= MAX_LIVE_RECONNECTS) {
            // The session keeps dropping before the AI says anything: stop instead of looping forever
            stopVoiceSession();
            setErrorMessage('The voice connection keeps dropping. Check your internet connection and try again later.');
          } else if (wasConnected) {
            liveReconnectAttemptsRef.current++;
            releaseLiveTransport();
            setVoiceState('connecting');
            setStatusMessage('Reconnecting...');
            liveReconnectTimerRef.current = setTimeout(() => {
              liveReconnectTimerRef.current = null;
              startVoiceSession(true);
            }, 1000);
          } else {
            shouldReconnectLiveRef.current = false;
            startFallbackVoiceQuery();
          }
        }
      };
    } catch (err: any) {
      console.error('Session start error:', err);
      startFallbackVoiceQuery();
    }
  };

  const startFallbackVoiceQuery = async () => {
    try {
      setStatusMessage('Listening... go ahead');
      setVoiceState('listening');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micMediaStreamRef.current = stream;

      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) audioChunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        mediaRecorderRef.current = null;
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });
        if (audioBlob.size === 0) {
          setErrorMessage('No audio was recorded. Please try again.');
          setVoiceState('idle');
          return;
        }
        setStatusMessage('Processing...');
        setVoiceState('connecting');

        const reader = new FileReader();
        reader.readAsDataURL(audioBlob);
        reader.onloadend = async () => {
          try {
            const base64Data = (reader.result as string).split(',')[1];
            // Transcribe voice in Bengali via Gemini 3.5 Transcribe
            const transRes = await fetch('/api/transcribe', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ audioBase64: base64Data, mimeType }),
            });
            const transData = await readJsonResponse<{ text?: string; error?: string }>(
              transRes,
              'Could not recognise the speech. The server is not responding.',
            );
            if (!transRes.ok) {
              throw new Error(transData.error || 'Could not recognise the speech');
            }
            const transcribed = transData.text;

            if (!transcribed) {
              setStatusMessage('Didn\'t catch that, please try again');
              setVoiceState('idle');
              return;
            }

            // Query RAG backend with spoken text (with attached uploaded files)
            const queryRes = await fetch('/api/rag/query', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ message: transcribed, mode: selectedMode, voiceName: 'Kore', enableRag: true }),
            });
            const queryData = await readJsonResponse<{ text?: string; error?: string; audioBase64?: string; audioMimeType?: string }>(
              queryRes,
              'Could not generate an answer. Please try again.',
            );
            if (!queryRes.ok) {
              throw new Error(queryData.error || 'Could not generate an answer');
            }

            if (queryData.audioBase64) {
              setVoiceState('speaking');
              setStatusMessage('AI is answering...');
              const audio = new Audio(`data:${queryData.audioMimeType || 'audio/mpeg'};base64,${queryData.audioBase64}`);
              mp3AudioRef.current = audio;
              audio.onended = () => {
                mp3AudioRef.current = null;
                setVoiceState('idle');
                setStatusMessage('Tap the button to talk');
              };
              await audio.play().catch((playError) => {
                throw new Error(`Could not play audio: ${playError?.message || 'the browser blocked audio playback'}`);
              });
            } else if (queryData.text) {
              const ttsRes = await fetch('/api/tts', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ text: queryData.text }),
              });
              const ttsData = await readJsonResponse<{ audioBase64?: string; error?: string; mimeType?: string }>(
                ttsRes,
                'Could not generate the voice. The server is not responding.',
              );
              if (!ttsRes.ok || !ttsData.audioBase64) {
                throw new Error(ttsData.error || 'Could not generate the voice');
              }
              setVoiceState('speaking');
              setStatusMessage('AI is answering...');
              const audio = new Audio(`data:${ttsData.mimeType || 'audio/mpeg'};base64,${ttsData.audioBase64}`);
              mp3AudioRef.current = audio;
              audio.onended = () => {
                mp3AudioRef.current = null;
                setVoiceState('idle');
                setStatusMessage('Tap the button to talk');
              };
              await audio.play();
            } else {
              setStatusMessage(queryData.text ? queryData.text.slice(0, 80) : 'Done');
              setVoiceState('idle');
            }
          } catch (e: any) {
            console.error('Voice request failed:', e);
            setErrorMessage(e?.message || 'The request could not be completed');
            setVoiceState('idle');
          }
        };
      };

      mediaRecorderRef.current = recorder;
      recorder.start(250);
    } catch (e: any) {
      setErrorMessage('Could not start the microphone');
      setVoiceState('idle');
    }
  };

  const handleToggleVoice = () => {
    if (voiceState === 'idle' || voiceState === 'error') {
      startVoiceSession();
    } else {
      stopVoiceSession();
    }
  };

  const formatFriendlyError = (err: any): string => {
    let raw = typeof err === 'string' ? err : err?.message || '';
    if (raw.includes('{') && raw.includes('}')) {
      try {
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          const parsed = JSON.parse(jsonMatch[0]);
          if (parsed?.error?.message) {
            raw = parsed.error.message;
          }
        }
      } catch {
        // ignore
      }
    }

    if (raw.includes('503') || raw.includes('UNAVAILABLE') || raw.includes('high demand')) {
      return 'The model is busy right now. Please try again in a few seconds.';
    }
    if (raw.includes('429') || raw.includes('RESOURCE_EXHAUSTED')) {
      return 'Request limit reached. Please wait a moment and try again.';
    }
    return raw || 'Could not upload and process the file. Please try again.';
  };

  // Handle RAG File Upload (silently attaches to model, no notifications)
  const handleProcessFile = async (file: File) => {
    setIsUploading(true);
    setErrorMessage(null);
    try {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onloadend = async () => {
        try {
          const base64 = (reader.result as string).split(',')[1];
          const response = await fetch('/api/rag/upload-file', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              fileName: file.name,
              fileType: file.type || 'application/octet-stream',
              fileBase64: base64,
            }),
          });

          const data = await readJsonResponse<{ error?: string }>(response, 'Could not upload the file. The server did not respond correctly.');
          if (!response.ok) {
            throw new Error(data.error || 'Could not upload the file.');
          }
          // Refresh the stored documents list (only admins can see it)
          if (user?.isAdmin) await fetchStoredDocuments();
          setUploadSuccessMsg(`"${file.name}" saved. The AI can now use it.`);
          setTimeout(() => setUploadSuccessMsg(null), 4000);
        } catch (uploadErr: any) {
          console.error('File upload error:', uploadErr);
          setErrorMessage(formatFriendlyError(uploadErr));
        } finally {
          setIsUploading(false);
          if (fileInputRef.current) {
            fileInputRef.current.value = '';
          }
        }
      };
    } catch (err: any) {
      console.error('File read error:', err);
      setErrorMessage('Could not read the file');
      setIsUploading(false);
    }
  };

  const handleDeleteDocument = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setIsDeletingId(id);
    try {
      const res = await fetch(`/api/rag/documents/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (res.ok) {
        setStoredDocs((prev) => prev.filter((d) => d.id !== id));
      } else {
        const data = await readJsonResponse<{ error?: string }>(res, 'Could not delete the document.');
        setErrorMessage(data.error || 'Could not delete the document.');
      }
    } catch (err) {
      console.error('Delete document error:', err);
      setErrorMessage('Could not delete the document.');
    } finally {
      setIsDeletingId(null);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      handleProcessFile(file);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setIsDragging(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      handleProcessFile(file);
    }
  };

  // Button dynamic styling based on state
  const isActive = voiceState === 'listening' || voiceState === 'speaking' || voiceState === 'connecting';
  const scale = voiceState === 'speaking' ? 1.08 : voiceState === 'listening' ? 1 + volumeLevel * 0.0025 : 1;

  if (!authChecked) return <div className="min-h-screen bg-slate-950" />;
  if (!user) return <AuthScreen onAuthenticated={(authenticatedUser) => { setUser(authenticatedUser); if (authenticatedUser.isAdmin) fetchStoredDocuments(); }} />;

  return (
    <main
      id="voice-app-root"
      onDragOver={(e) => {
        e.preventDefault();
        setIsDragging(true);
      }}
      onDragLeave={() => setIsDragging(false)}
      onDrop={handleDrop}
      className={`relative flex min-h-screen w-full flex-col items-center justify-center overflow-hidden bg-slate-950 p-6 text-slate-100 select-none font-sans transition-colors ${
        isDragging ? 'ring-4 ring-emerald-500/50 bg-slate-900/90' : ''
      }`}
    >
      <div className="absolute top-5 left-1/2 z-20 -translate-x-1/2">
        <div className="flex items-center gap-2 rounded-xl border border-slate-700/80 bg-slate-900/80 p-1.5 shadow-lg shadow-black/20 backdrop-blur-md">
          {MODE_OPTIONS.map((option) => (
            <button
              key={option.key}
              type="button"
              onClick={() => setSelectedMode(option.key)}
              className={`rounded-lg px-3 py-1.5 text-xs font-medium transition-all ${
                selectedMode === option.key
                  ? 'bg-emerald-600 text-white shadow-sm'
                  : 'text-slate-300 hover:bg-slate-800 hover:text-white'
              }`}
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>
      {/* Top action bar: File upload & Stored Knowledge Base */}
      <header className="absolute top-5 left-6 z-20 flex flex-wrap items-center gap-3 pointer-events-auto">
        <input
          type="file"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept=".txt,.md,.pdf,.json,.csv"
          className="hidden"
        />
        <button
          id="rag-file-upload-button"
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={isUploading}
          className="inline-flex items-center gap-2 px-3.5 py-2 rounded-xl bg-slate-900/80 hover:bg-slate-850 border border-slate-800 hover:border-emerald-500/40 text-xs font-medium text-slate-300 hover:text-emerald-300 shadow-md transition-all cursor-pointer backdrop-blur-md active:scale-95"
          title="Add a PDF, TXT, MD, JSON or CSV file for the AI to learn from"
        >
          <UploadCloud className={`w-4 h-4 ${isUploading ? 'animate-bounce text-emerald-400' : 'text-emerald-400'}`} />
          <span>{isUploading ? 'Uploading...' : 'Add file'}</span>
        </button>

        {user.isAdmin && storedDocs.length > 0 && (
          <button
            type="button"
            onClick={() => setIsDocsModalOpen(true)}
            className="hidden sm:flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-emerald-950/60 border border-emerald-800/40 text-[11px] text-emerald-300 backdrop-blur-md hover:border-emerald-500/60 cursor-pointer"
            title="View stored documents"
          >
            <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
            <span>Stored documents ({formatNumber(storedDocs.length)})</span>
          </button>
        )}
      </header>
      <div className="absolute right-6 top-5 z-20 flex items-center gap-3 text-xs text-slate-400">
        <span className="hidden sm:inline">{user.email}</span>
        {user.isAdmin && (
          <button type="button" onClick={() => setIsVoicePanelOpen(true)} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 hover:border-emerald-500/50 hover:text-emerald-300" title="Choose the AI voice">
            <Volume2 className="h-3.5 w-3.5" />
            <span>Voice</span>
          </button>
        )}
        <button type="button" onClick={handleLogout} className="rounded-lg border border-slate-700 bg-slate-900/80 px-3 py-2 hover:border-rose-500/50 hover:text-rose-300">Log out</button>
      </div>

      {/* Subtle background radial glow */}
      <div
        className={`pointer-events-none absolute inset-0 transition-opacity duration-1000 ${
          voiceState === 'speaking'
            ? 'opacity-40 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-500/25 via-teal-950/20 to-transparent'
            : voiceState === 'listening'
            ? 'opacity-35 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-emerald-600/20 via-teal-900/15 to-transparent'
            : 'opacity-15 bg-[radial-gradient(circle_at_center,_var(--tw-gradient-stops))] from-slate-800/30 to-transparent'
        }`}
      />

      {/* Pulsing visual rings behind button when active */}
      {isActive && (
        <div className="pointer-events-none absolute flex items-center justify-center">
          <div
            className={`w-64 h-64 sm:w-80 sm:h-80 rounded-full transition-all duration-300 ${
              voiceState === 'speaking'
                ? 'bg-emerald-500/15 animate-ping'
                : 'bg-emerald-400/10 animate-pulse'
            }`}
            style={{ animationDuration: voiceState === 'speaking' ? '2s' : '1.6s' }}
          />
          <div
            className={`absolute w-52 h-52 sm:w-64 sm:h-64 rounded-full border transition-all duration-300 ${
              voiceState === 'speaking'
                ? 'border-emerald-400/30 ring-4 ring-emerald-500/20'
                : 'border-teal-500/20 ring-2 ring-teal-500/10'
            }`}
          />
        </div>
      )}

      {/* Centered Main Voice Button Container */}
      <div className="relative z-10 flex flex-col items-center justify-center">
        {/* The Voice Button */}
        <button
          id="main-voice-button"
          type="button"
          onClick={handleToggleVoice}
          style={{ transform: `scale(${scale})` }}
          aria-label={isActive ? 'Stop the voice assistant' : 'Start the voice assistant'}
          className={`relative flex h-36 w-36 sm:h-44 sm:w-44 cursor-pointer items-center justify-center rounded-full transition-all duration-300 focus:outline-none ${
            voiceState === 'speaking'
              ? 'bg-gradient-to-tr from-emerald-600 via-teal-500 to-emerald-400 text-white shadow-2xl shadow-emerald-500/40 ring-4 ring-emerald-300/50'
              : voiceState === 'listening'
              ? 'bg-gradient-to-tr from-emerald-700 via-emerald-600 to-teal-500 text-white shadow-2xl shadow-emerald-600/40 ring-4 ring-emerald-400/40'
              : voiceState === 'connecting'
              ? 'bg-gradient-to-tr from-slate-800 to-slate-700 text-slate-300 shadow-xl ring-2 ring-emerald-500/40 animate-pulse'
              : 'bg-gradient-to-tr from-slate-900 via-slate-850 to-slate-800 hover:from-slate-850 hover:to-slate-750 text-slate-300 shadow-2xl shadow-black/80 ring-1 ring-slate-700/80 hover:ring-emerald-500/50 active:scale-95'
          }`}
        >
          {voiceState === 'speaking' ? (
            <Volume2 className="h-16 w-16 sm:h-20 sm:w-20 text-white animate-pulse" />
          ) : voiceState === 'listening' ? (
            <Mic className="h-16 w-16 sm:h-20 sm:w-20 text-white animate-bounce" />
          ) : voiceState === 'connecting' ? (
            <Sparkles className="h-14 w-14 sm:h-16 sm:w-16 text-emerald-400 animate-spin" />
          ) : (
            <Mic className="h-14 w-14 sm:h-18 sm:w-18 text-emerald-400 transition-colors" />
          )}
        </button>

        {/* Minimal status text below button */}
        <div className="mt-8 text-center max-w-md">
          <p
            id="voice-status-text"
            className={`text-base sm:text-lg font-medium tracking-wide transition-colors ${
              voiceState === 'speaking'
                ? 'text-emerald-300'
                : voiceState === 'listening'
                ? 'text-emerald-400'
                : voiceState === 'connecting'
                ? 'text-teal-300'
                : 'text-slate-400'
            }`}
          >
            {statusMessage}
          </p>

          {/* Audio volume bars indicator when speaking or listening */}
          {isActive && (
            <div className="mt-3 flex items-center justify-center gap-1 h-4">
              {[...Array(5)].map((_, i) => (
                <span
                  key={i}
                  className={`w-1 rounded-full bg-emerald-400 transition-all duration-150 ${
                    voiceState === 'speaking' ? 'animate-pulse' : ''
                  }`}
                  style={{
                    height:
                      voiceState === 'speaking'
                        ? `${8 + ((i * 3) % 10)}px`
                        : `${Math.max(4, Math.min(18, (volumeLevel / 100) * 18 * (1 - Math.abs(i - 2) * 0.2)))}px`,
                  }}
                />
              ))}
            </div>
          )}

          {/* Minimal error notification if any */}
          {errorMessage && (
            <div
              id="voice-error-banner"
              className="mt-4 flex items-center gap-2 rounded-xl bg-rose-950/60 border border-rose-800/60 px-4 py-2 text-xs text-rose-300"
            >
              <AlertCircle className="h-4 w-4 shrink-0 text-rose-400" />
              <span>{errorMessage}</span>
            </div>
          )}

          {/* Upload Success & LLM Stored Feedback */}
          {uploadSuccessMsg && (
            <div
              id="upload-success-toast"
              className="mt-4 inline-flex items-center gap-2 rounded-xl bg-emerald-950/80 border border-emerald-700/70 px-4 py-2 text-xs text-emerald-300 shadow-lg shadow-emerald-950/50 animate-fade-in"
            >
              <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
              <span>{uploadSuccessMsg}</span>
            </div>
          )}
        </div>
      </div>

      {/* Stored Documents & LLM Access Modal (admin only) */}
      {user.isAdmin && isDocsModalOpen && (
        <div
          id="stored-docs-modal-overlay"
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-fade-in pointer-events-auto"
          onClick={() => setIsDocsModalOpen(false)}
        >
          <div
            id="stored-docs-modal"
            className="relative w-full max-w-2xl max-h-[85vh] flex flex-col rounded-2xl bg-slate-900 border border-slate-800 shadow-2xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-800 bg-slate-900/90">
              <div className="flex items-center gap-3">
                <div className="p-2 rounded-xl bg-teal-500/10 border border-teal-500/20 text-teal-400">
                  <Database className="w-5 h-5" />
                </div>
                <div>
                  <h3 className="text-base font-semibold text-slate-100 flex items-center gap-2">
                    Stored documents & AI knowledge base
                    <span className="text-xs px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-normal flex items-center gap-1">
                      <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse" />
                      Active in AI ({formatNumber(storedDocs.length)} documents)
                    </span>
                  </h3>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Everything extracted from uploaded files is stored permanently and the AI uses it directly when answering.
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setIsDocsModalOpen(false)}
                className="p-1.5 rounded-lg text-slate-400 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Modal Body */}
            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              {storedDocs.length === 0 ? (
                <div className="flex flex-col items-center justify-center py-12 text-center text-slate-400">
                  <div className="p-4 rounded-2xl bg-slate-800/60 border border-slate-700/50 mb-3 text-slate-500">
                    <FileText className="w-8 h-8" />
                  </div>
                  <h4 className="text-sm font-medium text-slate-200">No files uploaded yet</h4>
                  <p className="text-xs text-slate-400 mt-1 max-w-sm">
                    Upload any PDF, TXT, MD or CSV file. Its content is stored here and the AI can use it right away.
                  </p>
                  <button
                    type="button"
                    onClick={() => {
                      setIsDocsModalOpen(false);
                      fileInputRef.current?.click();
                    }}
                    className="mt-4 inline-flex items-center gap-2 px-4 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-xs font-semibold text-white shadow-lg shadow-emerald-600/30 transition-all cursor-pointer active:scale-95"
                  >
                    <UploadCloud className="w-4 h-4" />
                    <span>Upload file</span>
                  </button>
                </div>
              ) : (
                storedDocs.map((doc) => {
                  const isExpanded = expandedDocId === doc.id;
                  const isDeleting = isDeletingId === doc.id;
                  return (
                    <div
                      key={doc.id}
                      className="rounded-xl bg-slate-850 border border-slate-750/80 p-4 hover:border-slate-700 transition-all shadow-sm"
                    >
                      {/* Document Header */}
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex items-start gap-3">
                          <div className="p-2 rounded-lg bg-slate-800 text-teal-400 border border-slate-700 shrink-0 mt-0.5">
                            <FileText className="w-4 h-4" />
                          </div>
                          <div>
                            <h4 className="text-sm font-semibold text-slate-200 break-all">{displayDocTitle(doc.title)}</h4>
                            <div className="flex flex-wrap items-center gap-2 mt-1 text-[11px] text-slate-400">
                              <span className="px-2 py-0.5 rounded bg-slate-800 border border-slate-700 font-mono text-slate-300">
                                {!doc.category || doc.category === 'custom' ? 'Custom' : doc.category}
                              </span>
                              <span>•</span>
                              <span>Saved: {formatDate(doc.createdAt)}</span>
                              <span>•</span>
                              <span>{formatNumber(doc.content.length)} characters</span>
                            </div>
                          </div>
                        </div>

                        {/* Actions */}
                        <div className="flex items-center gap-1.5 shrink-0">
                          <button
                            type="button"
                            onClick={(e) => handleDeleteDocument(doc.id, e)}
                            disabled={isDeleting}
                            className="p-1.5 rounded-lg text-slate-400 hover:text-rose-400 hover:bg-rose-950/30 transition-colors cursor-pointer"
                            title="Delete document"
                          >
                            <Trash2 className={`w-4 h-4 ${isDeleting ? 'animate-spin text-rose-400' : ''}`} />
                          </button>
                        </div>
                      </div>

                      {/* AI Summary */}
                      {doc.summary && (
                        <div className="mt-3 p-2.5 rounded-lg bg-slate-900/80 border border-slate-800 text-xs text-slate-300 flex items-start gap-2">
                          <Sparkles className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-medium text-emerald-400">AI summary: </span>
                            {doc.summary}
                          </div>
                        </div>
                      )}

                      {/* Expand/Collapse Extracted Data Button */}
                      <div className="mt-3 pt-2.5 border-t border-slate-800 flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => setExpandedDocId(isExpanded ? null : doc.id)}
                          className="inline-flex items-center gap-1 text-xs font-medium text-teal-400 hover:text-teal-300 transition-colors cursor-pointer"
                        >
                          <span>{isExpanded ? 'Hide stored content' : 'Show stored content'}</span>
                          {isExpanded ? <ChevronUp className="w-3.5 h-3.5" /> : <ChevronDown className="w-3.5 h-3.5" />}
                        </button>
                        <span className="text-[11px] text-emerald-400/80 font-medium">
                          ✓ Used by the AI
                        </span>
                      </div>

                      {/* Preformatted Raw Extracted Data */}
                      {isExpanded && (
                        <div className="mt-2.5 p-3 rounded-lg bg-slate-950 border border-slate-800 text-xs font-mono text-slate-300 max-h-56 overflow-y-auto whitespace-pre-wrap leading-relaxed select-text">
                          {doc.content}
                        </div>
                      )}
                    </div>
                  );
                })
              )}
            </div>

            {/* Modal Footer */}
            <div className="flex items-center justify-between px-6 py-3.5 border-t border-slate-800 bg-slate-900/90 text-xs">
              <span className="text-slate-400">
                Total stored files: <strong className="text-slate-200">{formatNumber(storedDocs.length)}</strong>
              </span>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    fileInputRef.current?.click();
                  }}
                  disabled={isUploading}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white font-medium shadow transition-all cursor-pointer active:scale-95"
                >
                  <UploadCloud className="w-3.5 h-3.5" />
                  <span>{isUploading ? 'Uploading...' : 'Upload new file'}</span>
                </button>
                <button
                  type="button"
                  onClick={() => setIsDocsModalOpen(false)}
                  className="px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 font-medium transition-colors cursor-pointer"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Drag & drop helper text at bottom */}
      <footer className="absolute bottom-5 text-center text-[11px] text-slate-500 pointer-events-none">
        {isDragging ? (
          <span className="text-emerald-400 font-medium">Drop the file here and the AI will learn from it...</span>
        ) : (
          <span>Drop a PDF or TXT file to add it, or tap the button to talk</span>
        )}
      </footer>

      {isVoicePanelOpen && <VoiceSettingsPanel onClose={() => setIsVoicePanelOpen(false)} />}
    </main>
  );
}
