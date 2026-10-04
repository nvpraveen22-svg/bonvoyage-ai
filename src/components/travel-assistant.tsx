"use client";

import { useEffect, useRef, useState } from "react";
import { Send, ChevronDown, ChevronUp, Maximize2, Minimize2 } from "lucide-react";
import { cn } from "@/lib/utils";

interface Message {
  role: "user" | "assistant";
  text: string;
}

// Gemini's replies use plain-text markdown (**bold**, "* " bullets) per the
// prompt in src/app/api/travel-assistant/route.ts, but were rendering as
// literal asterisks since the bubble just dumped msg.text as text. This is a
// small hand-rolled renderer rather than a markdown library for the couple
// of constructs that actually show up, given the system prompt doesn't ask
// for anything richer (headings, links, numbered lists, code).
//
// Safe against injected HTML/script: renderInline escapes &/</> on the raw
// line *before* turning **/* into tags, so dangerouslySetInnerHTML only ever
// sees entities plus the <strong>/<em> this function added itself - there's
// no way for a crafted chat message (or a prompt-injected Gemini reply) to
// get a real tag through.
function MarkdownText({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <div className="flex flex-col gap-1">
      {lines.map((line, i) => {
        const bulletMatch = line.match(/^(\s*)\*\s+(.+)$/);
        if (bulletMatch) {
          const indent = bulletMatch[1].length > 0;
          return (
            <div key={i} className={cn("flex gap-1.5", indent && "pl-4")}>
              <span className="mt-1 size-1.5 shrink-0 rounded-full bg-current opacity-60" />
              <span dangerouslySetInnerHTML={{ __html: renderInline(bulletMatch[2]) }} />
            </div>
          );
        }
        if (!line.trim()) return <div key={i} className="h-1" />;
        return <p key={i} dangerouslySetInnerHTML={{ __html: renderInline(line) }} />;
      })}
    </div>
  );
}

function renderInline(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/\*(.+?)\*/g, "<em>$1</em>");
}

const SUGGESTIONS = [
  "Places near Hyderabad within 150km for a day trip",
  "Best family destinations in Kerala with less crowd",
  "Hill stations near Bangalore to visit in monsoon",
  "Beach destinations in Goa good for families",
];

const GREETING =
  "Hi! I'm your TripSense AI travel assistant 🧭 Ask me anything — nearby destinations, hidden gems, family trips, restaurants, hotels — I'll help you plan the perfect trip!";

interface TravelAssistantProps {
  // True for the fixed bottom-right widget on desktop (src/app/page.tsx),
  // which owns its own position/size/expand chrome; false (default) for the
  // plain inline card rendered on mobile, which just fills its container -
  // there's nothing to "float" or "expand into" on a small screen, hence the
  // expand button itself only ever renders for the floating instance.
  floating?: boolean;
}

export function TravelAssistant({ floating = false }: TravelAssistantProps = {}) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState("");
  const [collapsed, setCollapsed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Also re-run on collapsed: the message list unmounts while collapsed
    // (see the early return below), so re-expanding needs to jump back to
    // the bottom rather than land wherever a fresh mount defaults to.
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, collapsed]);

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
    <div
      className={cn(
        "flex flex-col gap-2 overflow-hidden rounded-2xl border border-border bg-background shadow-2xl",
        // The floating instance owns its own positioning (fixed/size/z-index)
        // instead of a wrapper div doing it, since those now need to change
        // with `expanded` - a parent wrapper can't react to this component's
        // own state. `hidden md:flex` keeps it off mobile entirely (display:
        // none makes the unprefixed position/size below irrelevant there);
        // `md:flex` (not md:block) because this div is already a flex column
        // for its own header/body/footer internally.
        floating && "hidden md:flex fixed z-50 transition-all duration-300",
        floating && (expanded ? "bottom-0 right-0 h-[85vh] w-full max-w-2xl" : "bottom-6 right-4 w-80")
      )}
    >
      {/* Orange -> pink rather than the app's primary/secondary (orange/green)
          tokens: those are complementary hues and muddy to brown mid-gradient,
          which only shows up clearly on a wide solid band like this header. */}
      <div className="flex items-center justify-between gap-3 bg-gradient-to-r from-orange-500 to-pink-500 px-4 py-3">
        <div className="flex items-center gap-3">
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
        <div className="flex shrink-0 items-center gap-1">
          {floating && (
            <button
              onClick={() => {
                // Expanding from the collapsed (header-only) state should
                // show the panel too, rather than expand into an invisible
                // body - collapsed+expanded together would be a pointless,
                // confusing combination to allow.
                setCollapsed(false);
                setExpanded((e) => !e);
              }}
              aria-label={expanded ? "Exit fullscreen" : "Expand to fullscreen"}
              className="hidden rounded-full p-1 text-white/90 transition-colors hover:bg-white/20 md:flex"
            >
              {expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
            </button>
          )}
          <button
            onClick={() => setCollapsed((c) => !c)}
            aria-label={collapsed ? "Expand chat" : "Collapse chat"}
            className="rounded-full p-1 text-white/90 transition-colors hover:bg-white/20"
          >
            {collapsed ? <ChevronUp className="size-5" /> : <ChevronDown className="size-5" />}
          </button>
        </div>
      </div>

      {!collapsed && (
        <>
          <div className={cn("space-y-3 overflow-y-auto p-4", expanded ? "flex-1" : "max-h-64")}>
            {messages.map((msg, i) => (
              <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
                <div
                  className={cn(
                    "max-w-[80%] rounded-2xl px-4 py-2 text-sm",
                    msg.role === "user"
                      ? "whitespace-pre-wrap rounded-br-sm bg-primary text-primary-foreground"
                      : "rounded-bl-sm bg-muted text-foreground"
                  )}
                >
                  {msg.role === "assistant" ? <MarkdownText text={msg.text} /> : msg.text}
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
        </>
      )}
    </div>
  );
}
