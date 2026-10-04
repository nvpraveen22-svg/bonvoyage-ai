import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  generateContentWithRetry,
  GeminiOverloadedError,
  describeGeminiError,
} from "@/lib/gemini-with-retry";
import type { AiInsightsContent } from "@/types";

export const runtime = "nodejs";
// generateContentWithRetry's worst case is ~310s (6 retries, each capped at
// 20s, plus ~170s of backoff sleep) before giving up — well over the
// platform default.
export const maxDuration = 300;

const MODEL_NAME = "gemini-3.6-flash";
const PROMPT_VERSION = 1;

const activityTagSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    reason: { type: SchemaType.STRING },
    familyFriendly: { type: SchemaType.BOOLEAN },
    realPricing: { type: SchemaType.STRING },
  },
  required: ["name", "reason", "familyFriendly"],
};

const responseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    stayRecommendations: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          name: { type: SchemaType.STRING },
          pros: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          cons: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
          verdict: { type: SchemaType.STRING },
          bookInAdvance: { type: SchemaType.BOOLEAN },
          bookInAdvanceNote: { type: SchemaType.STRING },
        },
        required: ["name", "pros", "cons", "verdict", "bookInAdvance"],
      },
    },
    activities: {
      type: SchemaType.OBJECT,
      properties: {
        mustDo: { type: SchemaType.ARRAY, items: activityTagSchema },
        optional: { type: SchemaType.ARRAY, items: activityTagSchema },
        skip: { type: SchemaType.ARRAY, items: activityTagSchema },
      },
      required: ["mustDo", "optional", "skip"],
    },
    practicalWarnings: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    budgetRealityCheck: {
      type: SchemaType.OBJECT,
      properties: {
        realistic: { type: SchemaType.BOOLEAN },
        verdict: { type: SchemaType.STRING },
        costSpikes: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
      },
      required: ["realistic", "verdict", "costSpikes"],
    },
    localTips: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
  },
  required: [
    "stayRecommendations",
    "activities",
    "practicalWarnings",
    "budgetRealityCheck",
    "localTips",
  ],
};

interface RouteParams {
  params: { slug: string };
}

interface ResolvedDestination {
  id: string;
  name: string;
  state: string;
  tagline: string | null;
  description: string | null;
  best_time_to_visit: string | null;
  ideal_trip_days_min: number | null;
  ideal_trip_days_max: number | null;
}

type ResolveResult =
  | { ok: true; data: ResolvedDestination }
  | { ok: false; status: 404 | 500; message: string };

async function resolveDestination(slug: string): Promise<ResolveResult> {
  const supabase = createAdminClient();
  console.log(`[ai-insights] looking up destination for slug="${slug}"`);
  const { data, error } = await supabase
    .from("destinations")
    .select(
      "id, name, state, tagline, description, best_time_to_visit, ideal_trip_days_min, ideal_trip_days_max"
    )
    .eq("slug", slug)
    .maybeSingle();

  if (error) {
    console.error(`[ai-insights] query error for slug="${slug}":`, error.message, error);
    return { ok: false, status: 500, message: error.message };
  }
  if (!data) {
    console.warn(`[ai-insights] no destination row matched slug="${slug}"`);
    return { ok: false, status: 404, message: "Destination not found." };
  }
  return { ok: true, data: data as ResolvedDestination };
}

export async function GET(_request: NextRequest, { params }: RouteParams) {
  const resolved = await resolveDestination(params.slug);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  }
  const destination = resolved.data;

  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from("ai_insights")
    .select("content, generated_at, prompt_version")
    .eq("destination_id", destination.id)
    .eq("type", "general")
    .maybeSingle();

  if (error) {
    console.error(`[ai-insights] ai_insights query error for destination_id=${destination.id}:`, error.message, error);
    return NextResponse.json(
      { error: "Couldn't load insights right now." },
      { status: 500 }
    );
  }

  if (!data) {
    return NextResponse.json({ exists: false });
  }

  let content: AiInsightsContent;
  try {
    content = JSON.parse(data.content);
  } catch {
    return NextResponse.json(
      { error: "Stored insights are corrupted." },
      { status: 500 }
    );
  }

  return NextResponse.json({
    exists: true,
    content,
    generated_at: data.generated_at,
    prompt_version: data.prompt_version,
  });
}

