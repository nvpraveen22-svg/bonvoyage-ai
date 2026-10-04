import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  generateContentWithRetry,
  GeminiOverloadedError,
  describeGeminiError,
} from "@/lib/gemini-with-retry";
import type { Temple } from "@/types";

export const runtime = "nodejs";
// generateContentWithRetry's worst case is ~310s (6 retries, each capped at
// 20s, plus ~170s of backoff sleep) before giving up — well over the old 30s.
export const maxDuration = 300;
export const dynamic = "force-dynamic";
export const fetchCache = "force-no-store";

// gemini-2.0-flash is retired for this API key; gemini-3.6-flash is the
// model already proven working across this project's Gemini routes.
const MODEL_NAME = "gemini-3.6-flash";

const responseSchema: Schema = {
  type: SchemaType.ARRAY,
  items: {
    type: SchemaType.OBJECT,
    properties: {
      name: { type: SchemaType.STRING },
      deity: { type: SchemaType.STRING },
      description: { type: SchemaType.STRING },
      distance_from_center_km: { type: SchemaType.NUMBER },
      timings: { type: SchemaType.STRING },
      dress_code: { type: SchemaType.STRING },
      entry_fee: { type: SchemaType.NUMBER },
      temple_stay_available: { type: SchemaType.BOOLEAN },
      stay_details: { type: SchemaType.STRING },
    },
    required: [
      "name", "deity", "description", "distance_from_center_km", "timings",
      "dress_code", "entry_fee", "temple_stay_available", "stay_details",
    ],
  },
};

interface GeneratedTemple {
  name: string;
  deity: string;
  description: string;
  distance_from_center_km: number;
  timings: string;
  dress_code: string;
  entry_fee: number;
  temple_stay_available: boolean;
  stay_details: string;
}

interface RouteParams {
  params: { slug: string };
}

interface ResolvedDestination {
  id: string;
  name: string;
  state: string;
}

type ResolveResult =
  | { ok: true; data: ResolvedDestination }
  | { ok: false; status: 404 | 500; message: string };

async function resolveDestination(slug: string): Promise<ResolveResult> {
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("destinations")
    .select("id, name, state")
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    return { ok: false, status: 500, message: error.message };
  }
  if (!data) {
    return { ok: false, status: 404, message: "Destination not found." };
  }
  return { ok: true, data: data as ResolvedDestination };
}

export async function GET(request: NextRequest, { params }: RouteParams) {
  const resolved = await resolveDestination(params.slug);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  }
  const destination = resolved.data;

  const supabase = createAdminClient();

  const { data: existing, error: existingError } = await supabase
    .from("temples")
    .select("*")
    .eq("destination_id", destination.id)
    .order("sort_order", { ascending: true });

  if (existingError) {
    console.error("[ai-temples] lookup error:", existingError.message);
    return NextResponse.json({ error: "Couldn't load temples right now." }, { status: 500 });
  }

  if (existing && existing.length > 0) {
    return NextResponse.json({ temples: existing as Temple[], source: "db" });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ error: "Temple lookup is not configured." }, { status: 503 });
  }

  const prompt = `List the most famous temples at or near ${destination.name}, ${destination.state}, India. Only include temples that are well-known at district, state or national level — do not invent or pad with generic/minor temples that aren't genuinely notable. Return 3–5 temples. If there are fewer than 3 genuinely famous temples here, return fewer (even an empty array) rather than fabricating. Return ONLY a JSON array, no markdown, no explanation.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  let generated: GeneratedTemple[];
  try {
    const result = await generateContentWithRetry(model, prompt, "[ai-temples]");
    generated = JSON.parse(result.response.text());
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[ai-temples] generation failed:", err);
    return NextResponse.json(
      { error: `Couldn't find temples right now: ${message}`, details: describeGeminiError(err) },
      { status: 502 }
    );
  }

  if (generated.length === 0) {
    return NextResponse.json({ temples: [], source: "ai" });
  }

  const { data: inserted, error: insertError } = await supabase
    .from("temples")
    .insert(
      generated.map((t, i) => ({ ...t, destination_id: destination.id, sort_order: i + 1 }))
    )
    .select("*");

  if (insertError) {
    console.error("[ai-temples] insert failed:", insertError.message);
    // Still return what we generated even if persisting failed.
    return NextResponse.json({
      temples: generated.map((t, i) => ({ ...t, id: `temp-${i}`, destination_id: destination.id, sort_order: i + 1 })),
      source: "ai",
    });
  }

  return NextResponse.json({ temples: inserted as Temple[], source: "ai" });
}
