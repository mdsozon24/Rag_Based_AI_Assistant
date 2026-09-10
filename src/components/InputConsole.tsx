import React, { useState, useRef } from 'react';
import { Send, Mic, Square, Loader2, Sparkles, AlertCircle } from 'lucide-react';
import { ModelMode } from '../types';

interface InputConsoleProps {
  onSendMessage: (text: string) => void;
  isLoading: boolean;
  mode: ModelMode;
  onTranscribeAudio: (base64Audio: string, mimeType: string) => Promise<string>;
}

export const InputConsole: React.FC<InputConsoleProps> = ({
  onSendMessage,
  isLoading,
  mode,
  onTranscribeAudio,
}) => {
  const [inputText, setInputText] = useState('');
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [transcriptionError, setTranscriptionError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);

  const handleSend = () => {
    if (!inputText.trim() || isLoading) return;
    onSendMessage(inputText.trim());
    setInputText('');
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  // Start recording microphone audio for gemini-3.5-transcribe
  const startRecording = async () => {
    setTranscriptionError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported('audio/webm') ? 'audio/webm' : 'audio/mp4';
      const recorder = new MediaRecorder(stream, { mimeType });
      audioChunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          audioChunksRef.current.push(e.data);
        }
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const audioBlob = new Blob(audioChunksRef.current, { type: mimeType });

        // Convert blob to base64
        setIsTranscribing(true);
        try {
          const reader = new FileReader();
          reader.readAsDataURL(audioBlob);
          reader.onloadend = async () => {
            const base64Data = (reader.result as string).split(',')[1];
            if (base64Data) {
              const transcribedText = await onTranscribeAudio(base64Data, mimeType);
              if (transcribedText) {
                setInputText((prev) => (prev ? `${prev} ${transcribedText}` : transcribedText));
              }
            }
            setIsTranscribing(false);
          };
        } catch (err: any) {
          setTranscriptionError('প্রতিলিপিকরণ ব্যর্থ হয়েছে। অনুগ্রহ করে পুনরায় চেষ্টা করুন।');
          setIsTranscribing(false);
        }
      };

      recorder.start();
      mediaRecorderRef.current = recorder;
      setIsRecording(true);
    } catch (err: any) {
      console.error('Microphone access denied:', err);
      setTranscriptionError('মাইক্রোফোন ব্যবহারের অনুমতি পাওয়া যায়নি।');
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && isRecording) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
    }
  };

  return (
    <div className="p-4 bg-slate-900/90 border-t border-slate-800 backdrop-blur-md">
      <div className="max-w-4xl mx-auto space-y-2">
        {transcriptionError && (
          <div className="flex items-center gap-2 p-2 px-3 rounded-lg bg-rose-950/40 border border-rose-500/40 text-rose-300 text-xs">
            <AlertCircle className="w-4 h-4 shrink-0" />
            <span>{transcriptionError}</span>
          </div>
        )}

        <div className="relative flex items-end gap-2 bg-slate-800/90 rounded-2xl border border-slate-700 p-2 shadow-inner focus-within:border-emerald-500/60 focus-within:ring-1 focus-within:ring-emerald-500/30 transition-all">
          {/* Audio Input Recording Button for Gemini 3.5 Transcribe */}
          <button
            type="button"
            onClick={isRecording ? stopRecording : startRecording}
            disabled={isLoading || isTranscribing}
            className={`p-2.5 rounded-xl transition-all cursor-pointer flex items-center justify-center shrink-0 ${
              isRecording
                ? 'bg-rose-600 text-white animate-pulse shadow-md shadow-rose-600/30 ring-2 ring-rose-400'
                : isTranscribing
                ? 'bg-slate-700 text-slate-400'
                : 'bg-slate-700/70 hover:bg-slate-700 text-emerald-400 hover:text-emerald-300'
            }`}
            title={
              isRecording
                ? 'রেকর্ডিং শেষ করতে ক্লিক করুন (Gemini 3.5 Transcribe)'
                : 'মাইক্রোফোনে বাংলায় বলুন (Gemini 3.5 Transcribe)'
            }
          >
            {isRecording ? (
              <Square className="w-5 h-5 fill-white" />
            ) : isTranscribing ? (
              <Loader2 className="w-5 h-5 animate-spin text-emerald-400" />
            ) : (
              <Mic className="w-5 h-5" />
            )}
          </button>

          {/* Bengali Textarea */}
          <div className="flex-1 relative flex flex-col justify-center">
            {isRecording && (
              <div className="absolute inset-0 flex items-center px-3 bg-slate-800/95 text-rose-300 text-xs font-medium animate-pulse rounded-lg z-10">
                <span className="w-2 h-2 rounded-full bg-rose-500 mr-2 animate-ping" />
                বাংলায় কথা বলুন... শেষ হলে লাল বোতামে চাপ দিন (Gemini 3.5 দিয়ে প্রতিলিপিকরণ হবে)
              </div>
            )}
            {isTranscribing && (
              <div className="absolute inset-0 flex items-center px-3 bg-slate-800/95 text-emerald-300 text-xs font-medium rounded-lg z-10">
                <Loader2 className="w-3.5 h-3.5 animate-spin mr-2" />
                Gemini 3.5 দিয়ে বাংলায় নিখুঁত প্রতিলিপিকরণ হচ্ছে...
              </div>
            )}
            <textarea
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
              onKeyDown={handleKeyDown}
              disabled={isLoading || isRecording || isTranscribing}
              placeholder="বাংলায় যেকোনো প্রশ্ন বা বার্তা লিখুন (যেমন: পদ্মা সেতুর দৈর্ঘ্য কত? বা ই-পাসপোর্ট নবায়ন)..."
              rows={1}
              className="w-full bg-transparent text-slate-100 placeholder-slate-400 text-sm focus:outline-none resize-none max-h-32 py-1 px-1 font-sans"
              style={{ minHeight: '38px' }}
            />
          </div>

          {/* Send Button */}
          <button
            type="button"
            onClick={handleSend}
            disabled={!inputText.trim() || isLoading}
            className={`p-2.5 rounded-xl font-medium transition-all shrink-0 flex items-center justify-center ${
              !inputText.trim() || isLoading
                ? 'bg-slate-700/50 text-slate-500 cursor-not-allowed'
                : 'bg-gradient-to-r from-emerald-600 to-teal-600 hover:from-emerald-500 hover:to-teal-500 text-white shadow-md shadow-emerald-600/30 cursor-pointer active:scale-95'
            }`}
            title="বার্তা পাঠান"
          >
            {isLoading ? (
              <Loader2 className="w-5 h-5 animate-spin text-white" />
            ) : (
              <Send className="w-5 h-5" />
            )}
          </button>
        </div>

        {/* Console footnote showing current model and mode */}
        <div className="flex items-center justify-between text-[11px] text-slate-400 px-1">
          <div className="flex items-center gap-1.5">
            <span className="text-emerald-400/90 font-medium">সক্রিয় মোড:</span>
            <span>
              {mode === 'live'
                ? 'রিয়েল-টাইম লাইভ অডিও (gemini-3.1-flash-live-preview)'
                : mode === 'high_thinking'
                ? 'উচ্চ চিন্তা যুক্তি (gemini-3.1-pro-preview • ThinkingLevel.HIGH)'
                : mode === 'fast'
                ? 'স্বল্প বিলম্বের দ্রুত উত্তর (gemini-3.1-flash-lite)'
                : 'প্রমিত কথোপকথন (gemini-3.8-flash)'}
            </span>
          </div>
          <span className="hidden sm:inline text-slate-500">
            Enter চাপলে বার্তা যাবে, Shift+Enter নতুন লাইন
          </span>
        </div>
      </div>
    </div>
  );
};
