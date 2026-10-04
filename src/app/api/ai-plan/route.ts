import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createAdminClient } from "@/lib/supabase-admin";
import {
  generateContentWithRetry,
  GeminiOverloadedError,
  describeGeminiError,
} from "@/lib/gemini-with-retry";

export const runtime = "nodejs";
// generateContentWithRetry's worst case is ~101s (4 attempts, each capped at
// 20s, plus 21s of backoff sleep) before giving up — well over the
// platform default.
export const maxDuration = 300;

const MODEL_NAME = "gemini-3.6-flash";

interface AiPlanRequestBody {
  destinationId: string;
  destinationName: string;
  days: number;
  groupType: string;
  interests: string[];
  budgetLevel: string;
  startingFrom: string;
}

const responseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    summary: { type: SchemaType.STRING },
    highlights: {
      type: SchemaType.ARRAY,
      items: { type: SchemaType.STRING },
    },
    days: {
      type: SchemaType.ARRAY,
      items: {
        type: SchemaType.OBJECT,
        properties: {
          day: { type: SchemaType.NUMBER },
          title: { type: SchemaType.STRING },
          slots: {
            type: SchemaType.ARRAY,
            items: {
              type: SchemaType.OBJECT,
              properties: {
                time_of_day: {
                  type: SchemaType.STRING,
                  format: "enum",
                  enum: ["morning", "afternoon", "evening"],
                },
                activity: { type: SchemaType.STRING },
                notes: { type: SchemaType.STRING },
              },
              required: ["time_of_day", "activity"],
            },
          },
        },
        required: ["day", "title", "slots"],
      },
    },
  },
  required: ["days", "highlights"],
};

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "AI planning is not configured." },
      { status: 503 }
    );
  }

  let body: AiPlanRequestBody;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const { destinationId, destinationName, days, groupType, interests, budgetLevel, startingFrom } =
    body;

  if (!destinationId || !destinationName || !days || !groupType || !budgetLevel || !startingFrom) {
    return NextResponse.json({ error: "Missing required fields." }, { status: 400 });
  }

  const prompt = `You are a travel planner for Indian domestic tourism. Create a ${days}-day itinerary for ${destinationName}, India.

Trip details:
- Starting from: ${startingFrom}
- Group type: ${groupType}
- Interests: ${interests.length > 0 ? interests.join(", ") : "general sightseeing"}
- Budget level: ${budgetLevel}

For each day, plan morning, afternoon, and evening slots with a specific activity and a short practical note (timing, cost hint, or tip). Keep activities realistic for ${destinationName} and tailored to the stated interests and budget level. Also return a one-sentence trip summary and 3-5 short trip highlights.`;

  try {
    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema,
      },
    });

    const result = await generateContentWithRetry(model, prompt, "[ai-plan]");
    const text = result.response.text();
    const plan = JSON.parse(text);

    const supabase = createAdminClient();
    const { data: saved, error: insertError } = await supabase
      .from("ai_itineraries")
      .insert({
        destination_id: destinationId,
        days_count: days,
        trip_type: groupType,
        plan_json: plan,
        highlights: plan.highlights ?? [],
        generated_at: new Date().toISOString(),
      })
      .select("id")
      .single();

    if (insertError) {
      // Still return the generated plan even if saving failed.
      return NextResponse.json({ plan, saved: false });
    }

    return NextResponse.json({ plan, saved: true, id: saved.id });
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    console.error("ai-plan generation failed", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json(
      {
        error: `Couldn't generate an itinerary right now: ${message}`,
        details: describeGeminiError(err),
      },
      { status: 502 }
    );
  }
}
