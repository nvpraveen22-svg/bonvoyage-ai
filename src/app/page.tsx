"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import Image from "next/image";
import { MapPin, Compass, Sparkles, ArrowRight } from "lucide-react";
import { supabase } from "@/lib/supabase";
import type { Destination } from "@/types";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Card, CardContent } from "@/components/ui/card";
import { TravelAssistant } from "@/components/travel-assistant";

export default function Home() {
  const router = useRouter();
  const [destinations, setDestinations] = useState<Destination[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadDestinations() {
      setLoading(true);
      setError(null);
      const { data, error: fetchError } = await supabase
        .from("destinations")
        .select("*")
        .eq("is_active", true)
        .order("name", { ascending: true });

      if (cancelled) return;

      if (fetchError) {
        setError("We couldn't load destinations. Please try again.");
        setDestinations([]);
      } else {
        setDestinations(data ?? []);
      }
      setLoading(false);
    }

    loadDestinations();
    return () => {
      cancelled = true;
    };
  }, []);

  function handleSelect(slug: string) {
    setSelectedSlug(slug);
    const params = new URLSearchParams({ origin: "Hyderabad" });
    router.push(`/destination/${slug}?${params.toString()}`);
  }

  return (
    <div className="flex min-h-screen flex-col bg-background">
      <header className="sticky top-0 z-10 border-b border-border bg-background/95 backdrop-blur">
        <div className="mx-auto flex max-w-7xl items-center gap-2 px-4 py-4 sm:px-6 lg:px-8">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground">
            <MapPin className="size-5" strokeWidth={2.5} />
          </span>
          <div>
            <h1 className="font-heading text-lg font-semibold leading-tight text-foreground">
              TripSense AI
            </h1>
            <p className="text-xs text-muted-foreground">
              Smart trip planning for India
            </p>
          </div>
        </div>
      </header>

      <main className="mx-auto flex w-full max-w-7xl flex-1 flex-col gap-6 px-4 py-6 sm:px-6 lg:px-8">
        <section className="flex flex-col gap-1.5">
          <div className="flex items-center gap-1.5 text-secondary">
            <Sparkles className="size-4" />
            <span className="text-xs font-medium uppercase tracking-wide">
              Plan your next journey
            </span>
          </div>
          <h2 className="text-2xl font-semibold text-foreground">
            Where do you want to go?
          </h2>
          <p className="text-sm text-muted-foreground">
            Pick a destination and we&apos;ll help you plan attractions, stays,
            and an AI-crafted itinerary.
          </p>
        </section>

        <Card>
          <CardContent className="flex flex-col gap-5 pt-1">
            <div className="flex flex-col gap-1.5">
              <Label htmlFor="destination-select">Destination</Label>
              {loading ? (
                <Skeleton className="h-9 w-full rounded-lg" />
              ) : error ? (
                <Alert variant="destructive">
                  <AlertTitle>Something went wrong</AlertTitle>
                  <AlertDescription>{error}</AlertDescription>
                </Alert>
              ) : destinations.length === 0 ? (
                <Alert>
                  <AlertTitle>No destinations yet</AlertTitle>
                  <AlertDescription>
                    Check back soon — we&apos;re adding destinations.
                  </AlertDescription>
                </Alert>
              ) : (
                <Select
                  value={selectedSlug ?? undefined}
                  onValueChange={(value) => {
                    if (typeof value === "string") handleSelect(value);
                  }}
                >
                  <SelectTrigger id="destination-select" className="w-full">
                    <SelectValue placeholder="Choose a destination" />
                  </SelectTrigger>
                  <SelectContent>
                    {destinations.map((destination) => (
                      <SelectItem key={destination.id} value={destination.slug}>
                        <div className="flex flex-col">
                          <span>{destination.name}</span>
                          {destination.state && (
                            <span className="text-xs text-muted-foreground">
                              {destination.state}
                            </span>
                          )}
                        </div>
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
            </div>
          </CardContent>
        </Card>

        {!loading && !error && destinations.length > 0 && (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-1.5 text-muted-foreground">
              <Compass className="size-4" />
              <span className="text-xs font-medium uppercase tracking-wide">
                Popular destinations
              </span>
            </div>
            <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {destinations.map((destination) => (
                <button
                  key={destination.id}
                  onClick={() => handleSelect(destination.slug)}
                  className="group flex flex-col overflow-hidden rounded-xl bg-card text-left ring-1 ring-foreground/10 transition-all hover:scale-[1.02] hover:shadow-lg"
                >
                  <div className="relative h-[140px] w-full shrink-0 overflow-hidden sm:h-[180px]">
                    {destination.cover_image_url ? (
                      <Image
                        src={destination.cover_image_url}
                        alt={destination.name}
                        fill
                        sizes="200px"
                        className="object-cover transition-transform duration-300 group-hover:scale-105"
                      />
                    ) : (
                      <div className="h-full w-full bg-gradient-to-br from-primary to-secondary" />
                    )}
                    <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-black/0 to-transparent" />
                    {destination.state && (
                      <span className="absolute left-1.5 top-1.5 rounded-full bg-white/90 px-2 py-0.5 text-[10px] font-medium text-foreground shadow-sm">
                        {destination.state}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center justify-between gap-1 p-2.5">
                    <div className="flex flex-col gap-0.5 overflow-hidden">
                      <span className="truncate text-sm font-medium text-foreground">
                        {destination.name}
                      </span>
                      {destination.tagline && (
                        <span className="truncate text-xs text-muted-foreground">
                          {destination.tagline}
                        </span>
                      )}
                    </div>
                    <ArrowRight className="size-3.5 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* Desktop gets the assistant as a floating panel (below); on mobile
            there's no room to float it, so it stays inline at the bottom. */}
        <div className="md:hidden">
          <TravelAssistant />
        </div>
      </main>

      {/* Floating AI Assistant - right side. No wrapper div here: the
          component owns its own fixed position/size (including the
          expanded/fullscreen state), since a plain wrapper can't react to
          state that lives inside its child. */}
      <TravelAssistant floating />
    </div>
  );
}
