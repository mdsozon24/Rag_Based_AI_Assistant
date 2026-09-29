import React, { useEffect, useRef, useState } from 'react';
import { CheckCircle2, Loader2, Play, RefreshCw, Square, Volume2, X } from 'lucide-react';

interface VoiceOption {
  voiceId: string;
  name: string;
  gender?: string;
}

interface VoiceSettingsPanelProps {
  onClose: () => void;
}

const GENDER_LABELS: Record<string, string> = { female: 'female', male: 'male', neutral: 'neutral' };

function voiceLabel(voice: VoiceOption): string {
  const gender = voice.gender && GENDER_LABELS[voice.gender];
  return gender ? `${voice.name} (${gender})` : voice.name;
}

/** Parse a JSON API response, turning an HTML page (e.g. an outdated server) into a readable error. */
async function readJson(res: Response): Promise<any> {
  try {
    return await res.json();
  } catch {
    throw new Error('Could not load the voice settings. Restart the server and try again.');
  }
}

/** Admin panel for choosing the voice used for every answer. */
export const VoiceSettingsPanel: React.FC<VoiceSettingsPanelProps> = ({ onClose }) => {
  const [voices, setVoices] = useState<VoiceOption[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [activeVoiceId, setActiveVoiceId] = useState<string | null>(null);
  const [selectedVoiceId, setSelectedVoiceId] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [isPreviewing, setIsPreviewing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedMessage, setSavedMessage] = useState<string | null>(null);
  const previewAudioRef = useRef<HTMLAudioElement | null>(null);
  const previewRequestRef = useRef(0);

  const loadVoices = async (refresh = false) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/voice${refresh ? '?refresh=1' : ''}`);
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Could not load the voice list.');
      setEnabled(data.enabled);
      setVoices(data.voices || []);
      setActiveVoiceId(data.voiceId);
      setSelectedVoiceId((current) => current || data.voiceId || data.voices?.[0]?.voiceId || '');
    } catch (err: any) {
      setError(err?.message || 'Could not load the voice list.');
    } finally {
      setIsLoading(false);
    }
  };

  const stopPreview = () => {
    previewRequestRef.current++;
    previewAudioRef.current?.pause();
    previewAudioRef.current = null;
    setIsPreviewing(false);
  };

  useEffect(() => {
    loadVoices();
    return stopPreview;
  }, []);

  const handlePreview = async () => {
    if (isPreviewing) {
      stopPreview();
      return;
    }
    const requestId = previewRequestRef.current;
    setIsPreviewing(true);
    setError(null);
    try {
      const res = await fetch('/api/admin/voice/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoiceId }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Cannot play this voice right now.');
      // The preview was stopped or another voice was chosen while this one was loading
      if (requestId !== previewRequestRef.current) return;
      const audio = new Audio(`data:${data.mimeType};base64,${data.audioBase64}`);
      previewAudioRef.current = audio;
      audio.onended = stopPreview;
      await audio.play();
    } catch (err: any) {
      if (requestId !== previewRequestRef.current) return;
      setError(err?.message || 'Cannot play this voice right now.');
      setIsPreviewing(false);
    }
  };

  const handleSave = async () => {
    setIsSaving(true);
    setError(null);
    setSavedMessage(null);
    try {
      const res = await fetch('/api/admin/voice', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ voiceId: selectedVoiceId }),
      });
      const data = await readJson(res);
      if (!res.ok) throw new Error(data.error || 'Could not save the voice.');
      setActiveVoiceId(data.voiceId);
      setSavedMessage('Voice saved. It will be used for every user\'s next answer.');
    } catch (err: any) {
      setError(err?.message || 'Could not save the voice.');
    } finally {
      setIsSaving(false);
    }
  };

  const activeVoice = voices.find((voice) => voice.voiceId === activeVoiceId);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm" onClick={onClose}>
      <div
        className="w-full max-w-lg rounded-2xl border border-slate-700 bg-slate-900 p-6 text-slate-100 shadow-2xl select-text"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-5 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Volume2 className="h-5 w-5 text-emerald-400" />
            <h2 className="text-lg font-semibold">Choose the AI voice</h2>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 text-slate-400 hover:bg-slate-800 hover:text-white" aria-label="Close">
            <X className="h-5 w-5" />
          </button>
        </div>

        {isLoading ? (
          <div className="flex items-center gap-2 py-8 text-sm text-slate-400">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading voices...
          </div>
        ) : !enabled ? (
          <p className="py-4 text-sm text-slate-400">The voice service is off. Set the voice API key on the server.</p>
        ) : (
          <>
            {activeVoice && (
              <p className="mb-3 text-xs text-slate-400">
                Current voice: <span className="text-emerald-300">{voiceLabel(activeVoice)}</span>
              </p>
            )}

            <label htmlFor="voice-select" className="mb-1.5 block text-xs font-medium text-slate-300">
              Your voices
            </label>
            <div className="flex gap-2">
              <select
                id="voice-select"
                value={selectedVoiceId}
                onChange={(e) => {
                  stopPreview();
                  setSavedMessage(null);
                  setSelectedVoiceId(e.target.value);
                }}
                disabled={voices.length === 0}
                className="min-w-0 flex-1 rounded-lg border border-slate-700 bg-slate-800 px-3 py-2 text-sm text-slate-100 outline-none focus:border-emerald-500 disabled:opacity-60"
              >
                {voices.length === 0 && <option value="">No voices found</option>}
                {voices.map((voice) => (
                  <option key={voice.voiceId} value={voice.voiceId}>{voiceLabel(voice)}</option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => loadVoices(true)}
                className="rounded-lg border border-slate-700 bg-slate-800 px-2.5 text-slate-300 hover:border-emerald-500/50 hover:text-emerald-300"
                title="Refresh list"
                aria-label="Refresh list"
              >
                <RefreshCw className="h-4 w-4" />
              </button>
            </div>

            <div className="mt-5 flex items-center gap-2">
              <button
                type="button"
                onClick={handlePreview}
                disabled={!selectedVoiceId}
                className="inline-flex items-center gap-1.5 rounded-lg border border-slate-700 bg-slate-800 px-3.5 py-2 text-sm text-slate-200 hover:border-emerald-500/50 disabled:opacity-50"
              >
                {isPreviewing ? <Square className="h-4 w-4" /> : <Play className="h-4 w-4" />}
                {isPreviewing ? 'Stop' : 'Preview'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving || !selectedVoiceId || selectedVoiceId === activeVoiceId}
                className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-4 py-2 text-sm font-medium text-white hover:bg-emerald-500 disabled:opacity-50"
              >
                {isSaving && <Loader2 className="h-4 w-4 animate-spin" />}
                Save
              </button>
            </div>
          </>
        )}

        {savedMessage && (
          <p className="mt-4 flex items-start gap-1.5 text-xs text-emerald-300">
            <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> {savedMessage}
          </p>
        )}
        {error && <p className="mt-4 text-xs text-rose-400">{error}</p>}
      </div>
    </div>
  );
};
