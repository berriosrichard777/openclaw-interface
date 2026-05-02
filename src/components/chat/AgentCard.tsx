import { useState } from "react";
import { Bot, ChevronDown, ChevronUp } from "lucide-react";
import { cn } from "@/lib/utils";

export type Verdict = "OK" | "Warning" | "Critical" | "Blocked";

export type ParsedReply = {
  status?: string;
  summary?: string;
  nextStep?: string;
  rest?: string; // anything else (Details, etc.)
};

export const parseReply = (text: string): ParsedReply => {
  const out: ParsedReply = {};
  const lines = text.split(/\r?\n/);
  const restLines: string[] = [];
  for (const line of lines) {
    const m = line.match(/^(Status|Summary|Next step|Next Step|Siguiente paso):\s*(.*)$/i);
    if (m) {
      const key = m[1].toLowerCase();
      if (key === "status") out.status = m[2];
      else if (key === "summary") out.summary = m[2];
      else out.nextStep = m[2];
    } else {
      restLines.push(line);
    }
  }
  out.rest = restLines.join("\n").trim();
  return out;
};

const verdictBorder = (v?: Verdict | null) => {
  switch (v) {
    case "OK": return "border-green-neon/50";
    case "Warning": return "border-yellow-400/50";
    case "Critical": return "border-destructive/60";
    case "Blocked": return "border-orange-500/60";
    default: return "border-border";
  }
};

const verdictBadge = (v?: Verdict | null) => {
  switch (v) {
    case "OK": return "border-green-neon/50 bg-green-neon/15 text-green-neon";
    case "Warning": return "border-yellow-400/50 bg-yellow-400/15 text-yellow-400";
    case "Critical": return "border-destructive/60 bg-destructive/20 text-destructive";
    case "Blocked": return "border-orange-500/60 bg-orange-500/20 text-orange-400";
    default: return "border-border bg-surface-2 text-muted-foreground";
  }
};

type Props = {
  content: string;
  verdict?: Verdict | null;
  timestamp: string;
  rawCalls?: unknown;
  suggestions?: string[];
  onSuggestion?: (cmd: string) => void;
};

const AgentCard = ({ content, verdict, timestamp, rawCalls, suggestions, onSuggestion }: Props) => {
  const [showDetails, setShowDetails] = useState(false);
  const parsed = parseReply(content);
  const isStructured = !!(parsed.status || parsed.summary || parsed.nextStep);

  return (
    <div className={cn("rounded-lg border bg-surface", verdictBorder(verdict))}>
      {/* Header */}
      <div className="flex items-center justify-between gap-2 border-b border-border/50 px-3 py-2">
        <div className="flex items-center gap-2">
          <div className="flex h-6 w-6 items-center justify-center rounded-md border border-cyan/40 bg-cyan/10 text-cyan">
            <Bot className="h-3.5 w-3.5" />
          </div>
          <span className="font-mono text-[10px] uppercase tracking-widest text-green-neon">
            OPENCLAW_AGENT_V2.5
          </span>
          {verdict && (
            <span className={cn("rounded border px-1.5 py-0 font-mono text-[9px] uppercase tracking-widest", verdictBadge(verdict))}>
              {verdict}
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-muted-foreground">
          {new Date(timestamp).toLocaleTimeString()}
        </span>
      </div>

      {/* Body */}
      <div className="space-y-2 px-3 py-2.5 font-mono text-[12px]">
        {isStructured ? (
          <>
            {parsed.status && (
              <div>
                <span className="text-muted-foreground">Status: </span>
                <span className="text-foreground">{parsed.status}</span>
              </div>
            )}
            {parsed.summary && (
              <div>
                <span className="text-muted-foreground">Summary: </span>
                <span className="text-foreground whitespace-pre-wrap">{parsed.summary}</span>
              </div>
            )}
            {parsed.nextStep && (
              <div>
                <span className="text-muted-foreground">Next step: </span>
                <span className="text-foreground whitespace-pre-wrap">{parsed.nextStep}</span>
              </div>
            )}
            {parsed.rest && (
              <div className="whitespace-pre-wrap text-foreground/80">{parsed.rest}</div>
            )}
          </>
        ) : (
          <div className="whitespace-pre-wrap text-foreground">{content}</div>
        )}
      </div>

      {/* Show details */}
      {rawCalls != null && (
        <div className="border-t border-border/50 px-3 py-2">
          <button
            onClick={() => setShowDetails((v) => !v)}
            className="flex items-center gap-1 font-mono text-[10px] uppercase tracking-widest text-muted-foreground hover:text-cyan"
          >
            {showDetails ? <ChevronUp className="h-3 w-3" /> : <ChevronDown className="h-3 w-3" />}
            {showDetails ? "Hide details" : "Show details"}
          </button>
          {showDetails && (
            <pre className="mt-2 max-h-64 overflow-auto rounded bg-black/60 p-2 font-mono text-[10px] text-foreground/80 scrollbar-thin">
{JSON.stringify(rawCalls, null, 2)}
            </pre>
          )}
        </div>
      )}

      {/* Suggestions */}
      {suggestions && suggestions.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 border-t border-border/50 px-3 py-2">
          <span className="font-mono text-[9px] uppercase tracking-widest text-muted-foreground">
            Suggested ::
          </span>
          {suggestions.map((s) => (
            <button
              key={s}
              onClick={() => onSuggestion?.(s)}
              className="rounded-full border border-border bg-surface-2 px-2.5 py-0.5 font-mono text-[10px] uppercase tracking-widest text-muted-foreground transition-colors hover:border-cyan/40 hover:text-cyan"
            >
              {s}
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export default AgentCard;
