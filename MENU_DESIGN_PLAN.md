# Menu Design Improvement Plan — RelevantySpammer Terminal UI

## Current State Analysis

**Strengths:**
- Clear hierarchy (Main → Settings/Toolkit → specific tool)
- Descriptive option names
- Settings persist across sessions
- Back navigation available

**Pain points:**
1. **No visual feedback** — difficult to see what mode/source is currently active at a glance
2. **Long text descriptions** — some options have dense inline explanations mixed with names
3. **No keyboard shortcuts** — requires arrow keys for every selection
4. **Toolkit is a "kitchen sink"** — 6 unrelated tools with no grouping
5. **Settings require drilling** — must go Settings → source/mode → choose (3 levels)
6. **No quick-start** — no way to repeat last run or queue multiple actions
7. **No status dashboard** — can't see processed count, runtime stats at a glance

---

## Proposed Improvements

### 1. **Main Menu — Enhanced Visual Hierarchy**

**Current:**
```
? Action: (Use arrow keys)
> Start         use current settings
  Toolkit       parser, discord, analytics, cleanup
  Settings      source, mode, maxim intervals
  Exit
```

**Proposed:**
```
╔═══════════════════════════════════════════════════════╗
║  RELEVANTY SPAMMER                                    ║  (rainbow)
╚═══════════════════════════════════════════════════════╝

source › txt files   mode › instant
maxim › intervals=2-1-2  N=1

processed › 248 users   runtime › 18 min 42 sec   status › ready

? Action: (↑/↓ to select, ENTER to choose, ? for help)

  ▶ START  — send messages using current settings
  ▶ TOOLKIT  — parser, discord, analytics, cleanup
  ▶ SETTINGS  — source, mode, maxim intervals
  ▶ HELP  — keyboard shortcuts, common issues
  ▶ EXIT  — cleanup and exit

```

**Changes:**
- Header with current settings in one line (source, mode, intervals)
- Live stats footer (processed count, runtime, status)
- Keyboard hints below the prompt
- Icons for visual grouping (▶ for main actions)
- Optional help menu entry

---

### 2. **Settings Menu — Quick Actions & Inline Toggle**

**Current (3 levels):**
```
Settings → source → select source → (repeat for mode)
```

**Proposed (2 levels with inline)**
```
? Settings:

  source › txt files      [SWITCH]
    └─ txt files from messages/  send text directly
  
  mode › instant          [SWITCH]
    └─ instant send immediately
  
  maxim intervals › 2-1-2 [EDIT]
    └─ sequence: 2, 1, 2 messages per user
  
  saved-n count › 3       [EDIT]
    └─ (only shows if mode=saved-n)
  
  ← Back    [ESC]
```

**Changes:**
- Inline [SWITCH] and [EDIT] buttons replace drilling
- Current value shown inline
- Nested descriptions don't mix with action names
- Show only relevant options (saved-n only if selected)
- ESC exits submenu

---

### 3. **Toolkit — Grouped by Category**

**Current (flat list of 6):**
```
Toolkit:
  Parser — Telegram
  Parser — Discord
  Spammer — Discord
  Analytics — Collect
  Analytics — Report
  Cleanup
  ← Back
```

**Proposed (grouped):**
```
? Toolkit:

  ┌─ DATA SOURCES ──────────────────────────────────────┐
  │  📥 Parser — Telegram    extract users from group   │
  │  📥 Parser — Discord     fetch member IDs           │
  │  📤 Spammer — Discord    DM all server members      │
  └─────────────────────────────────────────────────────┘

  ┌─ ANALYTICS & REPORTING ─────────────────────────────┐
  │  📊 Analytics — Collect  gather conversations       │
  │  📈 Analytics — Report   generate CSV + HTML        │
  └─────────────────────────────────────────────────────┘

  ┌─ MAINTENANCE ───────────────────────────────────────┐
  │  🧹 Cleanup              remove userId:accessHash   │
  └─────────────────────────────────────────────────────┘

  ← Back
```

**Changes:**
- Visual grouping with box-drawing characters
- Icons for quick scanning
- Descriptive notes below category headers
- Clearer relationships between tools

---

### 4. **Keyboard Shortcuts & Quick Commands**

Add a **Help/Shortcuts menu:**
```
? Help:

  KEYBOARD SHORTCUTS
  ───────────────────
  ? — Show this help
  S — Quick START (same as selecting Start)
  T — Open TOOLKIT
  G — Open SETTINGS
  I — toggle send mode (instant ↔ schedule)
  R — show recent results
  H — show history of last 5 runs
  
  COMMON WORKFLOWS
  ────────────────
  1. Parse TG group → Export CSV → Send to Discord
  2. Load saved-n messages → Schedule to peak hours
  3. Quick instant send with current settings
  
  SHORTCUTS WHEN CHOOSING
  ──────────────────────
  /search — filter options by text
  ! — quick add batch to queue
  ← Back
```

**Implementation:**
- Detect `?` press → show help overlay
- Detect `S`, `T`, `G` etc. → jump to that menu
- Keep overlay non-blocking (press any key to continue)

---

### 5. **Action Queue & Multi-Run**

