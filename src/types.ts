export interface KnowledgeDocument {
  id: string;
  title: string;
  category: 'government' | 'emergency' | 'culture' | 'agriculture' | 'law' | 'education' | 'dialect' | 'custom';
  content: string;
  summary: string;
  tags: string[];
  sourceUrl?: string;
  isCustom?: boolean;
  createdAt: string;
  similarityScore?: number;
  ownerUserId?: string;
}

export type ModelMode = 'live' | 'high_thinking' | 'fast' | 'standard';

export interface QueryRequest {
  message: string;
  mode: ModelMode;
  voiceName: string;
  enableRag: boolean;
  categoryFilter?: string;
}

export interface QueryResponse {
  text: string;
  thinkingProcess?: string;
  retrievedSources: KnowledgeDocument[];
  audioBase64?: string;
  audioMimeType?: string;
  latencyMs: number;
  modelUsed: string;
}

export interface ChatMessage {
  id: string;
  sender: 'user' | 'agent';
  text: string;
  timestamp: string;
  mode?: ModelMode;
  audioBase64?: string;
  retrievedSources?: KnowledgeDocument[];
  thinkingProcess?: string;
  latencyMs?: number;
  modelUsed?: string;
}

export interface LiveTranscriptItem {
  speaker: 'user' | 'agent';
  text: string;
  timestamp: string;
}

export interface AudioVisualizerData {
  volume: number;
  frequencies: number[];
}
