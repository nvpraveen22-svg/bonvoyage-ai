import { NextRequest, NextResponse } from "next/server";
import { GoogleGenerativeAI, SchemaType, type Schema } from "@google/generative-ai";
import { createAdminClient } from "@/lib/supabase-admin";
import { searchPlace, getPlaceDetails } from "@/lib/google-places";
import { syncPhotosForDestination } from "@/lib/sync-photos";
import {
  generateContentWithRetry,
  GeminiOverloadedError,
  describeGeminiError,
} from "@/lib/gemini-with-retry";

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const runtime = "nodejs";
// generateContentWithRetry's worst case is ~310s on its own (6 retries with
// a 20s per-attempt cap, see gemini-with-retry.ts), and photo sync (Google
// Places + Unsplash, one request per attraction/temple at a 600ms pace) now
// runs inline after that so its counts can be reported in the response —
// give this generous headroom for both.
export const maxDuration = 300;

// gemini-2.0-flash is retired for this API key; gemini-3.6-flash is the
// model already proven working across this project's Gemini routes.
const MODEL_NAME = "gemini-3.6-flash";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const INDIAN_STATES = [
  "Andhra Pradesh", "Arunachal Pradesh", "Assam", "Bihar", "Chhattisgarh",
  "Goa", "Gujarat", "Haryana", "Himachal Pradesh", "Jharkhand", "Karnataka",
  "Kerala", "Madhya Pradesh", "Maharashtra", "Manipur", "Meghalaya",
  "Mizoram", "Nagaland", "Odisha", "Punjab", "Rajasthan", "Sikkim",
  "Tamil Nadu", "Telangana", "Tripura", "Uttar Pradesh", "Uttarakhand",
  "West Bengal", "Andaman and Nicobar Islands", "Chandigarh",
  "Dadra and Nagar Haveli and Daman and Diu", "Delhi",
  "Jammu and Kashmir", "Ladakh", "Lakshadweep", "Puducherry",
];

function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

const attractionSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    category: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["nature", "wildlife", "adventure", "beach", "heritage", "culture"],
    },
    description: { type: SchemaType.STRING },
    distance_from_center_km: { type: SchemaType.NUMBER },
    entry_fee_adult: { type: SchemaType.NUMBER },
    entry_fee_child: { type: SchemaType.NUMBER },
    timings: { type: SchemaType.STRING },
    duration_hours: { type: SchemaType.NUMBER },
    family_friendly: { type: SchemaType.BOOLEAN },
  },
  required: [
    "name", "category", "description", "distance_from_center_km",
    "entry_fee_adult", "entry_fee_child", "timings", "duration_hours", "family_friendly",
  ],
};

const hotelSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    stars: { type: SchemaType.NUMBER },
    rating: { type: SchemaType.NUMBER },
    price_min: { type: SchemaType.NUMBER },
    price_max: { type: SchemaType.NUMBER },
    address: { type: SchemaType.STRING },
    amenities: { type: SchemaType.ARRAY, items: { type: SchemaType.STRING } },
    ai_summary: { type: SchemaType.STRING },
    warning_flag: { type: SchemaType.BOOLEAN },
    warning_reason: { type: SchemaType.STRING },
  },
  required: [
    "name", "stars", "rating", "price_min", "price_max", "address",
    "amenities", "ai_summary", "warning_flag", "warning_reason",
  ],
};

const activitySchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    name: { type: SchemaType.STRING },
    category: {
      type: SchemaType.STRING,
      format: "enum",
      enum: ["adventure", "wildlife", "leisure", "nature", "culture", "heritage"],
    },
    description: { type: SchemaType.STRING },
    duration_hours: { type: SchemaType.NUMBER },
    price_per_person: { type: SchemaType.NUMBER },
    family_friendly: { type: SchemaType.BOOLEAN },
    booking_required: { type: SchemaType.BOOLEAN },
  },
  required: [
    "name", "category", "description", "duration_hours",
    "price_per_person", "family_friendly", "booking_required",
  ],
};

const templeSchema: Schema = {
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
    stay_price_min: { type: SchemaType.NUMBER },
    stay_price_max: { type: SchemaType.NUMBER },
  },
  required: [
    "name", "deity", "description", "distance_from_center_km", "timings",
    "dress_code", "entry_fee", "temple_stay_available", "stay_details",
    "stay_price_min", "stay_price_max",
  ],
};

const howToReachSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    mode: { type: SchemaType.STRING, format: "enum", enum: ["road", "train", "air", "bus"] },
    description: { type: SchemaType.STRING },
    distance_from_hyderabad_km: { type: SchemaType.NUMBER },
    duration_from_hyderabad: { type: SchemaType.STRING },
    nearest_airport: { type: SchemaType.STRING },
    nearest_railway_station: { type: SchemaType.STRING },
    tips: { type: SchemaType.STRING },
  },
  required: [
    "mode", "description", "distance_from_hyderabad_km", "duration_from_hyderabad",
    "nearest_airport", "nearest_railway_station", "tips",
  ],
};

const responseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: {
    destination: {
      type: SchemaType.OBJECT,
      properties: {
        state: { type: SchemaType.STRING, format: "enum", enum: INDIAN_STATES },
        tagline: { type: SchemaType.STRING },
        description: { type: SchemaType.STRING },
        best_time_to_visit: { type: SchemaType.STRING },
        ideal_trip_days_min: { type: SchemaType.NUMBER },
        ideal_trip_days_max: { type: SchemaType.NUMBER },
        history_culture: { type: SchemaType.STRING },
        month_notes: { type: SchemaType.STRING },
        best_months: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING, format: "enum", enum: MONTHS },
        },
        okay_months: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING, format: "enum", enum: MONTHS },
        },
        avoid_months: {
          type: SchemaType.ARRAY,
          items: { type: SchemaType.STRING, format: "enum", enum: MONTHS },
        },
      },
      required: [
        "state", "tagline", "description", "best_time_to_visit", "ideal_trip_days_min",
        "ideal_trip_days_max", "history_culture", "month_notes",
        "best_months", "okay_months", "avoid_months",
      ],
    },
    attractions: { type: SchemaType.ARRAY, items: attractionSchema },
    hotels: { type: SchemaType.ARRAY, items: hotelSchema },
    activities: { type: SchemaType.ARRAY, items: activitySchema },
    how_to_reach: { type: SchemaType.ARRAY, items: howToReachSchema },
    temples: { type: SchemaType.ARRAY, items: templeSchema },
  },
  required: ["destination", "attractions", "hotels", "activities", "how_to_reach", "temples"],
};

interface GeneratedDestination {
  state: string;
  tagline: string;
  description: string;
  best_time_to_visit: string;
  ideal_trip_days_min: number;
  ideal_trip_days_max: number;
  history_culture: string;
  month_notes: string;
  best_months: string[];
  okay_months: string[];
  avoid_months: string[];
}

interface GeneratedAttraction {
  name: string;
  category: string;
  description: string;
  distance_from_center_km: number;
  entry_fee_adult: number;
  entry_fee_child: number;
  timings: string;
  duration_hours: number;
  family_friendly: boolean;
}

interface GeneratedHotel {
  name: string;
  stars: number;
  rating: number;
  price_min: number;
  price_max: number;
  address: string;
  amenities: string[];
  ai_summary: string;
  warning_flag: boolean;
  warning_reason: string;
}

interface GeneratedActivity {
  name: string;
  category: string;
  description: string;
  duration_hours: number;
  price_per_person: number;
  family_friendly: boolean;
  booking_required: boolean;
}

interface GeneratedHowToReach {
  mode: "road" | "train" | "air" | "bus";
  description: string;
  distance_from_hyderabad_km: number;
  duration_from_hyderabad: string;
  nearest_airport: string;
  nearest_railway_station: string;
  tips: string;
}

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
  stay_price_min: number;
  stay_price_max: number;
}

interface GeneratedPayload {
  destination: GeneratedDestination;
  attractions: GeneratedAttraction[];
  hotels: GeneratedHotel[];
  activities: GeneratedActivity[];
  how_to_reach: GeneratedHowToReach[];
  temples: GeneratedTemple[];
}

