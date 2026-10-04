import { NextRequest, NextResponse } from "next/server";
import {
  GoogleGenerativeAI,
  SchemaType,
  type Schema,
  type GenerativeModel,
} from "@google/generative-ai";
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
// The foundation call and the 5 section calls below run as: one sequential
// call, then all 5 concurrently. That makes the *typical* run roughly
// 2 Gemini calls deep instead of 6 sequential ones. It does NOT lower the
// *worst* case below 300s on its own: generateContentWithRetry's own worst
// case is ~310s per call (see gemini-with-retry.ts), and that budget applies
// per call regardless of how many run concurrently — if the foundation call
// (which must finish before the others start) alone hits its full retry
// budget, this handler is already past 300s before the parallel section
// even begins. Running sections concurrently buys headroom for the common
// case; it doesn't change what a single genuinely-stuck call costs.
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

// ---------------------------------------------------------------------------
// Schemas. Each section gets its own small response schema (wrapped in an
// object, same convention as before) instead of one combined schema, so each
// can be requested from Gemini as its own independent call.
// ---------------------------------------------------------------------------

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

const howToReachEntrySchema: Schema = {
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

// Foundation call: everything needed to create the destinations row itself.
// latitude/longitude are real columns (see src/types/index.ts) that the old
// single-call version never actually populated — filled in here since the
// foundation call is already the natural place for destination-level facts.
const foundationResponseSchema: Schema = {
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
    latitude: { type: SchemaType.NUMBER },
    longitude: { type: SchemaType.NUMBER },
  },
  required: [
    "state", "tagline", "description", "best_time_to_visit", "ideal_trip_days_min",
    "ideal_trip_days_max", "history_culture", "month_notes",
    "best_months", "okay_months", "avoid_months", "latitude", "longitude",
  ],
};

const attractionsResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: { attractions: { type: SchemaType.ARRAY, items: attractionSchema } },
  required: ["attractions"],
};

const hotelsResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: { hotels: { type: SchemaType.ARRAY, items: hotelSchema } },
  required: ["hotels"],
};

const activitiesResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: { activities: { type: SchemaType.ARRAY, items: activitySchema } },
  required: ["activities"],
};

const templesResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: { temples: { type: SchemaType.ARRAY, items: templeSchema } },
  required: ["temples"],
};

const howToReachResponseSchema: Schema = {
  type: SchemaType.OBJECT,
  properties: { how_to_reach: { type: SchemaType.ARRAY, items: howToReachEntrySchema } },
  required: ["how_to_reach"],
};

