import { NextRequest, NextResponse } from "next/server";

export const runtime = "nodejs";

// Resolves a lat/lng to a human-readable place name server-side, so the
// Google Places key never reaches the browser - unlike a client-side call
// straight to Google's Geocoding API, which would expose it in the page
// bundle and every request URL for anyone to lift from devtools. Used by the
// travel assistant to label the visitor's detected location; best-effort
// only, never blocks the chat if it fails.
const PLACE_TYPE_PRIORITY = [
  "locality",
  "sublocality",
  "administrative_area_level_2",
  "administrative_area_level_1",
];

interface AddressComponent {
  long_name: string;
  types: string[];
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const lat = searchParams.get("lat");
  const lon = searchParams.get("lon");
  if (!lat || !lon) {
    return NextResponse.json({ error: "lat and lon are required." }, { status: 400 });
  }

  const apiKey = process.env.GOOGLE_PLACES_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ place: null });
  }

  const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=${encodeURIComponent(lat)},${encodeURIComponent(lon)}&key=${apiKey}`;

  try {
    const res = await fetch(url);
    const data = await res.json();

    if (data.status && data.status !== "OK") {
      if (data.status !== "ZERO_RESULTS") {
        console.error(
          `[reverse-geocode] Google returned status ${data.status}:`,
          data.error_message ?? "(no message)"
        );
      }
      return NextResponse.json({ place: null });
    }

    const components = (data.results?.[0]?.address_components ?? []) as AddressComponent[];
    // Prefer the most specific label a visitor would recognize, falling back
    // to broader ones for places (hill stations, villages) Google doesn't
    // tag with a "locality".
    let place: string | null = null;
    for (const type of PLACE_TYPE_PRIORITY) {
      const match = components.find((c) => c.types.includes(type));
      if (match) {
        place = match.long_name;
        break;
      }
    }

    return NextResponse.json({ place });
  } catch (err) {
    console.error("[reverse-geocode] request failed:", err);
    return NextResponse.json({ place: null });
  }
}
