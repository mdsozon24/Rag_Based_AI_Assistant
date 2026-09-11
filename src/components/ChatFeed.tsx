import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { ChatMessage, KnowledgeDocument } from '../types';
import { Volume2, VolumeX, Sparkles, Brain, Zap, ExternalLink, ChevronDown, ChevronUp, Clock, FileText } from 'lucide-react';

interface ChatFeedProps {
  messages: ChatMessage[];
  onPlayAudio: (messageId: string, base64Audio: string) => void;
  onStopAudio: () => void;
  currentlyPlayingId: string | null;
  onSelectPrompt: (prompt: string) => void;
}

export const ChatFeed: React.FC<ChatFeedProps> = ({
  messages,
  onPlayAudio,
  onStopAudio,
  currentlyPlayingId,
  onSelectPrompt,
}) => {
  const [expandedSources, setExpandedSources] = useState<Record<string, boolean>>({});

  const toggleSource = (msgId: string) => {
    setExpandedSources((prev) => ({ ...prev, [msgId]: !prev[msgId] }));
  };

  const samplePrompts = [
    { text: 'পদ্মা সেতুর প্রযুক্তিগত বৈশিষ্ট্য এবং অর্থনৈতিক প্রভাব কী?', tag: 'অবকাঠামো' },
    { text: 'ই-পাসপোর্ট আবেদনের ধাপ ও ব্যাংক ফি কত?', tag: 'সরকারি সেবা' },
    { text: 'জরুরি পরিস্থিতিতে ৯৯৯ ও ৩৩৩ সেবার পার্থক্য কী?', tag: 'জরুরি সেবা' },
    { text: 'বোরো ধানের জন্য ব্রি উদ্ভাবিত সেরা জাত কোনগুলো?', tag: 'কৃষি' },
    { text: 'নোয়াখালী ও চট্টগ্রামের আঞ্চলিক ভাষার কিছু বৈশিষ্ট্য ব্যাখ্যা করো।', tag: 'উপভাষা' },
    { text: 'বাংলাদেশ সংবিধানের মৌলিক অধিকারের গুরুত্বপূর্ণ অনুচ্ছেদগুলো কী কী?', tag: 'সংবিধান ও আইন' },
  ];

  if (messages.length === 0) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center p-6 text-center text-slate-300">
        <div className="w-16 h-16 rounded-2xl bg-emerald-950/40 border border-emerald-500/30 flex items-center justify-center mb-4 shadow-lg shadow-emerald-900/20">
          <Sparkles className="w-8 h-8 text-emerald-400" />
        </div>
        <h2 className="text-xl font-bold text-slate-100 mb-2">
          স্বাগতম! আমি আপনার বাংলাদেশি বাংলা ভয়েস এআই সহকারী
        </h2>
        <p className="text-sm text-slate-400 max-w-lg mb-6 leading-relaxed">
          যেকোনো প্রশ্ন বাংলায় জিজ্ঞাসা করুন বা মাইক্রোফোনে কথা বলুন।</p>

        {/* Suggested Quick Prompts */}
        <div className="w-full max-w-2xl">
          <div className="text-xs font-semibold text-slate-400 mb-3 text-left">
            জনপ্রিয় কিছু বিষয় (ক্লিক করে সরাসরি শুরু করুন):
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {samplePrompts.map((p, i) => (
              <button
                key={i}
                onClick={() => onSelectPrompt(p.text)}
                className="text-left p-3 rounded-xl bg-slate-800/80 hover:bg-slate-750 border border-slate-700 hover:border-emerald-500/50 text-xs text-slate-200 transition-all flex flex-col justify-between group shadow-sm hover:shadow-emerald-950/30"
              >
                <span className="font-medium text-slate-100 group-hover:text-emerald-300 leading-snug">
                  {p.text}
                </span>
                <span className="mt-2 text-[10px] text-emerald-400/90 font-mono inline-block">
                  #{p.tag}
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-4 sm:p-6 space-y-6">
      {messages.map((msg) => {
        const isUser = msg.sender === 'user';
        const isPlayingThis = currentlyPlayingId === msg.id;

        return (
          <div
            key={msg.id}
            className={`flex flex-col ${isUser ? 'items-end' : 'items-start'} max-w-3xl ${
              isUser ? 'ml-auto' : 'mr-auto'
            } w-full`}
          >
            {/* Sender Label & Meta */}
            <div className="flex items-center gap-2 mb-1.5 px-1 text-xs text-slate-400">
              <span className="font-medium">
                {isUser ? 'আপনি (User)' : 'বাংলা এআই সহকারী'}
              </span>

              {!isUser && msg.modelUsed && (
                <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-[10px] text-emerald-400">
                  {msg.mode === 'high_thinking' ? (
                    <>
                      <Brain className="w-2.5 h-2.5 text-indigo-400" />
                      <span>উচ্চ যুক্তি (Gemini 3.1 Pro)</span>
                    </>
                  ) : msg.mode === 'fast' ? (
                    <>
                      <Zap className="w-2.5 h-2.5 text-amber-400" />
                      <span>দ্রুত উত্তর (Flash Lite)</span>
                    </>
                  ) : (
                    <>
                      <Sparkles className="w-2.5 h-2.5 text-teal-400" />
                      <span>{msg.modelUsed}</span>
                    </>
                  )}
                </span>
              )}

              {msg.latencyMs && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-500 font-mono">
                  <Clock className="w-2.5 h-2.5" />
                  {msg.latencyMs}ms
                </span>
              )}
            </div>

            {/* Message Bubble */}
            <div
              className={`p-4 rounded-2xl text-sm leading-relaxed shadow-md ${
                isUser
                  ? 'bg-gradient-to-br from-emerald-600 to-teal-700 text-white rounded-br-xs'
                  : 'bg-slate-800/95 border border-slate-700/80 text-slate-100 rounded-bl-xs w-full'
              }`}
            >
              {isUser ? (
                <p className="whitespace-pre-wrap font-sans">{msg.text}</p>
              ) : (
                <div className="prose prose-invert prose-sm max-w-none prose-p:leading-relaxed prose-headings:text-emerald-300 prose-strong:text-emerald-200">
                  <ReactMarkdown>{msg.text}</ReactMarkdown>
                </div>
              )}

              {/* Spoken Voice TTS Audio Player Bar for AI responses */}
              {!isUser && msg.audioBase64 && (
                <div className="mt-3 pt-3 border-t border-slate-700/60 flex items-center justify-between gap-3">
                  <button
                    onClick={() =>
                      isPlayingThis
                        ? onStopAudio()
                        : onPlayAudio(msg.id, msg.audioBase64!)
                    }
                    className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      isPlayingThis
                        ? 'bg-rose-500/20 text-rose-300 border border-rose-500/40 animate-pulse'
                        : 'bg-emerald-500/15 hover:bg-emerald-500/25 text-emerald-300 border border-emerald-500/30'
                    }`}
                  >
                    {isPlayingThis ? (
                      <>
                        <VolumeX className="w-3.5 h-3.5" />
                        <span>কণ্ঠ থামান</span>
                      </>
                    ) : (
                      <>
                        <Volume2 className="w-3.5 h-3.5" />
                        <span>কণ্ঠে শুনুন (Gemini)</span>
                      </>
                    )}
                  </button>

                  <span className="text-[11px] text-slate-400">
                    Gemini HD Audio
                  </span>
                </div>
              )}

              {/* RAG Retrieved Sources Section */}
              {!isUser && msg.retrievedSources && msg.retrievedSources.length > 0 && (
                <div className="mt-3 pt-2.5 border-t border-slate-700/50">
                  <button
                    onClick={() => toggleSource(msg.id)}
                    className="flex items-center justify-between w-full text-xs text-emerald-400 hover:text-emerald-300 transition-colors py-1"
                  >
                    <span className="flex items-center gap-1.5 font-medium">
                      <FileText className="w-3.5 h-3.5" />
                      তথ্যভাণ্ডার থেকে সংযুক্ত সূত্রসমূহ ({msg.retrievedSources.length} টি)
                    </span>
                    {expandedSources[msg.id] ? (
                      <ChevronUp className="w-3.5 h-3.5" />
                    ) : (
                      <ChevronDown className="w-3.5 h-3.5" />
                    )}
                  </button>

                  {expandedSources[msg.id] && (
                    <div className="mt-2 space-y-2 text-xs">
                      {msg.retrievedSources.map((source: KnowledgeDocument, idx: number) => (
                        <div
                          key={source.id || idx}
                          className="p-2.5 rounded-lg bg-slate-900/70 border border-slate-750 text-slate-300"
                        >
                          <div className="flex items-center justify-between gap-2 mb-1">
                            <span className="font-semibold text-slate-200">
                              {idx + 1}. {source.title}
                            </span>
                            {source.similarityScore && (
                              <span className="text-[10px] px-1.5 py-0.5 rounded bg-emerald-950 text-emerald-400 border border-emerald-800">
                                মিল: {Math.round(source.similarityScore * 100)}%
                              </span>
                            )}
                          </div>
                          <p className="text-slate-400 text-[11px] leading-normal line-clamp-2">
                            {source.summary || source.content.slice(0, 120) + '...'}
                          </p>
                          {source.sourceUrl && (
                            <a
                              href={source.sourceUrl}
                              target="_blank"
                              rel="noreferrer"
                              className="inline-flex items-center gap-1 text-[11px] text-teal-400 hover:underline mt-1.5"
                            >
                              <span>মূল তথ্যসূত্র</span>
                              <ExternalLink className="w-2.5 h-2.5" />
                            </a>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
};
