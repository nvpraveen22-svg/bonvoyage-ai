import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Legacy Places Autocomplete (same API family as src/lib/google-places.ts).
// Deliberately no `types` restriction: the old "(cities)" collection would
// exclude hill stations, villages, and other non-locality places (Horsley
// Hills, Lepakshi, ...) that are exactly what this admin tool needs to find.
// `components=country:in` is the only filter, so any Indian place is eligible.
const AUTOCOMPLETE_URL = "https://maps.googleapis.com/maps/api/place/autocomplete/json";

interface PlacePrediction {
  description: string;
  place_id: string;
  structured_formatting?: { main_text?: string };
}

export async function GET(request: NextRequest) {
  const adminPin = process.env.ADMIN_PIN;
  if (!adminPin) {
    return NextResponse.json({ error: "Admin access is not configured." }, { status: 503 });
  }
  // Sent as a header rather than a query param so it doesn't end up sitting
  // in server access logs or browser history, matching the PIN handling on
  // every other admin route (just over a header here since this is GET).
  if (request.headers.get("x-admin-pin") !== adminPin) {
    return NextResponse.json({ error: "Incorrect PIN." }, { status: 401 });
  }

  const { searchParams } = new URL(request.url);
  const input = searchParams.get("input")?.trim() ?? "";
  if (input.length < 2) {
    return NextResponse.json({ suggestions: [] });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    console.warn("[places-autocomplete] GOOGLE_PLACES_API_KEY is not set.");
    return NextResponse.json(
      { error: "Destination search is not configured.", suggestions: [] },
      { status: 503 }
    );
  }

  const url = `${AUTOCOMPLETE_URL}?input=${encodeURIComponent(input)}&components=country:in&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    // The legacy API returns HTTP 200 even on auth/quota failure, with the
    // real outcome in `status` - only OK and ZERO_RESULTS carry predictions.
    if (data.status && data.status !== "OK" && data.status !== "ZERO_RESULTS") {
      console.error(
        `[places-autocomplete] Google returned status ${data.status}:`,
        data.error_message ?? "(no message)"
      );
      return NextResponse.json({ suggestions: [] });
    }

    const predictions = (data.predictions ?? []) as PlacePrediction[];
    const suggestions = predictions
      .filter((p) => p.place_id && (p.structured_formatting?.main_text || p.description))
      .map((p) => ({
        name: p.structured_formatting?.main_text ?? p.description,
        fullName: p.description,
        placeId: p.place_id,
      }));

    return NextResponse.json({ suggestions });
  } catch (err) {
    console.error("[places-autocomplete] request failed:", err);
    return NextResponse.json({ suggestions: [] });
  }
}
