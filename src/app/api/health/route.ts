import { NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";

export const runtime = "nodejs";
// Must stay dynamic: a statically rendered handler would serve a cached body
// to the keep-alive cron and never actually reach Postgres.
export const dynamic = "force-dynamic";

export async function GET() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  if (!url || !anonKey) {
    return NextResponse.json(
      { status: "error", database: "unconfigured" },
      { status: 503 }
    );
  }

  const supabase = createClient(url, anonKey, {
    auth: { persistSession: false },
  });

  // A real round-trip to Postgres — this is what keeps a free-tier project
  // from being paused for inactivity. head:true skips sending any rows back.
  const { error, count } = await supabase
    .from("destinations")
    .select("id", { count: "exact", head: true });

  if (error) {
    return NextResponse.json(
      { status: "error", database: "unreachable", message: error.message },
      { status: 503 }
    );
  }

  return NextResponse.json({
    status: "ok",
    database: "reachable",
    destinations: count ?? 0,
    checkedAt: new Date().toISOString(),
  });
}
