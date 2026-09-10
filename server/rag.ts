import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { KnowledgeDocument } from '../src/types';
import { INITIAL_BANGLADESH_KNOWLEDGE } from './knowledgeBase';
import { loadUserData, saveUserDocuments } from './userData';

interface EmbeddedDoc extends KnowledgeDocument {
  vector?: number[];
}

const DATA_DIR = path.join(process.cwd(), 'data');
const STORED_DOCS_PATH = path.join(DATA_DIR, 'custom_documents.json');
const USER_DATA_DIR = path.join(DATA_DIR, 'user_data');

export class RagEngine {
  private documents: EmbeddedDoc[] = [];
  private ai: GoogleGenAI | null = null;
  private isEmbeddingReady = false;

  constructor(aiClient?: GoogleGenAI) {
    this.documents = [...INITIAL_BANGLADESH_KNOWLEDGE];
    if (aiClient) {
      this.ai = aiClient;
    }
    // Load previously persisted uploaded files from disk
    this.loadPersistedDocuments();
  }

  private loadPersistedDocuments(): void {
    try {
      if (!fs.existsSync(DATA_DIR)) {
        fs.mkdirSync(DATA_DIR, { recursive: true });
      }
      if (fs.existsSync(STORED_DOCS_PATH)) {
        const raw = fs.readFileSync(STORED_DOCS_PATH, 'utf-8');
        if (!raw.trim()) {
          return;
        }
        const parsed: KnowledgeDocument[] = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const documentsByUser = new Map<string, EmbeddedDoc[]>();
          for (const document of parsed) {
            if (!document.ownerUserId) continue;
            const userDocuments = documentsByUser.get(document.ownerUserId) || [];
            userDocuments.push({ ...document, isCustom: true } as EmbeddedDoc);
            documentsByUser.set(document.ownerUserId, userDocuments);
          }
          for (const [ownerUserId, documents] of documentsByUser) {
            const existingDocuments = loadUserData(ownerUserId).documents;
            const existingIds = new Set(existingDocuments.map((document) => document.id));
            saveUserDocuments(ownerUserId, [
              ...existingDocuments,
              ...documents.filter((document) => !existingIds.has(document.id)),
            ]);
          }
          this.syncLegacyDocumentFile();
          console.log(`[RAG Engine] Migrated ${parsed.length} legacy documents into per-user storage.`);
        }
      }
    } catch (err) {
      console.warn('[RAG Engine] Error loading stored documents:', err);
    }
  }

  private syncLegacyDocumentFile(): void {
    const allCustomDocuments: EmbeddedDoc[] = [];
    if (fs.existsSync(USER_DATA_DIR)) {
      for (const fileName of fs.readdirSync(USER_DATA_DIR)) {
        if (!fileName.endsWith('.json')) continue;
        try {
          const userData = JSON.parse(fs.readFileSync(path.join(USER_DATA_DIR, fileName), 'utf8'));
          if (Array.isArray(userData.documents)) {
            allCustomDocuments.push(...userData.documents.filter((document: EmbeddedDoc) => document.isCustom));
          }
        } catch (error) {
          console.warn(`[RAG Engine] Could not sync ${fileName}:`, error);
        }
      }
    }
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const temporaryPath = `${STORED_DOCS_PATH}.${process.pid}.tmp`;
    fs.writeFileSync(temporaryPath, JSON.stringify(allCustomDocuments, null, 2), 'utf-8');
    fs.renameSync(temporaryPath, STORED_DOCS_PATH);
  }

  private savePersistedDocuments(): void {
    try {
      const documentsByUser = new Map<string, EmbeddedDoc[]>();
      for (const doc of this.documents) {
        if (!doc.isCustom || !doc.ownerUserId) continue;
        const userDocuments = documentsByUser.get(doc.ownerUserId) || [];
        userDocuments.push(doc);
        documentsByUser.set(doc.ownerUserId, userDocuments);
      }
      for (const [ownerUserId, documents] of documentsByUser) {
        saveUserDocuments(ownerUserId, documents);
      }
      this.syncLegacyDocumentFile();
    } catch (err) {
      console.error('[RAG Engine] Failed to save stored documents to disk:', err);
    }
  }

  private loadUserDocuments(ownerUserId: string): void {
    const existingIds = new Set(this.documents.filter((doc) => doc.ownerUserId === ownerUserId).map((doc) => doc.id));
    const storedDocuments = loadUserData(ownerUserId).documents
      .filter((doc) => doc.isCustom && doc.ownerUserId === ownerUserId)
      .map((doc) => ({ ...doc, isCustom: true } as EmbeddedDoc))
      .filter((doc) => !existingIds.has(doc.id));
    this.documents.unshift(...storedDocuments);
  }

  private async ensureUserEmbeddings(ownerUserId: string): Promise<void> {
    const userDocuments = this.documents.filter((doc) => doc.isCustom && doc.ownerUserId === ownerUserId && !doc.vector);
    for (const document of userDocuments) {
      await this.embedSingleDoc(document);
    }
  }

  public setAiClient(aiClient: GoogleGenAI) {
    this.ai = aiClient;
  }

  public getAllDocuments(ownerUserId?: string): KnowledgeDocument[] {
    if (ownerUserId) this.loadUserDocuments(ownerUserId);
    return this.documents
      .filter(d => !d.isCustom || d.ownerUserId === ownerUserId)
      .map(d => ({
      id: d.id,
      title: d.title,
      category: d.category,
      content: d.content,
      summary: d.summary,
      tags: d.tags,
      sourceUrl: d.sourceUrl,
      isCustom: d.isCustom,
      createdAt: d.createdAt
      }));
  }

  public getCustomDocuments(ownerUserId?: string): KnowledgeDocument[] {
    if (ownerUserId) this.loadUserDocuments(ownerUserId);
    return this.documents
      .filter(d => d.isCustom && d.ownerUserId === ownerUserId)
      .map(d => ({
        id: d.id,
        title: d.title,
        category: d.category,
        content: d.content,
        summary: d.summary,
        tags: d.tags,
        sourceUrl: d.sourceUrl,
        isCustom: d.isCustom,
        createdAt: d.createdAt
      }));
  }

  public addDocument(doc: Omit<KnowledgeDocument, 'id' | 'createdAt'>, ownerUserId: string): KnowledgeDocument {
    const newDoc: EmbeddedDoc = {
      ...doc,
      id: `custom-doc-${Date.now()}`,
      createdAt: new Date().toISOString().split('T')[0],
      isCustom: true,
      ownerUserId,
    };
    this.documents.unshift(newDoc);
    // Persist immediately to disk
    this.savePersistedDocuments();

    // Background vector embedding attempt
    if (this.ai) {
      this.embedSingleDoc(newDoc).catch(err => {
        console.warn('Embedding generation warning:', err?.message);
      });
    }
    return newDoc;
  }

  public deleteDocument(id: string, ownerUserId: string): boolean {
    const initialLen = this.documents.length;
    this.documents = this.documents.filter(d => d.id !== id || d.ownerUserId !== ownerUserId);
    const wasDeleted = this.documents.length < initialLen;
    if (wasDeleted) {
      saveUserDocuments(ownerUserId, this.documents.filter((document) => document.isCustom && document.ownerUserId === ownerUserId));
      this.savePersistedDocuments();
    }
    return wasDeleted;
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    let dot = 0;
    let normA = 0;
    let normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i] * b[i];
      normA += a[i] * a[i];
      normB += b[i] * b[i];
    }
    if (normA === 0 || normB === 0) return 0;
    return dot / (Math.sqrt(normA) * Math.sqrt(normB));
  }

  private async embedSingleDoc(doc: EmbeddedDoc): Promise<void> {
    if (!this.ai) return;
    try {
      const textToEmbed = `${doc.title}\n${doc.summary}\n${doc.content}\n${doc.tags.join(' ')}`;
      const result = await this.ai.models.embedContent({
        model: 'gemini-embedding-2-preview',
        contents: [textToEmbed]
      });
      // Extract embedding values
      const values = result.embeddings?.[0]?.values;
      if (values && values.length > 0) {
        doc.vector = values;
        if (doc.ownerUserId) {
          this.savePersistedDocuments();
        }
      }
    } catch (err: any) {
      console.warn('Doc embedding skipped/failed:', err?.message || err);
    }
  }

  public async initializeEmbeddings(): Promise<void> {
    if (!this.ai || this.isEmbeddingReady) return;
    try {
      // Embed documents in batches
      for (const doc of this.documents) {
        if (!doc.vector) {
          await this.embedSingleDoc(doc);
        }
      }
      this.isEmbeddingReady = true;
    } catch (err) {
      console.warn('Embedding batch notice:', err);
    }
  }

  /**
   * Hybrid RAG Retrieval:
   * Combines lexical keyword scoring, Bengali substring matching, tag overlap,
   * and cosine similarity from gemini-embedding-2-preview if vectors are present.
   */
  public async retrieve(query: string, topK: number = 3, category?: string, ownerUserId?: string): Promise<KnowledgeDocument[]> {
    if (ownerUserId) {
      this.loadUserDocuments(ownerUserId);
      await this.ensureUserEmbeddings(ownerUserId);
    }
    const cleanQuery = query.toLowerCase().trim();
    // Normalize Bengali tokens
    const queryTokens = cleanQuery
      .split(/[\s,।?!;:"'()\[\]{}]+/)
      .filter(t => t.length > 1);

    let queryVector: number[] | null = null;
    if (this.ai) {
      try {
        const embedPromise = this.ai.models.embedContent({
          model: 'gemini-embedding-2-preview',
          contents: [query]
        });
        const timeoutPromise = new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 2500));
        const result = await Promise.race([embedPromise, timeoutPromise]) as any;
        const values = result?.embeddings?.[0]?.values;
        if (values && values.length > 0) {
          queryVector = values;
        }
      } catch (err: any) {
        // Fallback to fast lexical search smoothly
      }
    }

    const scoredDocs: { doc: KnowledgeDocument; score: number }[] = [];

    for (const doc of this.documents) {
      if (doc.isCustom && doc.ownerUserId !== ownerUserId) continue;
      if (category && category !== 'all' && doc.category !== category) {
        continue;
      }

      let score = 0;
      const titleLower = doc.title.toLowerCase();
      const contentLower = doc.content.toLowerCase();
      const summaryLower = doc.summary.toLowerCase();

      // 1. Lexical and Semantic Token Matching
      for (const token of queryTokens) {
        if (titleLower.includes(token)) {
          score += 4.5;
        }
        if (summaryLower.includes(token)) {
          score += 3.0;
        }
        if (contentLower.includes(token)) {
          score += 1.5;
        }
        for (const tag of doc.tags) {
          if (tag.toLowerCase().includes(token)) {
            score += 3.5;
          }
        }
      }

      // Exact phrase bonus
      if (titleLower.includes(cleanQuery)) score += 6.0;
      if (summaryLower.includes(cleanQuery)) score += 4.0;
      if (contentLower.includes(cleanQuery)) score += 3.0;

      // 2. Vector Cosine Similarity (if embeddings available)
      if (queryVector && doc.vector) {
        const sim = this.cosineSimilarity(queryVector, doc.vector);
        // Normalize sim (-1 to 1) into score weight
        score += Math.max(0, sim) * 10;
      }

      // Prioritize user-uploaded documents
      if (doc.isCustom) {
        score += 3.5;
      }

      // Normalize score into percentage 0.0 - 1.0 range
      const normalizedScore = Math.min(0.99, Math.max(0.15, score / 15));

      if (score > 0.5) {
        scoredDocs.push({
          doc: {
            ...doc,
            similarityScore: Math.round(normalizedScore * 100) / 100
          },
          score
        });
      }
    }

    // Sort descending by score
    scoredDocs.sort((a, b) => b.score - a.score);

    // If query didn't match any specific doc, fallback to top general docs
    if (scoredDocs.length === 0) {
      return this.documents.slice(0, Math.min(topK, 2)).map(d => ({
        ...d,
        similarityScore: 0.45
      }));
    }

    return scoredDocs.slice(0, topK).map(item => item.doc);
  }
}
