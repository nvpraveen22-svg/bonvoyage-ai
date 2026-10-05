// Core domain types for BonVoyage AI, mirroring the live Supabase schema.

export interface Destination {
  id: string;
  name: string;
  slug: string;
  state: string;
  tagline: string | null;
  description: string | null;
  best_time_to_visit: string | null;
  ideal_trip_days_min: number | null;
  ideal_trip_days_max: number | null;
  latitude: number | null;
  longitude: number | null;
  cover_image_url: string | null;
  hero_url: string | null;
  status: string | null;
  last_updated: string;
  created_at: string;
  best_months: string[] | null;
  okay_months: string[] | null;
  avoid_months: string[] | null;
  month_notes: string | null; // JSON-encoded {"range label": "note"}, stored as text
  history_culture: string | null;
  is_active: boolean;
}

export interface Attraction {
  id: string;
  destination_id: string;
  name: string;
  category: string | null;
  description: string | null;
  distance_from_center_km: number | null;
  entry_fee_adult: number | null;
  entry_fee_child: number | null;
  timings: string | null;
  duration_hours: number | null;
  family_friendly: boolean | null;
  photo_url: string | null;
  google_place_id: string | null;
  google_rating: number | null;
  places_enriched_at: string | null;
  rating: number | null;
  sort_order: number | null;
  created_at: string;
}

export interface Temple {
  id: string;
  destination_id: string;
  name: string;
  deity: string | null;
  description: string | null;
  distance_from_center_km: number | null;
  timings: string | null;
  dress_code: string | null;
  entry_fee: number | null;
  temple_stay_available: boolean | null;
  stay_details: string | null;
  stay_price_min: number | null;
  stay_price_max: number | null;
  booking_contact: string | null;
  photo_url: string | null;
  google_place_id: string | null;
  google_rating: number | null;
  places_enriched_at: string | null;
  sort_order: number | null;
  created_at: string;
}

export type TransportMode = "road" | "train" | "air" | "bus";

export interface HowToReach {
  id: string;
  destination_id: string;
  mode: TransportMode;
  description: string | null;
  distance_from_hyderabad_km: number | null;
  duration_from_hyderabad: string | null;
  nearest_airport: string | null;
  nearest_railway_station: string | null;
  tips: string | null;
  created_at: string;
}

export interface Hotel {
  id: string;
  destination_id: string;
  name: string;
  stars: number | null;
  rating: number | null;
  rating_period: string | null;
  price_min: number | null;
  price_max: number | null;
  address: string | null;
  amenities: string[] | null;
  ai_summary: string | null;
  complaints: string[] | null;
  warning_flag: boolean | null;
  warning_reason: string | null;
  google_place_id: string | null;
  google_rating: number | null;
  google_reviews_count: number | null;
  phone: string | null;
  website: string | null;
  places_enriched_at: string | null;
  booking_url: string | null;
  photo_url: string | null;
  created_at: string;
}

export interface Activity {
  id: string;
  destination_id: string;
  name: string;
  category: string | null;
  description: string | null;
  duration_hours: number | null;
  price_per_person: number | null;
  family_friendly: boolean | null;
  age_restriction: string | null;
  operator_name: string | null;
  booking_required: boolean | null;
  photo_url: string | null;
  sort_order: number | null;
  created_at: string;
}

export type MediaType = "image" | "video";

export interface Media {
  id: string;
  destination_id: string;
  media_type: MediaType;
  title: string | null;
  url: string;
  thumbnail_url: string | null;
  author: string | null;
  duration_seconds: number | null;
  view_count: number | null;
  published_at: string | null;
  created_at: string;
}

export interface ItineraryDaySlot {
  time_of_day: "morning" | "afternoon" | "evening";
  activity: string;
  notes?: string;
}

export interface ItineraryDay {
  day: number;
  title: string;
  slots: ItineraryDaySlot[];
}

export interface ItineraryPlan {
  days: ItineraryDay[];
  summary?: string;
}

export interface AiItinerary {
  id: string;
  destination_id: string;
  days_count: number | null;
  trip_type: string | null;
  plan_json: ItineraryPlan | null;
  highlights: string[] | null;
  generated_at: string;
}

export interface InsightHotelReview {
  name: string;
  pros: string[];
  cons: string[];
  verdict: string;
  bookInAdvance: boolean;
  bookInAdvanceNote?: string;
}

export interface InsightActivityTag {
  name: string;
  reason: string;
  familyFriendly: boolean;
  realPricing?: string;
}

export interface AiInsightsContent {
  stayRecommendations: InsightHotelReview[];
  activities: {
    mustDo: InsightActivityTag[];
    optional: InsightActivityTag[];
    skip: InsightActivityTag[];
  };
  practicalWarnings: string[];
  budgetRealityCheck: {
    realistic: boolean;
    verdict: string;
    costSpikes: string[];
  };
  localTips: string[];
}

export interface AiInsights {
  id: string;
  destination_id: string;
  content: string; // JSON-stringified AiInsightsContent | AiSeasonalContent
  generated_at: string;
  prompt_version: number;
  type: "general" | "seasonal";
}

export type SeasonalRecommendation = "go_now" | "wait" | "book_ahead";

export interface AiSeasonalContent {
  recommendation: SeasonalRecommendation;
  recommendationReason: string;
  upcomingEvents: { name: string; timing: string }[];
  currentSeasonTips: string[];
  openNow: string[];
  closedNow: string[];
}

export interface RoadEstimate {
  distance_km: number;
  drive_hours: number;
  fuel_cost_min: number;
  fuel_cost_max: number;
  toll_estimate: number;
  best_route: string;
  rest_stops: string[];
  tips: string;
}

export interface RailEstimate {
  journey_hours_min: number;
  journey_hours_max: number;
  sleeper_fare_min: number;
  sleeper_fare_max: number;
  ac3_fare_min: number;
  ac3_fare_max: number;
  ac2_fare_min: number;
  ac2_fare_max: number;
  popular_trains: string[];
  nearest_station_destination: string;
  tips: string;
}

export interface FlightEstimate {
  duration_hours_min: number;
  duration_hours_max: number;
  economy_fare_min: number;
  economy_fare_max: number;
  nearest_airport_origin: string;
  nearest_airport_destination: string;
  airlines: string[];
  tips: string;
}

export interface TravelEstimate {
  id: string;
  destination_id: string;
  origin_city: string;
  road_json: RoadEstimate;
  rail_json: RailEstimate;
  flight_json: FlightEstimate;
  generated_at: string;
}

export interface AiRoadRoute {
  origin_city: string;
  distance_km: number;
  drive_hours: number;
  best_route: string;
  rest_stops: string[];
  tips: string;
}

export interface TollRoute {
  id: string;
  destination_id: string;
  origin_city: string;
  distance_km: number | null;
  toll_estimate_rs: number | null;
  route_description: string | null;
  via_cities: string[] | null;
  created_at: string;
}

interface TableDef<Row> {
  Row: Row;
  Insert: Partial<Row>;
  Update: Partial<Row>;
  Relationships: [];
}

// Supabase generated-style Database type for typed client usage.
export interface Database {
  public: {
    Tables: {
      destinations: TableDef<Destination>;
      attractions: TableDef<Attraction>;
      temples: TableDef<Temple>;
      how_to_reach: TableDef<HowToReach>;
      hotels: TableDef<Hotel>;
      activities: TableDef<Activity>;
      media: TableDef<Media>;
      ai_itineraries: TableDef<AiItinerary>;
      toll_routes: TableDef<TollRoute>;
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
}
