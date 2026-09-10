import React from 'react';
import { Mic, MicOff, Square, Radio, Sparkles } from 'lucide-react';

interface LiveVoiceOrbProps {
  isLiveConnected: boolean;
  isListening: boolean;
  isModelSpeaking: boolean;
  onToggleLive: () => void;
  onInterrupt: () => void;
  volumeLevel: number; // 0 to 100
  statusText: string;
}

export const LiveVoiceOrb: React.FC<LiveVoiceOrbProps> = ({
  isLiveConnected,
  isListening,
  isModelSpeaking,
  onToggleLive,
  onInterrupt,
  volumeLevel,
  statusText,
}) => {
  // Compute dynamic scale based on volume and state
  const baseScale = isModelSpeaking ? 1.15 : isListening ? 1.05 + volumeLevel * 0.003 : 1.0;

  return (
    <div className="flex flex-col items-center justify-center p-6 bg-slate-900/60 rounded-2xl border border-slate-800 backdrop-blur-md shadow-xl relative overflow-hidden">
      {/* Background ambient glow */}
      <div
        className={`absolute inset-0 transition-opacity duration-700 pointer-events-none ${
          isModelSpeaking
            ? 'opacity-40 bg-radial from-emerald-500/30 via-teal-900/10 to-transparent'
            : isListening
            ? 'opacity-30 bg-radial from-rose-500/20 via-emerald-900/10 to-transparent'
            : 'opacity-10 bg-radial from-slate-700/20 to-transparent'
        }`}
      />

      {/* Main Orb Center */}
      <div className="relative my-4 flex items-center justify-center">
        {/* Ripple layers for speaking / listening */}
        {isLiveConnected && (
          <>
            <div
              className={`absolute w-44 h-44 rounded-full transition-all duration-300 pointer-events-none ${
                isModelSpeaking
                  ? 'bg-emerald-500/20 animate-ping'
                  : isListening
                  ? 'bg-rose-500/20 animate-pulse'
                  : 'bg-slate-700/10'
              }`}
              style={{
                transform: `scale(${isModelSpeaking ? 1.3 : 1.1})`,
                animationDuration: isModelSpeaking ? '1.8s' : '2.5s',
              }}
            />
            <div
              className={`absolute w-36 h-36 rounded-full transition-all duration-200 pointer-events-none ${
                isModelSpeaking
                  ? 'bg-teal-400/25 ring-2 ring-emerald-400/50'
                  : isListening
                  ? 'bg-rose-500/25 ring-2 ring-rose-400/40'
                  : 'bg-slate-800/40'
              }`}
            />
          </>
        )}

        {/* Central clickable Interactive Orb Button */}
        <button
          onClick={onToggleLive}
          style={{ transform: `scale(${baseScale})` }}
          className={`relative z-10 w-28 h-28 rounded-full flex flex-col items-center justify-center shadow-2xl transition-transform duration-150 focus:outline-none cursor-pointer group ${
            isLiveConnected
              ? isModelSpeaking
                ? 'bg-gradient-to-tr from-emerald-600 via-teal-500 to-emerald-400 text-white shadow-emerald-500/40 ring-4 ring-emerald-300/40'
                : isListening
                ? 'bg-gradient-to-tr from-rose-600 via-red-500 to-amber-500 text-white shadow-rose-500/40 ring-4 ring-rose-400/40 animate-pulse'
                : 'bg-gradient-to-tr from-emerald-700 to-slate-700 text-white shadow-emerald-900/50'
              : 'bg-gradient-to-tr from-slate-800 to-slate-700 hover:from-slate-700 hover:to-slate-600 text-slate-300 shadow-black/60 ring-1 ring-slate-600'
          }`}
          title={isLiveConnected ? 'লাইভ সেশন বন্ধ করতে ক্লিক করুন' : 'লাইভ রিয়েল-টাইম অডিও সেশন শুরু করুন'}
        >
          {isLiveConnected ? (
            isListening ? (
              <Mic className="w-9 h-9 text-white animate-bounce" />
            ) : isModelSpeaking ? (
              <Sparkles className="w-9 h-9 text-white animate-spin" style={{ animationDuration: '4s' }} />
            ) : (
              <Radio className="w-9 h-9 text-emerald-200 animate-pulse" />
            )
          ) : (
            <MicOff className="w-8 h-8 text-slate-400 group-hover:text-emerald-400 transition-colors" />
          )}

          <span className="text-[11px] font-medium mt-1 tracking-wide">
            {isLiveConnected ? (isModelSpeaking ? 'বলছে...' : isListening ? 'শুনছে...' : 'সক্রিয়') : 'লাইভ শুরু'}
          </span>
        </button>
      </div>

      {/* Real-time Status Badge & Controls */}
      <div className="mt-2 text-center z-10 space-y-2">
        <div className="inline-flex items-center gap-2 px-3.5 py-1 rounded-full bg-slate-800/80 border border-slate-700/80 text-xs text-slate-300 shadow-inner">
          <span
            className={`w-2 h-2 rounded-full ${
              isLiveConnected
                ? isModelSpeaking
                  ? 'bg-teal-400 animate-pulse'
                  : 'bg-emerald-400'
                : 'bg-slate-500'
            }`}
          />
          <span className="font-sans font-medium">{statusText}</span>
        </div>

        {/* Live Audio Interruption Button */}
        {isLiveConnected && isModelSpeaking && (
          <div className="pt-1">
            <button
              onClick={onInterrupt}
              className="inline-flex items-center gap-1.5 px-3 py-1 text-xs rounded-lg bg-rose-600/30 hover:bg-rose-600/50 text-rose-200 border border-rose-500/40 transition-all cursor-pointer shadow-sm active:scale-95"
              title="এআই-এর কথা থামিয়ে আপনার কথা বলুন"
            >
              <Square className="w-3 h-3 fill-rose-300" />
              <span>থামুন (Interrupt)</span>
            </button>
          </div>
        )}
      </div>

      {/* Visual Audio Frequency Equalizer Bars */}
      {isLiveConnected && (
        <div className="flex items-center justify-center gap-1 mt-4 h-6 w-48">
          {[40, 75, 50, 90, 60, 85, 45, 100, 70, 55, 95, 65, 40].map((height, i) => {
            const activeHeight = isModelSpeaking
              ? Math.max(15, (height * (volumeLevel || 60)) / 100)
              : isListening
              ? Math.max(10, (height * Math.max(20, volumeLevel)) / 100)
              : 6;
            return (
              <div
                key={i}
                className={`w-1 rounded-full transition-all duration-100 ${
                  isModelSpeaking
                    ? 'bg-gradient-to-t from-emerald-500 to-teal-300'
                    : isListening
                    ? 'bg-gradient-to-t from-rose-500 to-amber-300'
                    : 'bg-slate-700'
                }`}
                style={{ height: `${activeHeight}%` }}
              />
            );
          })}
        </div>
      )}
    </div>
  );
};