export async function POST(request: NextRequest) {
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    return NextResponse.json({ error: "Admin access is not configured." }, { status: 503 });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return NextResponse.json(
      { error: "Destination builder is not configured." },
      { status: 503 }
    );
  }

  let body: { pin?: string; name?: string; state?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid request body." }, { status: 400 });
  }

  if (typeof body.pin !== "string" || body.pin !== adminPin) {
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const name = body.name?.trim();
  if (!name) {
    return NextResponse.json({ error: "Destination name is required." }, { status: 400 });
  }
  const stateHint = body.state?.trim();

  const slug = generateSlug(name);
  if (!slug) {
    return NextResponse.json({ error: "Couldn't derive a slug from that name." }, { status: 400 });
  }

  const supabase = createAdminClient();

  const { data: existing, error: lookupError } = await supabase
    .from("destinations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();

  if (lookupError) {
    console.error("[build-destination] lookup error:", lookupError.message);
    return NextResponse.json({ error: "Couldn't check for an existing destination." }, { status: 500 });
  }
  if (existing) {
    return NextResponse.json(
      { error: `A destination with slug "${slug}" already exists.` },
      { status: 409 }
    );
  }

  const prompt = `You are a travel content expert building a destination guide for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Destination name: ${name}${stateHint ? `\nState: ${stateHint}` : "\n(Infer the correct real Indian state for this destination.)"}

Generate a complete, realistic destination guide as a JSON object with exactly this shape:
- destination: state (the correct real Indian state or union territory ${name} is located in — always fill this in accurately even if a state was given above), tagline, description, best_time_to_visit, ideal_trip_days_min, ideal_trip_days_max, history_culture, month_notes, best_months (array of month names), okay_months, avoid_months
- attractions: exactly 6 real, well-known attractions/sights near this destination
- hotels: exactly 5 realistic hotels or stays spanning budget to luxury (set warning_flag true only if there's a genuine, common practical caveat for that property, e.g. remote location or seasonal closure, otherwise false with warning_reason as an empty string)
- activities: exactly 5 things travellers can do there
- how_to_reach: exactly 4 entries, one each for mode "road", "train", "air", and "bus", describing how to reach ${name} from Hyderabad specifically
- temples: 3-5 temples at or near ${name} — but ONLY temples that are genuinely famous at a district, state, or national level. If ${name} has fewer than 3 such famous temples, return fewer (even zero) — do not invent or pad with generic/minor temples that aren't actually notable. For each temple set temple_stay_available honestly, and stay_details/stay_price_min/stay_price_max to empty string / 0 / 0 when no temple stay is offered.

All costs must be in Indian Rupees (numbers only, no currency symbols). Month names must be full English month names (e.g. "October"). Be realistic and specific — use real place names, real highway/route references, and real nearby airports/stations where possible. Return ONLY the JSON object, no markdown, no explanation.`;

  const genAI = new GoogleGenerativeAI(apiKey);
  const model = genAI.getGenerativeModel({
    model: MODEL_NAME,
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema,
    },
  });

  let parsed: GeneratedPayload;
  try {
    const result = await generateContentWithRetry(model, prompt, "[build-destination]");
    parsed = JSON.parse(result.response.text());
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[build-destination] generation failed:", err);
    return NextResponse.json(
      {
        error: `Couldn't generate destination content: ${message}`,
        details: describeGeminiError(err),
      },
      { status: 502 }
    );
  }

  const { data: destinationRow, error: insertDestError } = await supabase
    .from("destinations")
    .insert({
      name,
      slug,
      state: stateHint || parsed.destination.state,
      tagline: parsed.destination.tagline,
      description: parsed.destination.description,
      best_time_to_visit: parsed.destination.best_time_to_visit,
      ideal_trip_days_min: parsed.destination.ideal_trip_days_min,
      ideal_trip_days_max: parsed.destination.ideal_trip_days_max,
      history_culture: parsed.destination.history_culture,
      month_notes: parsed.destination.month_notes,
      best_months: parsed.destination.best_months,
      okay_months: parsed.destination.okay_months,
      avoid_months: parsed.destination.avoid_months,
      status: "active",
    })
    .select("id")
    .single();

  if (insertDestError || !destinationRow) {
    console.error("[build-destination] destination insert failed:", insertDestError?.message);
    return NextResponse.json(
      { error: "Couldn't create the destination record." },
      { status: 500 }
    );
  }

  const destinationId = destinationRow.id;

  // From here on, the destination row exists and is reachable at its slug —
  // every remaining step is best-effort. Each is isolated in its own
  // try/catch so one failure (e.g. Gemini's how_to_reach array not matching
  // a DB constraint) can't take down sections that already succeeded.
  type StepResult = { count: number } | { error: string };
  const results: {
    attractions: StepResult;
    hotels: StepResult;
    activities: StepResult;
    howToReach: StepResult;
    temples: StepResult;
    photos: { attraction_photos: number; temple_photos: number } | { error: string };
  } = {
    attractions: { count: 0 },
    hotels: { count: 0 },
    activities: { count: 0 },
    howToReach: { count: 0 },
    temples: { count: 0 },
    photos: { attraction_photos: 0, temple_photos: 0 },
  };

  function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : "Unknown error";
  }

  try {
    const { error } = await supabase.from("attractions").insert(
      parsed.attractions.map((a, i) => ({ ...a, destination_id: destinationId, sort_order: i + 1 }))
    );
    if (error) throw new Error(error.message);
    results.attractions = { count: parsed.attractions.length };
  } catch (err) {
    console.error("[build-destination] attractions insert failed:", err);
    results.attractions = { error: errorMessage(err) };
  }

  let insertedHotels: { id: string; name: string }[] | null = null;
  try {
    const { data, error } = await supabase
      .from("hotels")
      .insert(
        parsed.hotels.map((h) => ({
          ...h,
          // hotels_stars_check requires stars >= 3; Gemini has no visibility
          // into that DB constraint, so clamp rather than let one budget
          // property fail the whole batch insert.
          stars: Math.max(3, h.stars),
          destination_id: destinationId,
        }))
      )
      .select("id, name");
    if (error) throw new Error(error.message);
    insertedHotels = data as { id: string; name: string }[];
    results.hotels = { count: parsed.hotels.length };
  } catch (err) {
    console.error("[build-destination] hotels insert failed:", err);
    results.hotels = { error: errorMessage(err) };
  }

  // Best-effort: enrich the newly-inserted hotels with real Google ratings/
  // contact info. Capped at 5 (== the hotel count Gemini always generates)
  // to bound Places API quota per destination build; skipped entirely if no
  // key is configured, same "log and continue" pattern as the Unsplash/
  // YouTube keys in sync-media. Informational only — not part of `results`,
  // since a hotel row without enrichment is still a perfectly usable hotel.
  let placesEnriched = 0;
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.warn(
      "[build-destination] GOOGLE_PLACES_API_KEY is not set — skipping hotel enrichment."
    );
  } else if (insertedHotels) {
    try {
      const cityName = `${name} ${stateHint ?? ""}`.trim();
      for (const hotel of insertedHotels.slice(0, 5)) {
        const found = await searchPlace(hotel.name, cityName);
        await sleep(200);
        if (!found) continue;

        const details = await getPlaceDetails(found.placeId);
        await sleep(200);

        const { error: enrichError } = await supabase
          .from("hotels")
          .update({
            google_rating: details?.rating ?? found.rating,
            google_reviews_count: details?.userRatingsTotal ?? found.userRatingsTotal,
            phone: details?.phone ?? null,
            website: details?.website ?? null,
            google_place_id: found.placeId,
            places_enriched_at: new Date().toISOString(),
          })
          .eq("id", hotel.id);

        if (enrichError) {
          console.error(
            `[build-destination] hotel enrichment failed for "${hotel.name}":`,
            enrichError.message
          );
        } else {
          placesEnriched++;
        }
      }
    } catch (err) {
      console.error("[build-destination] hotel enrichment failed:", err);
    }
  }

  try {
    const { error } = await supabase.from("activities").insert(
      parsed.activities.map((a, i) => ({ ...a, destination_id: destinationId, sort_order: i + 1 }))
    );
    if (error) throw new Error(error.message);
    results.activities = { count: parsed.activities.length };
  } catch (err) {
    console.error("[build-destination] activities insert failed:", err);
    results.activities = { error: errorMessage(err) };
  }

  try {
    if (parsed.temples.length > 0) {
      const { error } = await supabase.from("temples").insert(
        parsed.temples.map((t, i) => ({ ...t, destination_id: destinationId, sort_order: i + 1 }))
      );
      if (error) throw new Error(error.message);
      results.temples = { count: parsed.temples.length };
    }
  } catch (err) {
    console.error("[build-destination] temples insert failed:", err);
    results.temples = { error: errorMessage(err) };
  }

  try {
    const { error } = await supabase.from("how_to_reach").insert(
      parsed.how_to_reach.map((r) => ({ ...r, destination_id: destinationId }))
    );
    if (error) throw new Error(error.message);
    results.howToReach = { count: parsed.how_to_reach.length };
  } catch (err) {
    console.error("[build-destination] how_to_reach insert failed:", err);
    results.howToReach = { error: errorMessage(err) };
  }

  try {
    results.photos = await syncPhotosForDestination(destinationId, name, supabase);
  } catch (err) {
    console.error("[build-destination] photo sync failed:", err);
    results.photos = { error: errorMessage(err) };
  }

  const partialBuild = Object.values(results).some((r) => "error" in r);

  return NextResponse.json({
    success: true,
    destinationId,
    slug,
    results,
    places_enriched: placesEnriched,
    partialBuild,
  });
}
