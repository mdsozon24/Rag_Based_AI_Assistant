import React, { useState } from 'react';
import { KnowledgeDocument } from '../types';
import { X, Search, Plus, Trash2, BookOpen, ExternalLink, Tag, Check, AlertCircle } from 'lucide-react';

interface KnowledgeBaseModalProps {
  isOpen: boolean;
  onClose: () => void;
  documents: KnowledgeDocument[];
  onAddDocument: (doc: Omit<KnowledgeDocument, 'id' | 'createdAt'>) => Promise<boolean>;
  onDeleteDocument: (id: string) => Promise<boolean>;
}

export const KnowledgeBaseModal: React.FC<KnowledgeBaseModalProps> = ({
  isOpen,
  onClose,
  documents,
  onAddDocument,
  onDeleteDocument,
}) => {
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedCategory, setSelectedCategory] = useState<string>('all');
  const [isAdding, setIsAdding] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);

  // New doc form state
  const [newTitle, setNewTitle] = useState('');
  const [newCategory, setNewCategory] = useState<KnowledgeDocument['category']>('custom');
  const [newContent, setNewContent] = useState('');
  const [newSummary, setNewSummary] = useState('');
  const [newTags, setNewTags] = useState('');
  const [newSourceUrl, setNewSourceUrl] = useState('');
  const [feedbackMsg, setFeedbackMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  if (!isOpen) return null;

  const categories = [
    { key: 'all', label: 'সকল বিষয়' },
    { key: 'government', label: 'সরকারি ও ডিজিটাল সেবা' },
    { key: 'emergency', label: 'জরুরি কল সেন্টার' },
    { key: 'law', label: 'সংবিধান ও আইন' },
    { key: 'agriculture', label: 'কৃষি ও খাদ্য' },
    { key: 'culture', label: 'মুক্তিযুদ্ধ ও সংস্কৃতি' },
    { key: 'dialect', label: 'আঞ্চলিক উপভাষা' },
    { key: 'education', label: 'বিসিএস ও শিক্ষা' },
    { key: 'custom', label: 'ব্যবহারকারীর নিজস্ব নথি' },
  ];

  const filteredDocs = documents.filter((doc) => {
    const matchesCat = selectedCategory === 'all' || doc.category === selectedCategory;
    const matchesSearch =
      doc.title.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.content.toLowerCase().includes(searchQuery.toLowerCase()) ||
      doc.tags.some((t) => t.toLowerCase().includes(searchQuery.toLowerCase()));
    return matchesCat && matchesSearch;
  });

  const handleCreateDoc = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim() || !newContent.trim()) {
      setFeedbackMsg({ type: 'error', text: 'শিরোনাম এবং বিস্তারিত তথ্য আবশ্যক।' });
      return;
    }

    setIsSubmitting(true);
    setFeedbackMsg(null);

    const tagsArray = newTags
      .split(',')
      .map((t) => t.trim())
      .filter((t) => t.length > 0);

    const success = await onAddDocument({
      title: newTitle.trim(),
      category: newCategory,
      content: newContent.trim(),
      summary: newSummary.trim() || newContent.trim().slice(0, 150) + '...',
      tags: tagsArray.length > 0 ? tagsArray : ['custom', newCategory],
      sourceUrl: newSourceUrl.trim() || undefined,
      isCustom: true,
    });

    setIsSubmitting(false);
    if (success) {
      setFeedbackMsg({ type: 'success', text: 'নতুন তথ্যভাণ্ডার নথি সফলভাবে যুক্ত ও এম্বেড করা হয়েছে!' });
      setNewTitle('');
      setNewContent('');
      setNewSummary('');
      setNewTags('');
      setNewSourceUrl('');
      setIsAdding(false);
      setTimeout(() => setFeedbackMsg(null), 3000);
    } else {
      setFeedbackMsg({ type: 'error', text: 'নথি সংরক্ষণে সমস্যা হয়েছে।' });
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/70 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="bg-slate-900 border border-slate-750 rounded-2xl w-full max-w-4xl max-h-[90vh] flex flex-col shadow-2xl overflow-hidden text-slate-100">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-slate-800 flex items-center justify-between bg-slate-950/60">
          <div className="flex items-center gap-2.5">
            <div className="p-2 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-emerald-400">
              <BookOpen className="w-5 h-5" />
            </div>
            <div>
              <h3 className="font-bold text-base text-slate-100">
                বাংলাদেশি জ্ঞানভাণ্ডার (RAG Knowledge Base)
              </h3>
              <p className="text-xs text-slate-400">
                মোট {documents.length} টি নথি সংরক্ষিত আছে • Gemini Embedding ২ দিয়ে সমৃদ্ধ
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setIsAdding(!isAdding)}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium transition-colors shadow-sm cursor-pointer"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>{isAdding ? 'নথি তালিকা দেখুন' : 'নতুন তথ্য যুক্ত করুন'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-1.5 rounded-lg text-slate-400 hover:text-white hover:bg-slate-800 transition-colors"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {/* Feedback alert */}
        {feedbackMsg && (
          <div
            className={`p-3 text-xs flex items-center gap-2 border-b ${
              feedbackMsg.type === 'success'
                ? 'bg-emerald-950/60 text-emerald-300 border-emerald-800'
                : 'bg-rose-950/60 text-rose-300 border-rose-800'
            }`}
          >
            {feedbackMsg.type === 'success' ? (
              <Check className="w-4 h-4 shrink-0 text-emerald-400" />
            ) : (
              <AlertCircle className="w-4 h-4 shrink-0 text-rose-400" />
            )}
            <span>{feedbackMsg.text}</span>
          </div>
        )}

        {/* Modal Body */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6">
          {isAdding ? (
            /* Add Document Form */
            <form onSubmit={handleCreateDoc} className="space-y-4 max-w-2xl mx-auto">
              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  নথির শিরোনাম (Document Title)*
                </label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="যেমন: চট্টগ্রাম বন্দর ও মাতারবাড়ি গভীর সমুদ্রবন্দর টার্মিনাল..."
                  className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    বিষয়শ্রেণী (Category)*
                  </label>
                  <select
                    value={newCategory}
                    onChange={(e) => setNewCategory(e.target.value as any)}
                    className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                  >
                    <option value="government">সরকারি ও ডিজিটাল সেবা</option>
                    <option value="emergency">জরুরি কল সেন্টার</option>
                    <option value="law">সংবিধান ও আইন</option>
                    <option value="agriculture">কৃষি ও খাদ্য</option>
                    <option value="culture">মুক্তিযুদ্ধ ও সংস্কৃতি</option>
                    <option value="dialect">আঞ্চলিক উপভাষা</option>
                    <option value="education">বিসিএস ও শিক্ষা</option>
                    <option value="custom">অন্যান্য নিজস্ব তথ্য</option>
                  </select>
                </div>

                <div>
                  <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                    উৎস লিংক (ঐচ্ছিক)
                  </label>
                  <input
                    type="url"
                    value={newSourceUrl}
                    onChange={(e) => setNewSourceUrl(e.target.value)}
                    placeholder="https://..."
                    className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  সংক্ষিপ্ত সারসংক্ষেপ (Summary)
                </label>
                <input
                  type="text"
                  value={newSummary}
                  onChange={(e) => setNewSummary(e.target.value)}
                  placeholder="এক-দুই লাইনে মূল তথ্য..."
                  className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  বিস্তারিত বিষয়বস্তু ও ব্যাখ্যা (Content)*
                </label>
                <textarea
                  required
                  rows={5}
                  value={newContent}
                  onChange={(e) => setNewContent(e.target.value)}
                  placeholder="এখানে সম্পূর্ণ তথ্য, ধারা, নিয়মাবলী বা ঐতিহাসিক বিবরণ লিখুন..."
                  className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-300 mb-1.5">
                  ট্যাগসমূহ (কমা দিয়ে আলাদা করুন)
                </label>
                <input
                  type="text"
                  value={newTags}
                  onChange={(e) => setNewTags(e.target.value)}
                  placeholder="যেমন: বন্দর, অর্থনীতি, অবকাঠামো"
                  className="w-full p-2.5 rounded-xl bg-slate-800 border border-slate-700 text-slate-100 text-sm focus:border-emerald-500 focus:outline-none"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2.5">
                <button
                  type="button"
                  onClick={() => setIsAdding(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 hover:bg-slate-700 text-xs text-slate-300 transition-colors"
                >
                  বাতিল
                </button>
                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="px-5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-500 text-white text-xs font-medium shadow-md shadow-emerald-600/30 transition-all cursor-pointer"
                >
                  {isSubmitting ? 'সংরক্ষণ হচ্ছে...' : 'তথ্যভাণ্ডারে যুক্ত করুন'}
                </button>
              </div>
            </form>
          ) : (
            /* Document List & Filtering */
            <div className="space-y-4">
              {/* Search and Category Badges */}
              <div className="flex flex-col sm:flex-row gap-2.5 items-stretch sm:items-center justify-between">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2 text-slate-400" />
                  <input
                    type="text"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    placeholder="নথির শিরোনাম, বিষয় বা ট্যাগ দিয়ে খুঁজুন..."
                    className="w-full pl-9 pr-3 py-2 rounded-xl bg-slate-800/80 border border-slate-700 text-xs text-slate-100 focus:border-emerald-500 focus:outline-none"
                  />
                </div>
              </div>

              {/* Categories Pills */}
              <div className="flex items-center gap-1.5 overflow-x-auto pb-1 max-w-full text-xs">
                {categories.map((cat) => (
                  <button
                    key={cat.key}
                    onClick={() => setSelectedCategory(cat.key)}
                    className={`px-3 py-1 rounded-lg whitespace-nowrap transition-colors ${
                      selectedCategory === cat.key
                        ? 'bg-emerald-600 text-white font-medium shadow-sm'
                        : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                    }`}
                  >
                    {cat.label}
                  </button>
                ))}
              </div>

              {/* Documents Grid */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3 pt-2">
                {filteredDocs.map((doc) => (
                  <div
                    key={doc.id}
                    className="p-4 rounded-xl bg-slate-850 border border-slate-750 hover:border-slate-650 transition-all flex flex-col justify-between group shadow-sm"
                  >
                    <div>
                      <div className="flex items-start justify-between gap-2 mb-1.5">
                        <span className="text-[10px] uppercase font-mono px-2 py-0.5 rounded-full bg-slate-800 border border-slate-700 text-emerald-400">
                          {doc.category}
                        </span>
                        {doc.isCustom && (
                          <button
                            onClick={() => onDeleteDocument(doc.id)}
                            className="text-slate-500 hover:text-rose-400 p-1 rounded transition-colors"
                            title="মুছে ফেলুন"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      <h4 className="font-semibold text-sm text-slate-100 group-hover:text-emerald-300 transition-colors mb-2 leading-snug">
                        {doc.title}
                      </h4>

                      <p className="text-xs text-slate-300 line-clamp-3 mb-3 leading-relaxed whitespace-pre-line font-sans">
                        {doc.content}
                      </p>
                    </div>

                    <div className="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px] text-slate-400">
                      <div className="flex items-center gap-1 flex-wrap">
                        {doc.tags.slice(0, 3).map((tag, i) => (
                          <span
                            key={i}
                            className="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded bg-slate-800 text-slate-400 text-[10px]"
                          >
                            <Tag className="w-2.5 h-2.5 text-emerald-500" />
                            {tag}
                          </span>
                        ))}
                      </div>

                      {doc.sourceUrl && (
                        <a
                          href={doc.sourceUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-teal-400 hover:underline shrink-0"
                        >
                          <span>উৎস</span>
                          <ExternalLink className="w-2.5 h-2.5" />
                        </a>
                      )}
                    </div>
                  </div>
                ))}
              </div>

              {filteredDocs.length === 0 && (
                <div className="text-center py-12 text-slate-400 text-xs">
                  কোনো নথি পাওয়া যায়নি। অন্য শব্দ দিয়ে খুঁজুন অথবা নতুন তথ্য যুক্ত করুন।
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
