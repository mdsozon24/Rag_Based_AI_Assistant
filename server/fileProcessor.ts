import { GoogleGenAI } from '@google/genai';

/**
 * Extracts raw readable text from a PDF Buffer without external dependencies.
 * Parses PDF streams, Text objects (BT...ET), and string literals ((...) Tj / TJ).
 */
export function extractTextFromPdfBuffer(pdfBuffer: Buffer): string {
  const textChunks: string[] = [];
  const rawString = pdfBuffer.toString('latin1');

  // Match text within BT ... ET blocks
  const textBlockRegex = /BT[\s\S]*?ET/g;
  const blocks = rawString.match(textBlockRegex) || [];

  for (const block of blocks) {
    // Match string literals: (Hello World) Tj or [(Hello) -10 (World)] TJ
    const stringLiteralRegex = /\(([^)]+)\)\s*(?:Tj|'|")/g;
    let match: RegExpExecArray | null;
    while ((match = stringLiteralRegex.exec(block)) !== null) {
      if (match[1]) {
        // Unescape standard PDF escapes
        const cleaned = match[1]
          .replace(/\\([()\\])/g, '$1')
          .replace(/\\n/g, '\n')
          .replace(/\\r/g, '')
          .replace(/\\t/g, ' ');
        textChunks.push(cleaned);
      }
    }

    // Match array strings: [(Part 1) 20 (Part 2)] TJ
    const arrayRegex = /\[(.*?)\]\s*TJ/g;
    let arrayMatch: RegExpExecArray | null;
    while ((arrayMatch = arrayRegex.exec(block)) !== null) {
      const inner = arrayMatch[1];
      const innerStrings = inner.match(/\(([^)]+)\)/g) || [];
      const combined = innerStrings
        .map(s => s.slice(1, -1).replace(/\\([()\\])/g, '$1'))
        .join(' ');
      if (combined.trim()) {
        textChunks.push(combined);
      }
    }
  }

  const extracted = textChunks.join(' ').replace(/\s+/g, ' ').trim();
  return extracted;
}

/**
 * Calls Gemini with fallback models if the primary model returns 503 (high demand) or 429.
 */
export async function generateContentWithFallback(
  ai: GoogleGenAI,
  params: {
    contents: any;
    systemInstruction?: string;
    preferredModel?: string;
  }
): Promise<string> {
  const modelsToTry = [
    params.preferredModel || 'gemini-3.6-flash',
    'gemini-3.8-flash',
    'gemini-3.1-flash-lite',
    'gemini-3.1-pro-preview',
  ];

  let lastError: any = null;

  for (const model of modelsToTry) {
    try {
      const response = await ai.models.generateContent({
        model,
        contents: params.contents,
        ...(params.systemInstruction ? { config: { systemInstruction: params.systemInstruction } } : {}),
      });

      if (response && response.text) {
        return response.text;
      }
    } catch (err: any) {
      lastError = err;
      const errMsg = err?.message || String(err);
      console.warn(`Model ${model} returned error, trying next fallback:`, errMsg.slice(0, 120));
      // If 503 or 429, retry with next model
      continue;
    }
  }

  throw lastError || new Error('All model endpoints temporarily unavailable');
}