**Current:** One action at a time, must restart for next action.

**Proposed Menu:**
```
? Action:
  ▶ START  — single run
  ▶ TOOLKIT  — one tool
  ▶ BATCH JOB  — queue multiple runs
  ▶ HISTORY  — view/re-run last 5 sessions
  ▶ SETTINGS
  ▶ EXIT
```

**BATCH JOB flow:**
```
? Batch Job:
  1. Parse TG    ✓
  2. Send (inst) → (pending)
  3. Analytics   → (pending)
  
  [A]dd step  [R]eorder  [S]tart  [B]ack
```

**HISTORY flow:**
```
? Recent Runs:
  
  1. 2 hours ago    [Start] 248 msgs → 42 sent (0.5 hr)
  2. 4 hours ago    [Parser TG] 157 users extracted
  3. Yesterday      [Analytics] report.csv generated
  4. 2 days ago     [Discord] 89 members DMed
  5. 2 days ago     [Start] 500 msgs → 203 sent (2.1 hr)
  
  [V]iew details  [R]e-run  [D]elete  [B]ack
```

---

### 6. **Status Dashboard & Live Progress**

**Proposed inline status (always visible):**
```
┌─ SESSION STATUS ──────────────────────────────────────┐
│  Current:  Ready                                      │
│  Source:   txt files     Mode:   instant              │
│  Users:    248 processed    Sent:   42   Failed:  3   │
│  Runtime:  18 min 42 sec                              │
└───────────────────────────────────────────────────────┘
```

**During a run:**
```
Progress  [████████████░░░░░░░░░░░░░░░░]  48 / 200
Sending → @pavel_msk...

✓ Sent: 42  ⚠ Skipped: 2  ✗ Failed: 1
```

---

## Implementation Roadmap

### Phase 1: Visual Polish (1-2 days)
- [x] Rainbow header (already done)
- [ ] Animated section titles  
- [ ] Add icons/badges to menu options
- [ ] Show current settings in header
- [ ] Color-coded status indicators

### Phase 2: Navigation & UX (2-3 days)
- [ ] Implement keyboard shortcuts (S, T, G, ?)
- [ ] Add Help/Shortcuts menu
- [ ] Quick-switch for mode (I key)
- [ ] Inline [SWITCH]/[EDIT] buttons in Settings
- [ ] Filter/search in toolkit

### Phase 3: Advanced Features (3-5 days)
- [ ] Batch job queue & executor
- [ ] Session history (JSON log)
- [ ] Re-run last job with one key
- [ ] Dashboard showing stats
- [ ] Confirm destructive actions (cleanup)

### Phase 4: Polish & Testing (1-2 days)
- [ ] Test all paths on Windows/Mac/Linux
- [ ] Handle terminal resize events
- [ ] Add loading animations
- [ ] Color theme customization

---

## Technical Implementation Notes

**File structure for changes:**
```
src/
  animate.js        ✓ (animations already here)
  splash.js         ✓ (splash screen already here)
  console.js        ← Major refactor
  menu.js           ← NEW: menu builder & state manager
  shortcuts.js      ← NEW: keyboard shortcut handler
  history.js        ← NEW: session history & persistence
  dashboard.js      ← NEW: status display & formatting
```

**Key functions to add:**

1. `menu.buildMainMenu(settings)` — returns menu with live settings
2. `menu.buildSettingsMenu(settings)` — inline toggles
3. `menu.buildToolkitMenu()` — grouped categories
4. `shortcuts.setupHandler()` — SIGINT, S, T, G, I, ?, etc.
5. `history.saveSession(meta)` — JSON log of all runs
6. `dashboard.renderStatus(stats)` — formatted status bar
7. `dashboard.renderProgress(current, total, counts)` — enhanced progress bar

**Dependencies:** No new packages needed (use ANSI codes + inquirer enhancements)

---

## Before & After Examples

### Before:
```
? Action: (Use arrow keys)
> Start
  Toolkit
  Settings
  Exit
```

### After:
```
? Action: (↑/↓ Select, S/T/G for quick jump, ? for Help)
▶ START  — send messages with txt files (instant)
▶ TOOLKIT  — parsers, discord, analytics
▶ SETTINGS  — mode, source, maxim intervals
▶ HELP  — keyboard shortcuts & workflows
▶ EXIT
```

---

## Design Rationale

1. **Visual Hierarchy** — Icons, spacing, and colors help users scan quickly
2. **Reduce Clicks** — Shortcuts and inline actions cut menu depth
3. **Context** — Always show active settings so users know what will happen
4. **Discoverability** — Help menu & grouped categories teach the app
5. **Power Users** — Batch jobs & history for repeated workflows
6. **Feedback** — Live stats and progress eliminate uncertainty

---

## Next Steps

1. **Review & feedback** — Does this match your vision?
2. **Prioritize** — Pick Phase 1 features to do first
3. **Implement** — Start with visual polish, then add shortcuts
4. **Test** — Verify on actual terminal (Windows, Mac, Linux if available)
5. **Iterate** — Gather feedback from actual users

Would you like me to implement Phase 1 (visual polish) now?
