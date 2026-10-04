"use client";

import { useEffect, useRef, useState } from "react";
import { Send } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  text: string;
}

const SUGGESTIONS = [
  "Places near Hyderabad within 150km for a day trip",
  "Best family destinations in Kerala with less crowd",
  "Hill stations near Bangalore to visit in monsoon",
  "Beach destinations in Goa good for families",
];

const GREETING =
  "Hi! I'm your TripSense AI travel assistant 🧭 Ask me anything — nearby destinations, hidden gems, family trips, restaurants, hotels — I'll help you plan the perfect trip!";

export function TravelAssistant() {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState("");
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Best-effort: detect the visitor's city via browser geolocation, then
  // resolve it to a name through our own server route (see
  // src/app/api/reverse-geocode) rather than calling Google directly from
  // here, which would put the Places key in the page bundle. Silently does
  // nothing on denial/failure - the assistant works fine without it.
  useEffect(() => {
    if (!navigator.geolocation) return;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          const { latitude, longitude } = pos.coords;
          const res = await fetch(`/api/reverse-geocode?lat=${latitude}&lon=${longitude}`);
          const data = await res.json();
          if (data.place) setUserLocation(data.place);
        } catch {
          // Ignore - detection is a nice-to-have, not required to chat.
        }
      },
      () => {
        // Permission denied or unavailable - nothing to do.
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 10 * 60 * 1000 }
    );
  }, []);

  async function sendMessage(text: string) {
    if (!text.trim() || loading) return;

    setMessages((prev) => [...prev, { role: "user", text }]);
    setInput("");
    setLoading(true);

    try {
      const res = await fetch("/api/travel-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ message: text, userLocation }),
      });
      const data = await res.json();
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: data.reply || data.error || "Sorry, I couldn't get a response." },
      ]);
    } catch {
      setMessages((prev) => [
        ...prev,
        { role: "assistant", text: "Something went wrong. Please try again." },
      ]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-border bg-card shadow-lg">
      {/* Orange -> pink rather than the app's primary/secondary (orange/green)
          tokens: those are complementary hues and muddy to brown mid-gradient,
          which only shows up clearly on a wide solid band like this header. */}
      <div className="flex items-center gap-3 bg-gradient-to-r from-orange-500 to-pink-500 px-4 py-3">
        <span className="text-2xl">🧭</span>
        <div>
          <h3 className="font-heading font-semibold text-white">
            TripSense AI Assistant
          </h3>
          <p className="text-xs text-white/80">
            {userLocation ? `📍 Detected: ${userLocation}` : "Ask me anything about travel in India"}
          </p>
        </div>
      </div>

      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {messages.map((msg, i) => (
          <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] whitespace-pre-wrap rounded-2xl px-4 py-2 text-sm",
                msg.role === "user"
                  ? "rounded-br-sm bg-primary text-primary-foreground"
                  : "rounded-bl-sm bg-muted text-foreground"
              )}
            >
              {msg.text}
            </div>
          </div>
        ))}
        {loading && (
          <div className="flex justify-start">
            <div className="rounded-2xl rounded-bl-sm bg-muted px-4 py-2">
              <div className="flex gap-1">
                <div className="size-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: "0ms" }} />
                <div className="size-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: "150ms" }} />
                <div className="size-2 animate-bounce rounded-full bg-muted-foreground/60" style={{ animationDelay: "300ms" }} />
              </div>
            </div>
          </div>
        )}
        <div ref={bottomRef} />
      </div>

      {messages.length === 1 && (
        <div className="flex flex-wrap gap-2 px-4 pb-2">
          {SUGGESTIONS.map((s) => (
            <button
              key={s}
              onClick={() => sendMessage(s)}
              className="rounded-full border border-border bg-accent px-3 py-1 text-xs text-accent-foreground transition-colors hover:bg-accent/70"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className="flex gap-2 border-t border-border p-3">
        <input
          type="text"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && sendMessage(input)}
          placeholder="Ask about destinations, hotels, restaurants..."
          aria-label="Ask a travel question"
          disabled={loading}
          className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
        />
        <button
          onClick={() => sendMessage(input)}
          disabled={loading || !input.trim()}
          aria-label="Send message"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <Send className="size-4" />
        </button>
      </div>
    </div>
  );
}
