"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { Send, ChevronDown, Maximize2, Minimize2, MessageCircle, X } from "lucide-react";
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
  "Hi! I'm your BonVoyage AI travel assistant 🧭 Ask me anything — nearby destinations, hidden gems, family trips, restaurants, hotels — I'll help you plan the perfect trip!";

interface ChatBodyProps {
  messages: Message[];
  loading: boolean;
  input: string;
  onInputChange: (value: string) => void;
  onSend: (text: string) => void;
  bottomRef: RefObject<HTMLDivElement>;
  messagesAreaClassName?: string;
  inputRowClassName?: string;
}

// Shared by both the desktop floating panel and the mobile bottom sheet
// below, so the two can't drift out of sync - same message bubbles, same
// suggestions, same input row, just wrapped in different shells (and each
// given its own bottomRef: both shells are mounted at once, CSS-toggled by
// breakpoint rather than conditionally rendered, so a single shared ref
// would only ever point at whichever one rendered last).
function ChatBody({
  messages,
  loading,
  input,
  onInputChange,
  onSend,
  bottomRef,
  messagesAreaClassName,
  inputRowClassName,
}: ChatBodyProps) {
  return (
    <>
      <div
        className={cn(
          // min-h-0: a flex child defaults to min-height:auto, which refuses
          // to shrink below its content's natural height - without this, a
          // flex-1 message area (the mobile sheet always; the desktop panel
          // when expanded) can end up taller than its available space rather
          // than actually clipping+scrolling. overscroll-contain stops a
          // scroll gesture that reaches the top/bottom from "chaining" into
          // scrolling the page behind it, a common cause of nested scroll
          // areas feeling unresponsive on mobile.
          "min-h-0 space-y-3 overflow-y-auto overscroll-contain p-4",
          messagesAreaClassName
        )}
      >
        {messages.map((msg, i) => (
          <div key={i} className={cn("flex", msg.role === "user" ? "justify-end" : "justify-start")}>
            <div
              className={cn(
                "max-w-[80%] overflow-hidden rounded-2xl px-4 py-2 text-sm",
                msg.role === "user"
                  ? "whitespace-pre-wrap break-words rounded-br-sm bg-primary text-primary-foreground"
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
              onClick={() => onSend(s)}
              className="rounded-full border border-border bg-accent px-3 py-1 text-xs text-accent-foreground transition-colors hover:bg-accent/70"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      <div className={cn("flex gap-2 border-t border-border p-3", inputRowClassName)}>
        <input
          type="text"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && onSend(input)}
          placeholder="Ask about destinations, hotels, restaurants..."
          aria-label="Ask a travel question"
          disabled={loading}
          className="flex-1 rounded-full border border-border bg-background px-4 py-2 text-sm text-foreground outline-none focus:border-primary disabled:opacity-50"
        />
        <button
          onClick={() => onSend(input)}
          disabled={loading || !input.trim()}
          aria-label="Send message"
          className="flex size-9 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
        >
          <Send className="size-4" />
        </button>
      </div>
    </>
  );
}

interface TravelAssistantProps {
  // True for the fixed bottom-right widget on desktop (src/app/page.tsx).
  // Mobile no longer has a plain non-floating mode - below md this component
  // always renders as the floating bubble + bottom sheet further down,
  // regardless of this prop - so in practice this is always true at the
  // component's one remaining call site, kept only because the desktop
  // bubble/panel's own positioning stays gated on it unchanged.
  floating?: boolean;
}

export function TravelAssistant({ floating = false }: TravelAssistantProps = {}) {
  const [messages, setMessages] = useState<Message[]>([
    { role: "assistant", text: GREETING },
  ]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [userLocation, setUserLocation] = useState("");
  const [desktopOpen, setDesktopOpen] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState(false);
  const desktopBottomRef = useRef<HTMLDivElement>(null);
  const sheetBottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    // Neither the desktop popup nor the mobile sheet unmount when closed -
    // both scale/translate off instead, so the open/close itself can
    // animate - so this just needs to re-run on every new message to keep
    // both scrolled to the latest one.
    desktopBottomRef.current?.scrollIntoView({ behavior: "smooth" });
    sheetBottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Lock background scroll while the mobile sheet is open. Without this, a
  // touch-scroll gesture that reaches the top/bottom of the messages list
  // (or starts just outside it) can "leak" into scrolling the page behind
  // the sheet instead - invisible since the sheet covers it, but it eats the
  // gesture, which reads as "scrolling doesn't work" even though the inner
  // list itself is perfectly scrollable.
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

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

  const headerTitle = (
    <div className="flex items-center gap-3">
      <span className="text-2xl">🧭</span>
      <div>
        <h3 className="font-heading font-semibold text-white">
          BonVoyage AI Assistant
        </h3>
        <p className="text-xs text-white/80">
          {userLocation ? `📍 Detected: ${userLocation}` : "Ask me anything about travel in India"}
        </p>
      </div>
    </div>
  );

  return (
    <>
      {/* Desktop: popup panel, toggled open/closed by the bubble below.
          Stays mounted even while closed (scaled/faded out rather than
          unmounted) so the open/close itself can animate, same pattern as
          the mobile sheet further down. `hidden md:flex` keeps it off
          mobile entirely; the bubble is the only desktop-only UI mobile
          doesn't also get a version of. */}
      <div
        className={cn(
          "flex flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-2xl transition-all duration-300",
          floating && "hidden md:flex fixed z-50",
          floating && (expanded
            ? "bottom-0 right-0 h-[85vh] w-full max-w-2xl rounded-b-none"
            : "bottom-24 right-6 max-h-[70vh] w-96"),
          floating && (desktopOpen ? "scale-100 opacity-100" : "pointer-events-none scale-95 opacity-0")
        )}
      >
        {/* Orange -> pink rather than the app's primary/secondary (orange/green)
            tokens: those are complementary hues and muddy to brown mid-gradient,
            which only shows up clearly on a wide solid band like this header. */}
        <div className="flex items-center justify-between gap-3 bg-gradient-to-r from-orange-500 to-pink-500 px-4 py-3">
          {headerTitle}
          {/* Wrapper keeps both buttons grouped on the right, since the
              header's justify-between would otherwise space three children. */}
          <div className="flex items-center gap-1">
            <button
              onClick={() => setExpanded((e) => !e)}
              aria-label="Toggle fullscreen"
              className="text-white/80 hover:text-white transition-colors"
            >
              {expanded ? <Minimize2 className="size-5" /> : <Maximize2 className="size-5" />}
            </button>
            <button
              onClick={() => setDesktopOpen(false)}
              aria-label="Close chat"
              className="flex size-7 items-center justify-center rounded-full text-white/90 transition-colors hover:bg-white/20"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <ChatBody
          messages={messages}
          loading={loading}
          input={input}
          onInputChange={setInput}
          onSend={sendMessage}
          bottomRef={desktopBottomRef}
          messagesAreaClassName="flex-1"
        />
      </div>

      {/* Desktop: floating bubble, toggles the popup panel above it. */}
      <button
        onClick={() => setDesktopOpen((o) => !o)}
        aria-label={desktopOpen ? "Close chat" : "Open AI travel assistant"}
        className={cn(
          "relative items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 shadow-lg",
          floating && "hidden md:flex fixed bottom-6 right-6 z-50 size-14",
          desktopOpen && "md:hidden"
        )}
      >
        {desktopOpen ? (
          <ChevronDown className="size-6 text-white" />
        ) : (
          <>
            <MessageCircle className="size-6 text-white" />
            {/* right-2 top-2, not the literal right-0 top-0 a "corner" dot
                would suggest: on a rounded-full button the box corner sits
                outside the visible circular face (a circle doesn't reach
                its own bounding-box corners), so a dot placed there mostly
                overlaps the page background instead of the button - same
                fix already applied to the mobile bubble's dot below. */}
            <span className="absolute right-2 top-2 size-3 rounded-full bg-red-500" />
          </>
        )}
      </button>

      {/* Mobile: backdrop behind the bottom sheet, dismisses it on tap. */}
      {open && (
        <div
          className="fixed inset-0 z-40 bg-black/50 md:hidden"
          onClick={() => setOpen(false)}
          aria-hidden="true"
        />
      )}

      {/* Mobile: full-screen bottom sheet. Always mounted (not conditional
          on `open`) so the slide-up/down is an actual transition rather than
          a mount/unmount cut. */}
      <div
        className={cn(
          "fixed inset-x-0 top-0 z-50 flex h-dvh flex-col bg-background transition-transform duration-300 md:hidden",
          open ? "translate-y-0" : "translate-y-full"
        )}
      >
        <div
          className={cn(
            "flex items-center justify-between gap-3 bg-gradient-to-r from-orange-500 to-pink-500 px-4 py-3",
            // Extra top inset for phones with a notch/status bar, since this
            // sheet covers the full viewport including that area - not asked
            // for explicitly, but the same concern as the input row's bottom
            // safe-area padding below, just at the other edge.
            "pt-[max(0.75rem,env(safe-area-inset-top))]"
          )}
        >
          {headerTitle}
          <button
            onClick={() => setOpen(false)}
            aria-label="Close chat"
            className="shrink-0 rounded-full p-1 text-white/90 transition-colors hover:bg-white/20"
          >
            <X className="size-5" />
          </button>
        </div>
        <ChatBody
          messages={messages}
          loading={loading}
          input={input}
          onInputChange={setInput}
          onSend={sendMessage}
          bottomRef={sheetBottomRef}
          inputRowClassName="mt-auto pb-[max(0.75rem,env(safe-area-inset-bottom))]"
        />
      </div>

      {/* Mobile: floating bubble. Rendered last so its z-50 paints above the
          sheet's equal z-50 (same-index ties resolve by DOM order) - it
          doubles as the sheet's close button once open, so it needs to stay
          clickable on top of the sheet rather than sit under it. */}
      <button
        onClick={() => setOpen((o) => !o)}
        aria-label={open ? "Minimize chat" : "Open AI travel assistant"}
        className={cn(
          "fixed bottom-6 right-4 z-50 size-14 items-center justify-center rounded-full bg-gradient-to-r from-orange-500 to-pink-500 shadow-lg md:hidden",
          open ? "hidden" : "flex"
        )}
      >
        {open ? (
          <ChevronDown className="size-6 text-white" />
        ) : (
          <>
            <MessageCircle className="size-6 text-white" />
            {/* Ping dot to draw a first-time visitor's attention - only
                while closed, since pinging an already-open chat is pointless. */}
            {/* right-2 top-2 (not right-0 top-0): on a rounded-full button, the
                box corner sits outside the visible circular face - a circle
                doesn't reach its own bounding-box corners - so a dot placed
                there mostly overlapped the page background instead of the
                gradient, and all but disappeared against this pale page. */}
            <span className="absolute right-2 top-2 flex size-3">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-white opacity-75" />
              <span className="relative inline-flex size-3 rounded-full bg-white" />
            </span>
          </>
        )}
      </button>
    </>
  );
}
