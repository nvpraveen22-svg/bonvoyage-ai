import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI } from "@google/generative-ai";
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
// A chat box has no natural length limit the way a form field does - cap it
// so one visitor can't balloon Gemini token cost with an oversized message.
const MAX_MESSAGE_LENGTH = 500;

export async function POST(request: NextRequest) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Travel assistant is not configured." },
      { status: 503 }
    );
  }

  let body: { message?: string; userLocation?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  const message = body.message?.trim();
  if (!message) {
    return NextResponse.json({ error: "A message is required." }, { status: 400 });
  }
  if (message.length > MAX_MESSAGE_LENGTH) {
    return NextResponse.json(
      { error: `Keep questions under ${MAX_MESSAGE_LENGTH} characters.` },
      { status: 400 }
    );
  }
  const userLocation = typeof body.userLocation === "string" ? body.userLocation.trim() : "";

  const prompt = `You are TripSense AI, an expert India travel assistant.
${userLocation ? `User's current location: ${userLocation}` : ""}

User question: ${message}

Answer helpfully and concisely. Focus on:
- Specific destination names with distances if relevant
- Best time to visit, crowd levels, family-friendliness
- Nearby restaurants or hotels if asked
- Practical travel tips

Format your response in a friendly, conversational way.
Use bullet points for lists of destinations.
Keep response under 300 words.
Only suggest real places in India.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({ model: MODEL_NAME });

  try {
    const result = await generateContentWithRetry(model, prompt, "[travel-assistant]");
    const reply = result.response.text();
    return NextResponse.json({ reply });
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[travel-assistant] generation failed:", err);
    return NextResponse.json(
      { error: `Couldn't get a response: ${message}`, details: describeGeminiError(err) },
      { status: 502 }
    );
  }
}
