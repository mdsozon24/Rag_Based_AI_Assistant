import React from 'react';
import { ModelMode } from '../types';
import { Sparkles, Brain, Zap, Radio, BookOpen, Volume2 } from 'lucide-react';

interface HeaderProps {
  mode: ModelMode;
  onModeChange: (mode: ModelMode) => void;
  voiceName: string;
  onVoiceChange: (voice: string) => void;
  enableRag: boolean;
  onToggleRag: () => void;
  onOpenKnowledge: () => void;
  docCount: number;
}

export const Header: React.FC<HeaderProps> = ({
  mode,
  onModeChange,
  voiceName,
  onVoiceChange,
  enableRag,
  onToggleRag,
  onOpenKnowledge,
  docCount,
}) => {
  return (
    <header className="border-b border-emerald-950/20 bg-slate-900/80 backdrop-blur-md sticky top-0 z-30 text-slate-100">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-3.5 flex flex-col md:flex-row items-center justify-between gap-3">
        {/* Brand identity */}
        <div className="flex items-center gap-3 w-full md:w-auto justify-between md:justify-start">
          <div className="flex items-center gap-2.5">
            <div className="w-10 h-10 rounded-xl bg-gradient-to-tr from-emerald-600 via-emerald-500 to-teal-400 flex items-center justify-center shadow-lg shadow-emerald-500/20 ring-1 ring-white/10">
              <span className="text-xl font-bold text-white tracking-tight">বা</span>
            </div>
            <div>
              <div className="flex items-center gap-2">
                <h1 className="font-bold text-lg text-slate-100 tracking-wide font-sans">
                  বাংলা ভয়েস এআই এজেন্ট
                </h1>
                <span className="text-[11px] px-2 py-0.5 rounded-full bg-emerald-500/15 text-emerald-400 border border-emerald-500/30 font-medium">
                  RAG + Live API
                </span>
              </div>
              <p className="text-xs text-slate-400">
                Bangladeshi Bengali Native AI • Gemini 3.1 & 3.5 Powered
              </p>
            </div>
          </div>

          <button
            onClick={onOpenKnowledge}
            className="md:hidden flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 text-xs text-emerald-400 border border-slate-700"
            title="তথ্যভাণ্ডার"
          >
            <BookOpen className="w-3.5 h-3.5" />
            <span>{docCount} টি তথ্য</span>
          </button>
        </div>

        {/* Model Mode Selector Tabs */}
        <div className="flex items-center gap-1.5 p-1 bg-slate-800/90 rounded-xl border border-slate-700/60 overflow-x-auto max-w-full">
          <button
            onClick={() => onModeChange('live')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
              mode === 'live'
                ? 'bg-gradient-to-r from-red-600 to-rose-600 text-white shadow-sm ring-1 ring-white/20'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
            title="Gemini 3.1 Flash Live Preview - দ্বি-মুখী রিয়েল-টাইম অডিও"
          >
            <Radio className={`w-3.5 h-3.5 ${mode === 'live' ? 'animate-pulse text-white' : 'text-rose-400'}`} />
            <span>লাইভ অডিও (Live API)</span>
          </button>

          <button
            onClick={() => onModeChange('high_thinking')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
              mode === 'high_thinking'
                ? 'bg-gradient-to-r from-indigo-600 to-purple-600 text-white shadow-sm ring-1 ring-white/20'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
            title="Gemini 3.1 Pro Preview - উচ্চ যুক্তি ও জটিল বিশ্লেষণ"
          >
            <Brain className="w-3.5 h-3.5 text-indigo-300" />
            <span>উচ্চ চিন্তা (Pro)</span>
          </button>

          <button
            onClick={() => onModeChange('fast')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
              mode === 'fast'
                ? 'bg-gradient-to-r from-emerald-600 to-teal-600 text-white shadow-sm ring-1 ring-white/20'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
            title="Gemini 3.1 Flash Lite - স্বল্প বিলম্বের দ্রুত উত্তর"
          >
            <Zap className="w-3.5 h-3.5 text-amber-400" />
            <span>দ্রুত উত্তর (Lite)</span>
          </button>

          <button
            onClick={() => onModeChange('standard')}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all whitespace-nowrap ${
              mode === 'standard'
                ? 'bg-gradient-to-r from-slate-600 to-slate-700 text-white shadow-sm ring-1 ring-white/20'
                : 'text-slate-300 hover:text-white hover:bg-slate-700/50'
            }`}
            title="Gemini 3.8 Flash - সাধারণ আলাপচারিতা"
          >
            <Sparkles className="w-3.5 h-3.5 text-teal-300" />
            <span>সাধারণ (Flash)</span>
          </button>
        </div>

        {/* Right side controls: Voice & RAG Knowledge */}
        <div className="hidden md:flex items-center gap-2.5">
          {/* Voice selector */}
          <div className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-slate-800 border border-slate-700/70 text-xs">
            <Volume2 className="w-3.5 h-3.5 text-slate-400" />
            <select
              value={voiceName}
              onChange={(e) => onVoiceChange(e.target.value)}
              className="bg-transparent text-slate-200 border-none outline-none cursor-pointer text-xs"
              title="বাংলা কণ্ঠ নির্বাচন (TTS Voice)"
            >
              <option value="Kore" className="bg-slate-800 text-slate-100">কোর (Kore - নারী কণ্ঠ)</option>
              <option value="Zephyr" className="bg-slate-800 text-slate-100">জেফির (Zephyr - পুরুষ কণ্ঠ)</option>
              <option value="Puck" className="bg-slate-800 text-slate-100">পাক (Puck - প্রাণবন্ত)</option>
              <option value="Fenrir" className="bg-slate-800 text-slate-100">ফেনরির (Fenrir - গম্ভীর)</option>
              <option value="Charon" className="bg-slate-800 text-slate-100">ক্যারন (Charon - শান্ত)</option>
            </select>
          </div>

          {/* RAG Toggle */}
          <button
            onClick={onToggleRag}
            className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${
              enableRag
                ? 'bg-emerald-950/40 border-emerald-500/40 text-emerald-300'
                : 'bg-slate-800/80 border-slate-700 text-slate-400'
            }`}
            title={enableRag ? 'RAG সক্রিয়: বাংলাদেশি তথ্যভাণ্ডার থেকে উত্তর দিবে' : 'RAG নিষ্ক্রিয়'}
          >
            <span className={`w-2 h-2 rounded-full ${enableRag ? 'bg-emerald-400 animate-ping' : 'bg-slate-500'}`} />
            <span>RAG {enableRag ? 'অন' : 'অফ'}</span>
          </button>

          {/* Knowledge base modal opener */}
          <button
            onClick={onOpenKnowledge}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-750 text-xs text-slate-200 border border-slate-700 transition-colors shadow-sm"
          >
            <BookOpen className="w-3.5 h-3.5 text-emerald-400" />
            <span>তথ্যভাণ্ডার ({docCount})</span>
          </button>
        </div>
      </div>
    </header>
  );
};
