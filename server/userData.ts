import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { GoogleGenAI } from '@google/genai';
import { KnowledgeDocument } from '../src/types';

export interface UserMemoryRecord {
  id: string;
  userId: string;
  source: 'voice';
  createdAt: string;
  originalText: string;
  summary: string;
  facts: string[];
  embedding: number[];
}

interface StoredUserData {
  userId: string;
  documents: Array<KnowledgeDocument & { vector?: number[]; ownerUserId?: string }>;
  memories: UserMemoryRecord[];
}

const USER_DATA_DIR = path.join(process.cwd(), 'data', 'user_data');

function userDataPath(userId: string) {
  if (!/^[a-zA-Z0-9-]+$/.test(userId)) throw new Error('Invalid user id.');
  return path.join(USER_DATA_DIR, `${userId}.json`);
}

function emptyUserData(userId: string): StoredUserData {
  return { userId, documents: [], memories: [] };
}

export function loadUserData(userId: string): StoredUserData {
  const filePath = userDataPath(userId);
  try {
    if (!fs.existsSync(filePath)) return emptyUserData(userId);
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as Partial<StoredUserData>;
    return {
      userId,
      documents: Array.isArray(parsed.documents) ? parsed.documents : [],
      memories: Array.isArray(parsed.memories) ? parsed.memories : [],
    };
  } catch (error) {
    console.warn(`[User data] Could not load ${userId}:`, error);
    return emptyUserData(userId);
  }
}

function saveUserData(data: StoredUserData) {
  fs.mkdirSync(USER_DATA_DIR, { recursive: true });
  const filePath = userDataPath(data.userId);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(temporaryPath, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(temporaryPath, filePath);
}

export function saveUserDocuments(userId: string, documents: StoredUserData['documents']) {
  const data = loadUserData(userId);
  data.documents = documents;
  saveUserData(data);
}

export function getUserMemories(userId: string) {
  return loadUserData(userId).memories;
}

interface VoiceMemoryDraft {
  important: boolean;
  summary: string;
  facts: string[];
}

const SENSITIVE_PERSONAL_DATA_PATTERNS = [
  'name', 'full name', 'maiden name', 'alias', 'nickname', 'username', 'handle', 'screen name',
  'date of birth', 'dob', 'birth place', 'age', 'gender', 'pronoun', 'nationality', 'citizenship',
  'passport', 'national id', 'driver license', 'ssn', 'tax id', 'voter id', 'employee id', 'student id',
  'email', 'phone', 'mobile', 'fax', 'address', 'home address', 'billing address', 'shipping address',
  'emergency contact', 'family contact', 'social media', 'messaging id', 'ip address', 'device id',
  'mac address', 'imei', 'sim number', 'serial number', 'api key', 'password', 'pin', 'otp', 'recovery code',
  'bank account', 'routing number', 'credit card', 'cvv', 'expiration date', 'bank statement', 'income',
  'salary', 'transaction', 'loan', 'mortgage', 'investment', 'crypto wallet', 'medical record', 'diagnosis',
  'medication', 'prescription', 'allergy', 'insurance', 'lab result', 'mental health', 'disability',
  'fingerprint', 'face scan', 'voiceprint', 'iris', 'retina', 'dna', 'genetic', 'gps', 'location',
  'work address', 'school address', 'travel history', 'vehicle registration', 'license plate', 'vin',
  'employer', 'job title', 'salary', 'resume', 'education', 'school', 'student id', 'grades', 'transcript',
  'married', 'spouse', 'partner', 'children', 'dependents', 'parents', 'siblings', 'family', 'criminal record',
  'court', 'lawsuit', 'bankruptcy', 'driving record', 'tax filing', 'government benefit', 'political', 'religion',
  'ethnicity', 'race', 'hobby', 'interests', 'relationships', 'dating', 'calendar', 'call log', 'chat log',
  'photos', 'videos', 'audio', 'documents', 'smart home', 'camera', 'wearable', 'fitness tracker', 'heart rate',
  'sleep', 'steps', 'calories', 'menstrual cycle', 'health risk', 'personality', 'behavioral', 'profile', 'wallet address'
];

function containsSensitivePersonalData(transcript: string): boolean {
  const normalized = transcript.toLowerCase();
  return SENSITIVE_PERSONAL_DATA_PATTERNS.some((pattern) => normalized.includes(pattern));
}

async function summarizeVoiceMemory(ai: GoogleGenAI, transcript: string): Promise<VoiceMemoryDraft> {
  const sensitive = containsSensitivePersonalData(transcript);
  if (!sensitive) {
    return { important: false, summary: '', facts: [] };
  }

  const result = await ai.models.generateContent({
    model: 'gemini-3.1-flash-lite',
    contents: `Analyze this user's spoken message as a privacy-sensitive personal data extraction task.
Only treat it as important if it contains one or more of these categories of personal, sensitive, or identifying information:
- Identity identifiers
- Contact information
- Online and technical identifiers
- Financial information
- Health and medical information
- Biometric and genetic information
- Location information
- Employment and professional information
- Education information
- Family and relationship information
- Legal and government information
- Demographic and lifestyle information
- Communications and content
- Device, home, and IoT data
- Inferences and derived data
- Children’s information
- Public and third-party data

Do NOT mark greetings, general chit-chat, casual questions, news, generic facts, or unrelated conversation as important.
Return JSON only with this exact shape: {"important": boolean, "summary": string, "facts": string[]}. The summary must be brief but complete, and facts must preserve every durable sensitive detail. Keep the user's language as much as possible. If the user gives names, numbers, contact details, addresses, IDs, health info, bank info, or family specifics, include them accurately in facts.

Spoken message:
${transcript}`
  });
  const text = result.text?.trim() || '';
  const jsonText = text.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error('Voice memory summary was not valid JSON.');
  const parsed = JSON.parse(jsonText) as Partial<VoiceMemoryDraft>;
  if (typeof parsed.important !== 'boolean' || typeof parsed.summary !== 'string' || !Array.isArray(parsed.facts)) {
    throw new Error('Voice memory summary was incomplete.');
  }
  return {
    important: parsed.important,
    summary: parsed.summary.trim(),
    facts: parsed.facts.filter((fact): fact is string => typeof fact === 'string' && fact.trim().length > 0),
  };
}

export async function storeImportantVoiceData(ai: GoogleGenAI, userId: string, transcript: string) {
  const normalizedTranscript = transcript.trim();
  if (!normalizedTranscript) return null;

  const draft = await summarizeVoiceMemory(ai, normalizedTranscript);
  if (!draft.important || !draft.summary) return null;

  const embeddingResult = await ai.models.embedContent({
    model: 'gemini-embedding-2-preview',
    contents: [`${draft.summary}\n${draft.facts.join('\n')}\n${normalizedTranscript}`],
  });
  const embedding = embeddingResult.embeddings?.[0]?.values;
  if (!embedding || embedding.length === 0) {
    throw new Error('Could not create an embedding for the voice memory.');
  }

  const record: UserMemoryRecord = {
    id: `memory-${crypto.randomUUID()}`,
    userId,
    source: 'voice',
    createdAt: new Date().toISOString(),
    originalText: normalizedTranscript,
    summary: draft.summary,
    facts: draft.facts,
    embedding,
  };
  const data = loadUserData(userId);
  data.memories.push(record);
  saveUserData(data);
  return record;
}

export function ensureUserDataFile(userId: string) {
  const data = loadUserData(userId);
  const filePath = userDataPath(userId);
  if (!fs.existsSync(filePath)) {
    saveUserData(data);
  }
  return data;
}