interface GeneratedFoundation {
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
  latitude: number;
  longitude: number;
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

async function runSection<T>(
  model: GenerativeModel,
  prompt: string,
  logPrefix: string
): Promise<T> {
  const result = await generateContentWithRetry(model, prompt, logPrefix);
  return JSON.parse(result.response.text()) as T;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : "Unknown error";
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

  const genAI = new GoogleGenerativeAI(apiKey);
  const makeModel = (schema: Schema) =>
    genAI.getGenerativeModel({
      model: MODEL_NAME,
      generationConfig: { responseMimeType: "application/json", responseSchema: schema },
    });

  // ---------------------------------------------------------------------
  // Step 1: foundation call. Everything else (the destination row's FK,
  // and the state used to ground the section prompts below) depends on
  // this, so it stays a single awaited call rather than joining the
  // parallel batch.
  // ---------------------------------------------------------------------
  const foundationPrompt = `You are a travel content expert building a destination guide for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Destination name: ${name}${stateHint ? `\nState: ${stateHint}` : "\n(Infer the correct real Indian state for this destination.)"}

Generate the foundational overview for this destination as a JSON object with exactly these fields: state (the correct real Indian state or union territory ${name} is located in — always fill this in accurately even if a state was given above), tagline, description, best_time_to_visit, ideal_trip_days_min, ideal_trip_days_max, history_culture, month_notes, best_months (array of month names), okay_months, avoid_months, latitude, longitude (the real approximate coordinates of ${name}'s town/city center, as decimal degrees).

Month names must be full English month names (e.g. "October"). Be realistic and specific. Return ONLY the JSON object, no markdown, no explanation.`;

  let foundation: GeneratedFoundation;
  try {
    foundation = await runSection<GeneratedFoundation>(
      makeModel(foundationResponseSchema),
      foundationPrompt,
      "[build-destination:foundation]"
    );
  } catch (err) {
    if (err instanceof GeminiOverloadedError) {
      return NextResponse.json(
        { error: err.message, details: describeGeminiError(err.cause) },
        { status: 503 }
      );
    }
    const message = err instanceof Error ? err.message : "Unknown error";
    console.error("[build-destination] foundation generation failed:", err);
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
      state: stateHint || foundation.state,
      tagline: foundation.tagline,
      description: foundation.description,
      best_time_to_visit: foundation.best_time_to_visit,
      ideal_trip_days_min: foundation.ideal_trip_days_min,
      ideal_trip_days_max: foundation.ideal_trip_days_max,
      history_culture: foundation.history_culture,
      month_notes: foundation.month_notes,
      best_months: foundation.best_months,
      okay_months: foundation.okay_months,
      avoid_months: foundation.avoid_months,
      latitude: foundation.latitude,
      longitude: foundation.longitude,
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
  const finalState = stateHint || foundation.state;

  // ---------------------------------------------------------------------
  // Step 2: the 5 heavy section calls, all in flight at once. Promise.
  // allSettled (not Promise.all) so one section failing — e.g. Gemini
  // overloaded on just the hotels call — doesn't take down the sections
  // that succeeded; each branch still goes through generateContentWithRetry
  // individually.
  // ---------------------------------------------------------------------
  const attractionsPrompt = `You are a travel content expert for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Generate up to 8 real, well-known attractions/sights near ${name}, ${finalState}, India, as a JSON object shaped { "attractions": [...] }. Only include genuinely real, notable attractions — fewer than 8 is fine if that's all that genuinely exist. All costs must be in Indian Rupees (numbers only, no currency symbols). Return ONLY the JSON object, no markdown, no explanation.`;

  const hotelsPrompt = `You are a travel content expert for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Generate up to 5 realistic hotels or stays in/near ${name}, ${finalState}, India, spanning budget to luxury, as a JSON object shaped { "hotels": [...] }. Set warning_flag true only if there's a genuine, common practical caveat for that property (e.g. remote location or seasonal closure), otherwise false with warning_reason as an empty string. All costs must be in Indian Rupees (numbers only, no currency symbols). Return ONLY the JSON object, no markdown, no explanation.`;

  const activitiesPrompt = `You are a travel content expert for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Generate up to 8 things travellers can do in/near ${name}, ${finalState}, India, as a JSON object shaped { "activities": [...] }. All costs must be in Indian Rupees (numbers only, no currency symbols). Return ONLY the JSON object, no markdown, no explanation.`;

  const templesPrompt = `You are a travel content expert for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Generate up to 5 temples at or near ${name}, ${finalState}, India — but ONLY temples that are genuinely famous at a district, state, or national level, as a JSON object shaped { "temples": [...] }. If ${name} has fewer than 5 such famous temples, return fewer (even zero) — do not invent or pad with generic/minor temples that aren't actually notable. For each temple set temple_stay_available honestly, and stay_details/stay_price_min/stay_price_max to empty string / 0 / 0 when no temple stay is offered. All costs must be in Indian Rupees (numbers only, no currency symbols). Return ONLY the JSON object, no markdown, no explanation.`;

  const howToReachPrompt = `You are a travel content expert for TripSense AI, an Indian travel planning app used mainly by travellers from Hyderabad.

Generate exactly 4 entries, one each for mode "road", "train", "air", and "bus", describing how to reach ${name}, ${finalState} from Hyderabad specifically, as a JSON object shaped { "how_to_reach": [...] }. Use real highway/route references and real nearby airports/stations where possible. Return ONLY the JSON object, no markdown, no explanation.`;

  const [attractionsOutcome, hotelsOutcome, activitiesOutcome, templesOutcome, howToReachOutcome] =
    await Promise.allSettled([
      runSection<{ attractions: GeneratedAttraction[] }>(
        makeModel(attractionsResponseSchema), attractionsPrompt, "[build-destination:attractions]"
      ),
      runSection<{ hotels: GeneratedHotel[] }>(
        makeModel(hotelsResponseSchema), hotelsPrompt, "[build-destination:hotels]"
      ),
      runSection<{ activities: GeneratedActivity[] }>(
        makeModel(activitiesResponseSchema), activitiesPrompt, "[build-destination:activities]"
      ),
      runSection<{ temples: GeneratedTemple[] }>(
        makeModel(templesResponseSchema), templesPrompt, "[build-destination:temples]"
      ),
      runSection<{ how_to_reach: GeneratedHowToReach[] }>(
        makeModel(howToReachResponseSchema), howToReachPrompt, "[build-destination:how_to_reach]"
      ),
    ]);

  // From here on, the destination row exists and is reachable at its slug —
  // every remaining step is best-effort. Each section's generation and
  // insert is isolated so one failure (a Gemini overload on one section, or
  // a DB constraint rejecting another) can't take down sections that
  // already succeeded.
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

  let insertedHotels: { id: string; name: string }[] | null = null;

  // ---------------------------------------------------------------------
  // Step 3: insert whatever generation produced, also in parallel. A
  // section whose generation call was rejected above is recorded as a
  // generation error here and simply skipped — there's nothing to insert.
  // ---------------------------------------------------------------------
  const insertAttractions = async () => {
    if (attractionsOutcome.status === "rejected") {
      results.attractions = { error: errorMessage(attractionsOutcome.reason) };
      return;
    }
    try {
      const attractions = attractionsOutcome.value.attractions;
      const { error } = await supabase.from("attractions").insert(
        attractions.map((a, i) => ({ ...a, destination_id: destinationId, sort_order: i + 1 }))
      );
      if (error) throw new Error(error.message);
      results.attractions = { count: attractions.length };
    } catch (err) {
      console.error("[build-destination] attractions insert failed:", err);
      results.attractions = { error: errorMessage(err) };
    }
  };

  const insertHotels = async () => {
    if (hotelsOutcome.status === "rejected") {
      results.hotels = { error: errorMessage(hotelsOutcome.reason) };
      return;
    }
    try {
      const hotels = hotelsOutcome.value.hotels;
      const { data, error } = await supabase
        .from("hotels")
        .insert(
          hotels.map((h) => ({
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
      results.hotels = { count: hotels.length };
    } catch (err) {
      console.error("[build-destination] hotels insert failed:", err);
      results.hotels = { error: errorMessage(err) };
    }
  };

  const insertActivities = async () => {
    if (activitiesOutcome.status === "rejected") {
      results.activities = { error: errorMessage(activitiesOutcome.reason) };
      return;
    }
    try {
      const activities = activitiesOutcome.value.activities;
      const { error } = await supabase.from("activities").insert(
        activities.map((a, i) => ({ ...a, destination_id: destinationId, sort_order: i + 1 }))
      );
      if (error) throw new Error(error.message);
      results.activities = { count: activities.length };
    } catch (err) {
      console.error("[build-destination] activities insert failed:", err);
      results.activities = { error: errorMessage(err) };
    }
  };

  const insertTemples = async () => {
    if (templesOutcome.status === "rejected") {
      results.temples = { error: errorMessage(templesOutcome.reason) };
      return;
    }
    try {
      const temples = templesOutcome.value.temples;
      if (temples.length > 0) {
        const { error } = await supabase.from("temples").insert(
          temples.map((t, i) => ({ ...t, destination_id: destinationId, sort_order: i + 1 }))
        );
        if (error) throw new Error(error.message);
      }
      results.temples = { count: temples.length };
    } catch (err) {
      console.error("[build-destination] temples insert failed:", err);
      results.temples = { error: errorMessage(err) };
    }
  };

  const insertHowToReach = async () => {
    if (howToReachOutcome.status === "rejected") {
      results.howToReach = { error: errorMessage(howToReachOutcome.reason) };
      return;
    }
    try {
      const howToReach = howToReachOutcome.value.how_to_reach;
      const { error } = await supabase.from("how_to_reach").insert(
        howToReach.map((r) => ({ ...r, destination_id: destinationId }))
      );
      if (error) throw new Error(error.message);
      results.howToReach = { count: howToReach.length };
    } catch (err) {
      console.error("[build-destination] how_to_reach insert failed:", err);
      results.howToReach = { error: errorMessage(err) };
    }
  };

  await Promise.allSettled([
    insertAttractions(),
    insertHotels(),
    insertActivities(),
    insertTemples(),
    insertHowToReach(),
  ]);

  // Best-effort: enrich the newly-inserted hotels with real Google ratings/
  // contact info. Capped at 5 (== the hotel count Gemini generates at most)
  // to bound Places API quota per destination build; skipped entirely if no
  // key is configured, same "log and continue" pattern as the Unsplash/
  // YouTube keys in sync-media. Informational only — not part of `results`,
  // since a hotel row without enrichment is still a perfectly usable hotel.
  // Stays sequential: it depends on hotel rows already existing in the DB.
  let placesEnriched = 0;
  if (!process.env.GOOGLE_PLACES_API_KEY) {
    console.warn(
      "[build-destination] GOOGLE_PLACES_API_KEY is not set — skipping hotel enrichment."
    );
  } else if (insertedHotels) {
    try {
      const cityName = `${name} ${stateHint ?? ""}`.trim();
      for (const hotel of (insertedHotels as { id: string; name: string }[]).slice(0, 5)) {
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

  // Also sequential: it reads the attractions/temples rows back from the DB,
  // so it has to run after the parallel inserts above have landed.
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
