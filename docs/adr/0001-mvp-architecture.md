# ADR-001: Recursive Clarification Over Single-Shot Retrieval

- **Status:** Accepted
- **Decision:** Input keyword → expand 10 candidates → rank Top 5 → user clicks to recurse.
- **Consequence:** Session round state, tree history, and confirm mechanism required.

# ADR-002: Process Transparency Over Black-Box Intelligence

- **Status:** Accepted
- **Decision:** UI shows LLM output and tool-call trace with bidirectional tree linkage.
- **Consequence:** TraceEvent model, timeline API, highlight interactions.

# ADR-003: Top-Down Frontier Layout

- **Status:** Accepted (supersedes horizontal depth axis)
- **Decision:** Current root at top, decision leaves on the bottom row.

# ADR-004: Frontier View (Current Root + Leaves)

- **Status:** Accepted
- **Decision:** Main tree shows only the **current round root** and its **Top-5 leaves**. Full exploration history stays in session state and side panels; path navigation uses a breadcrumb with backtrace.
- **Consequence:** `buildFrontierDisplayTree`, breadcrumb UI, `/api/backtrace`.

# ADR-005: Leaf Heat Display

- **Status:** Accepted
- **Decision:** Leaf labels include popularity heat (0–100).

# ADR-006: Switchable LLM Providers

- **Status:** Accepted
- **Decision:** MiniMax, Kimi, or mock via environment variables.