export async function POST(_request: NextRequest, { params }: RouteParams) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI insights are not configured." },
      { status: 503 }
    );
  }

  const resolved = await resolveDestination(params.slug);
  if (!resolved.ok) {
    return NextResponse.json({ error: resolved.message }, { status: resolved.status });
  }
  const destination = resolved.data;

  const supabase = createAdminClient();
  const [{ data: hotels }, { data: activities }, { data: attractions }] = await Promise.all([
    supabase
      .from("hotels")
      .select("name, stars, rating, price_min, price_max, amenities, ai_summary")
      .eq("destination_id", destination.id),
    supabase
      .from("activities")
      .select(
        "name, category, description, duration_hours, price_per_person, family_friendly, booking_required"
      )
      .eq("destination_id", destination.id),
    supabase
      .from("attractions")
      .select("name, category, description, entry_fee_adult, rating")
      .eq("destination_id", destination.id),
  ]);

  const hotelLines = (hotels ?? [])
    .map(
      (h) =>
        `- ${h.name} (${h.stars ?? "?"}★, rated ${h.rating ?? "n/a"}/5, ₹${h.price_min ?? "?"}-${h.price_max ?? "?"}/night, amenities: ${(h.amenities ?? []).join(", ") || "none listed"}). Notes: ${h.ai_summary ?? "none"}`
    )
    .join("\n");

  const activityLines = (activities ?? [])
    .map(
      (a) =>
        `- ${a.name} (${a.category ?? "general"}, ~${a.duration_hours ?? "?"}h, ₹${a.price_per_person ?? "?"}/person, family friendly: ${a.family_friendly ? "yes" : "no"}, booking required: ${a.booking_required ? "yes" : "no"}). ${a.description ?? ""}`
    )
    .join("\n");

  const attractionLines = (attractions ?? [])
    .map(
      (a) =>
        `- ${a.name} (${a.category ?? "general"}, entry ₹${a.entry_fee_adult ?? 0}, rated ${a.rating ?? "n/a"}/5). ${a.description ?? ""}`
    )
    .join("\n");

  const tripDays =
    destination.ideal_trip_days_min && destination.ideal_trip_days_max
      ? `${destination.ideal_trip_days_min}-${destination.ideal_trip_days_max} days`
      : "a few days";

  const prompt = `You are an honest, experienced Indian travel advisor writing candid research-backed insights for travelers considering ${destination.name}, ${destination.state}, India. This is NOT a marketing itinerary — be balanced, mention real downsides, and call out anything overhyped or not worth it.

Destination context:
- Tagline: ${destination.tagline ?? "n/a"}
- Best time to visit: ${destination.best_time_to_visit ?? "n/a"}
- Ideal trip length: ${tripDays}
- Description: ${destination.description ?? "n/a"}

Real hotels/stays in our database (base your stay recommendations ONLY on these, referencing them by exact name):
${hotelLines || "(none listed)"}

Real activities in our database (base your activity recommendations ONLY on these, referencing them by exact name):
${activityLines || "(none listed)"}

Real attractions in our database (use these for local tips and warnings context):
${attractionLines || "(none listed)"}

Produce:
1. stayRecommendations: for EACH hotel listed above, give 2-4 pros, 1-3 cons, an honest one-line verdict, and whether it needs booking well in advance (with a short note on how far ahead / peak season risk).
2. activities: sort the listed activities into mustDo, optional, and skip, each with a one-line reason, whether it's family-friendly, and a realistic pricing note (call out if the listed price seems low and where operators typically upsell).
3. practicalWarnings: 4-6 concrete, practical warnings (mobile network reliability, booking lead times, seasonal road/weather issues, what to pack) specific to ${destination.name}.
4. budgetRealityCheck: whether a typical traveler's budget expectations for this destination are realistic, a one-paragraph verdict, and 2-4 specific spots where costs commonly spike beyond what people expect.
5. localTips: 4-6 concise insider tips (best time of day/week, how to reach efficiently, local etiquette, hidden costs) that a first-time visitor wouldn't know.`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
      },
    });

    const result = await generateContentWithRetry(model, prompt, "[ai-insights]");
    const content: AiInsightsContent = JSON.parse(result.response.text());
    const generatedAt = new Date().toISOString();

    const { error: upsertError } = await supabase.from("ai_insights").upsert(
      {
        destination_id: destination.id,
        type: "general",
        content: JSON.stringify(content),
        generated_at: generatedAt,
        prompt_version: PROMPT_VERSION,
      },
      { onConflict: "destination_id,type" }
    );

    if (upsertError) {
      console.error("ai-insights upsert failed", upsertError);
      // Still return the freshly generated content even if caching failed.
    }

    return NextResponse.json({
      content,
      generated_at: generatedAt,
      prompt_version: PROMPT_VERSION,
      saved: !upsertError,
    });
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    console.error("ai-insights generation failed", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        error: `Couldn't generate insights right now: ${message}`,
        details: describeGeminiError(err),
      },
      { status: 502 }
    );
  }
}
