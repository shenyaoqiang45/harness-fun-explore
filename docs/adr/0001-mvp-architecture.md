# ADR-001: Recursive Clarification Over Single-Shot Retrieval

- **Status:** Accepted
- **Decision:** Input keyword → expand 10 candidates → rank Top 5 → user clicks to recurse.
- **Consequence:** Session round state, tree history, and confirm mechanism required.

# ADR-002: Process Transparency Over Black-Box Intelligence

- **Status:** Accepted
- **Decision:** UI shows LLM output and tool-call trace with bidirectional tree linkage.
- **Consequence:** TraceEvent model, timeline API, highlight interactions.

# ADR-003: Left-to-Right Tree Depth

- **Status:** Accepted
- **Decision:** Exploration depth maps to horizontal axis (shallow left, deep right).

# ADR-004: Round Roots + Latest Leaves in Main View

- **Status:** Accepted
- **Decision:** Chain round roots; show only the latest round's leaves as decision panel.

# ADR-005: Leaf Heat Display

- **Status:** Accepted
- **Decision:** Leaf labels include popularity heat (0–100).

# ADR-006: Switchable LLM Providers

- **Status:** Accepted
- **Decision:** MiniMax, Kimi, or mock via environment variables.
