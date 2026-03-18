#!/usr/bin/env npx tsx
/**
 * Fetch models from provider endpoints and generate models-manifest.json.
 * Usage: OPENAI_API_KEY=... ANTHROPIC_API_KEY=... GOOGLE_API_KEY=... npm run models:fetch
 */

import { writeFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import {
  deriveModelCapabilities,
  type AIProvider,
} from '../src/utils/modelCapabilities';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, '../src/data/models-manifest.json');

interface ManifestModel {
  id: string;
  name: string;
  contextWindow?: number;
  isReasoning: boolean;
  isFast: boolean;
  hasHighContext: boolean;
}

interface Manifest {
  generatedAt: string;
  providers: Record<AIProvider, ManifestModel[]>;
}

async function fetchOpenAI(key: string): Promise<ManifestModel[]> {
  const resp = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${key}` },
  });
  if (!resp.ok) throw new Error(`OpenAI: ${resp.status}`);
  const data = (await resp.json()) as { data?: Array<Record<string, unknown>> };
  const arr = data.data ?? [];
  return arr
    .filter((m) => {
      const id = String(m.id ?? '');
      const isChat =
        id.includes('gpt') ||
        id.includes('chatgpt') ||
        id.startsWith('o1') ||
        id.startsWith('o3') ||
        id.startsWith('o4');
      const isNonChat =
        id.includes('embedding') ||
        id.includes('whisper') ||
        id.includes('tts-') ||
        id.includes('davinci') ||
        id.includes('babbage') ||
        id.includes('dall-e') ||
        id.includes('gpt-image') ||
        id.includes('text-moderation') ||
        id.includes('omni-moderation') ||
        id.includes('codex-mini') ||
        id.startsWith('sora');
      return isChat && !isNonChat;
    })
    .map((m) => {
      const id = String(m.id ?? '');
      const name =
        String(m.display_name ?? m.name ?? id)
          .replace('gpt-', 'GPT-')
          .replace('-turbo', ' Turbo')
          .replace('-preview', ' Preview') || id;
      const caps = deriveModelCapabilities(id, 'openai', undefined);
      return {
        id,
        name,
        isReasoning: caps.isReasoning,
        isFast: caps.isFast,
        hasHighContext: caps.hasHighContext,
      };
    });
}

async function fetchAnthropic(key: string): Promise<ManifestModel[]> {
  const resp = await fetch('https://api.anthropic.com/v1/models', {
    headers: {
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
  });
  if (!resp.ok) throw new Error(`Anthropic: ${resp.status}`);
  const data = (await resp.json()) as {
    data?: Array<Record<string, unknown>>;
  };
  const arr = data.data ?? [];
  return arr
    .filter((m) => m.id && typeof m.id === 'string')
    .map((m) => {
      const id = String(m.id);
      const name = String(m.display_name ?? m.name ?? id);
      const ctx = typeof m.context_window === 'number' ? m.context_window : undefined;
      const caps = deriveModelCapabilities(id, 'anthropic', ctx);
      return {
        id,
        name,
        contextWindow: ctx,
        isReasoning: caps.isReasoning,
        isFast: caps.isFast,
        hasHighContext: caps.hasHighContext,
      };
    });
}

async function fetchGoogle(key: string): Promise<ManifestModel[]> {
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${key}`
  );
  if (!resp.ok) throw new Error(`Google: ${resp.status}`);
  const data = (await resp.json()) as {
    models?: Array<Record<string, unknown>>;
  };
  const arr = data.models ?? [];
  return arr
    .filter((m) => {
      const methods = (m.supportedGenerationMethods as string[] | undefined) ?? [];
      return methods.includes('generateContent');
    })
    .map((m) => {
      const rawName = String(m.name ?? '');
      const id = rawName.replace('models/', '');
      const name = String(m.displayName ?? id);
      const ctx =
        typeof m.inputTokenLimit === 'number' ? m.inputTokenLimit : undefined;
      const caps = deriveModelCapabilities(id, 'google', ctx);
      return {
        id,
        name,
        contextWindow: ctx,
        isReasoning: caps.isReasoning,
        isFast: caps.isFast,
        hasHighContext: caps.hasHighContext,
      };
    });
}

async function fetchVertex(
  token: string,
  projectId: string,
  region: string
): Promise<ManifestModel[]> {
  const url = `https://${region}-aiplatform.googleapis.com/v1beta1/publishers/google/models`;
  const resp = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!resp.ok) throw new Error(`Vertex: ${resp.status}`);
  const data = (await resp.json()) as {
    publisherModels?: Array<Record<string, unknown>>;
  };
  const arr = data.publisherModels ?? [];
  return arr
    .filter((m) => {
      const name = String(m.name ?? '');
      const modelId = name.split('/').pop() ?? name;
      return modelId.startsWith('gemini');
    })
    .map((m) => {
      const name = String(m.name ?? '');
      const id = name.split('/').pop() ?? name;
      const displayName =
        (m.versionId as string) ?? (m.openSourceCategory as string) ?? id;
      const caps = deriveModelCapabilities(id, 'vertex', undefined);
      return {
        id,
        name: String(displayName),
        isReasoning: caps.isReasoning,
        isFast: caps.isFast,
        hasHighContext: caps.hasHighContext,
      };
    });
}

async function main() {
  const manifest: Manifest = {
    generatedAt: new Date().toISOString(),
    providers: {
      anthropic: [],
      openai: [],
      google: [],
      vertex: [],
      lmstudio: [],
    },
  };

  if (process.env.OPENAI_API_KEY) {
    try {
      manifest.providers.openai = await fetchOpenAI(process.env.OPENAI_API_KEY);
      console.log(`OpenAI: ${manifest.providers.openai.length} models`);
    } catch (e) {
      console.error('OpenAI fetch failed:', e);
    }
  } else {
    console.warn('OPENAI_API_KEY not set, skipping OpenAI');
  }

  if (process.env.ANTHROPIC_API_KEY) {
    try {
      manifest.providers.anthropic = await fetchAnthropic(
        process.env.ANTHROPIC_API_KEY
      );
      console.log(`Anthropic: ${manifest.providers.anthropic.length} models`);
    } catch (e) {
      console.error('Anthropic fetch failed:', e);
    }
  } else {
    console.warn('ANTHROPIC_API_KEY not set, skipping Anthropic');
  }

  if (process.env.GOOGLE_API_KEY) {
    try {
      manifest.providers.google = await fetchGoogle(process.env.GOOGLE_API_KEY);
      console.log(`Google: ${manifest.providers.google.length} models`);
    } catch (e) {
      console.error('Google fetch failed:', e);
    }
  } else {
    console.warn('GOOGLE_API_KEY not set, skipping Google AI');
  }

  if (
    process.env.VERTEX_ACCESS_TOKEN &&
    process.env.VERTEX_PROJECT_ID &&
    process.env.VERTEX_REGION
  ) {
    try {
      manifest.providers.vertex = await fetchVertex(
        process.env.VERTEX_ACCESS_TOKEN,
        process.env.VERTEX_PROJECT_ID,
        process.env.VERTEX_REGION
      );
      console.log(`Vertex: ${manifest.providers.vertex.length} models`);
    } catch (e) {
      console.error('Vertex fetch failed:', e);
    }
  } else {
    console.warn('VERTEX_ACCESS_TOKEN/PROJECT_ID/REGION not set, skipping Vertex');
  }

  mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
  writeFileSync(OUTPUT_PATH, JSON.stringify(manifest, null, 2), 'utf-8');
  console.log(`Wrote ${OUTPUT_PATH}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
