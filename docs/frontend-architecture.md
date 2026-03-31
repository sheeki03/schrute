# Schrute Frontend + Chrome Extension Architecture

## System Overview

```
+-------------------+      +-------------------+      +-------------------+
|  Chrome Extension |<---->|   Schrute Daemon   |<---->|   Web Dashboard   |
|  (Manifest V3)    |      |   (REST + WS)      |      |   (React SPA)     |
+-------------------+      +-------------------+      +-------------------+
        |                         |                           |
        |  content scripts        |  SQLite + FS              |  served from
        |  side panel             |  browser mgr              |  daemon /app
        v                         v                           v
   [Active Tab]             [Playwright/CDP]           [localhost:3000/app]
```

---

## Part 1: Web Dashboard (React SPA)

### Tech Stack

| Layer          | Choice                | Rationale                                       |
|----------------|----------------------|--------------------------------------------------|
| Framework      | React 19 + TypeScript | Ecosystem, hooks for real-time state             |
| Routing        | React Router v7       | File-based routes, loaders for data prefetch     |
| State          | Zustand               | Lightweight, no boilerplate, good for WS streams |
| Styling        | Tailwind CSS 4        | Utility-first, fast iteration, dark mode native  |
| Components     | shadcn/ui             | Composable, unstyled primitives, copy-paste owned |
| Charts         | Recharts              | Lightweight, React-native, good for metrics      |
| Data Fetching  | TanStack Query v5     | Cache, polling, optimistic updates, WS sync      |
| Tables         | TanStack Table v8     | Headless, sortable, filterable, virtual scroll    |
| Forms          | React Hook Form + Zod | JSON Schema → Zod for skill param forms          |
| Code Display   | Shiki                 | Syntax highlighting for export previews          |
| Bundler        | Vite 6                | Fast HMR, ESM native                            |
| Testing        | Vitest + Playwright   | Unit + E2E                                       |

### Serving Strategy

The dashboard is served directly from the Schrute daemon:
- `GET /app/*` → Static SPA assets (Vite build output)
- `GET /api/v1/*` → REST API (already exists)
- `WS /ws` → WebSocket for live events (new)

No separate frontend server needed. Single `schrute serve` starts everything.

---

### Page Architecture

```
/app
├── /                          → Dashboard (overview)
├── /sites                     → Site inventory
│   └── /:siteId              → Site detail + skills list
│       └── /skills/:skillId  → Skill detail + execute
├── /record                    → Recording studio
├── /sessions                  → Browser session manager
├── /audit                     → Audit log explorer
├── /workflows                 → Workflow builder
└── /settings                  → Config + policies
```

### Page Breakdown

#### 1. Dashboard (`/app`)

**Purpose**: At-a-glance health and activity.

```
┌─────────────────────────────────────────────────────┐
│  Schrute Dashboard                        [status]  │
├──────────┬──────────┬──────────┬───────────────────-─┤
│  Sites   │  Skills  │  Active  │  Success Rate       │
│  12      │  87      │  71      │  94.2%              │
├──────────┴──────────┴──────────┴────────────────────-┤
│                                                      │
│  [Engine Status Bar]  idle / exploring / recording   │
│                                                      │
├──────────────────────┬───────────────────────────────┤
│  Recent Executions   │  Skill Health                 │
│  ┌────────────────┐  │  ┌───────────────────────┐    │
│  │ skill  latency │  │  │ ●●●●●○○ 71 active     │    │
│  │ skill  latency │  │  │ ●●○○○○○  8 stale      │    │
│  │ skill  latency │  │  │ ●○○○○○○  5 broken     │    │
│  └────────────────┘  │  └───────────────────────┘    │
├──────────────────────┴───────────────────────────────┤
│  Pipeline Jobs (active)                              │
│  [job-abc] coingecko.com ████████░░ 80% generating   │
│  [job-def] github.com    ██████████ complete (12 sk) │
└──────────────────────────────────────────────────────┘
```

**Data Sources**:
- `GET /api/v1/status` → engine mode, validation stats
- `GET /api/v1/sites` → site count + mastery levels
- `GET /api/v1/skills?status=active` → skill inventory
- `WS /ws` → live pipeline progress, execution events

#### 2. Site Detail (`/app/sites/:siteId`)

```
┌──────────────────────────────────────────────────────┐
│  coingecko.com                    mastery: partial   │
│  First seen: 2026-01-15  Last visited: 2026-03-28   │
├──────────────────────────────────────────────────────┤
│  Skills (14)         [search___________] [+ Record]  │
│  ┌─────────────────────────────────────────────────┐ │
│  │ ● get-bitcoin-price    v2  tier1  98.5%  12ms   │ │
│  │ ● get-eth-price        v1  tier1  95.0%  18ms   │ │
│  │ ○ get-market-cap       v1  tier3  60.0%  340ms  │ │
│  │ ✕ get-trending         v2  broken  0%   —       │ │
│  └─────────────────────────────────────────────────┘ │
├──────────────────────────────────────────────────────┤
│  Coverage: 67%  (8/12 discovered endpoints covered)  │
│  Policy: GET,HEAD | 1 QPS | domains: coingecko.com   │
│  [Edit Policy]  [Discover Endpoints]  [Delete Site]  │
└──────────────────────────────────────────────────────┘
```

**Data Sources**:
- `GET /api/v1/sites/:id` → manifest
- `GET /api/v1/sites/:id/skills` → skill list
- Coverage endpoint (new, from `src/discovery/coverage.ts`)

#### 3. Skill Detail (`/app/sites/:siteId/skills/:skillId`)

```
┌──────────────────────────────────────────────────────┐
│  get-bitcoin-price v2           ● active  tier: 1    │
│  GET /api/v3/simple/price                            │
│  coingecko.com | read-only | auth: none              │
├────────────────────────┬─────────────────────────────┤
│  Execute               │  Response Preview           │
│  ┌──────────────────┐  │  ```json                    │
│  │ ids: [bitcoin   ]│  │  {                          │
│  │ vs:  [usd      ] │  │    "bitcoin": {             │
│  │                   │  │      "usd": 67432.12       │
│  │ [Execute] [Dry]   │  │    }                       │
│  └──────────────────┘  │  }                          │
│                        │  ```                        │
├────────────────────────┴─────────────────────────────┤
│  Tabs: [Params] [Schema] [History] [Healing] [Export]│
│  ┌──────────────────────────────────────────────────┐│
│  │  History (last 20 executions)                    ││
│  │  2026-03-28 12:01  ✓  tier1  12ms               ││
│  │  2026-03-28 11:45  ✓  tier1  15ms               ││
│  │  2026-03-27 09:12  ✗  tier3  auth_expired       ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  [Validate] [Optimize] [Set Transform] [Delete]      │
└──────────────────────────────────────────────────────┘
```

**Key Interactions**:
- **Execute form**: Dynamically generated from `skill.inputSchema` (JSON Schema → form fields via React Hook Form)
- **Dry run**: `POST /api/sites/:id/skills/:name/dry-run`
- **Confirmation gate**: If 202 returned, show approval dialog with token
- **Export tab**: Show curl/Python/fetch/TypeScript snippets (from `schrute_export_skill`)

#### 4. Recording Studio (`/app/record`)

```
┌──────────────────────────────────────────────────────┐
│  Recording Studio                                    │
├──────────────────────────────────────────────────────┤
│  Step 1: Explore                                     │
│  URL: [https://___________________] [Explore]        │
│                                                      │
│  Step 2: Record                                      │
│  Name: [________________]  Inputs: [+ Add Input]     │
│  [Start Recording]                                   │
│                                                      │
│  Step 3: Perform actions in browser                  │
│  ┌──────────────────────────────────────────────────┐│
│  │  Live traffic feed (WS stream)                   ││
│  │  → GET /api/v3/simple/price?ids=bitcoin  200  3ms││
│  │  → GET /api/v3/coins/markets  200  45ms          ││
│  │  ← filtered: analytics.google.com (noise)        ││
│  └──────────────────────────────────────────────────┘│
│                                                      │
│  Step 4: Stop & Generate                             │
│  [Stop Recording]                                    │
│                                                      │
│  Pipeline: [job-abc123] ████████░░ Generating skills │
│  Skills found: 3  |  [View Skills →]                 │
└──────────────────────────────────────────────────────┘
```

**Real-time Requirements**:
- Live traffic feed during recording (WS subscription to network events)
- Pipeline progress polling (`GET /api/v1/pipeline/:jobId` or WS push)
- Engine mode transitions (idle → exploring → recording → idle)

#### 5. Workflow Builder (`/app/workflows`)

```
┌──────────────────────────────────────────────────────┐
│  Workflows                              [+ Create]   │
├──────────────────────────────────────────────────────┤
│  Suggested Workflows (from chain detection)          │
│  ┌──────────────────────────────────────────────────┐│
│  │  "Get BTC + ETH prices" (2 steps)    [Accept]   ││
│  │  get-bitcoin-price → get-eth-price              ││
│  │  Detected chain: response.id → query.ids        ││
│  └──────────────────────────────────────────────────┘│
├──────────────────────────────────────────────────────┤
│  Active Workflows                                    │
│  ┌──────────────────────────────────────────────────┐│
│  │  Visual flow editor (drag & drop)               ││
│  │                                                  ││
│  │  [Skill A] ──param──> [Skill B] ──param──> [C]  ││
│  │                                                  ││
│  └──────────────────────────────────────────────────┘│
└──────────────────────────────────────────────────────┘
```

#### 6. Audit Log (`/app/audit`)

```
┌──────────────────────────────────────────────────────┐
│  Audit Log                [filter] [date range]      │
├──────────────────────────────────────────────────────┤
│  Time        Skill              Tier  Status  Latency│
│  12:01:23    get-bitcoin-price  T1    ✓       12ms   │
│  12:00:45    get-eth-price      T1    ✓       18ms   │
│  11:59:12    get-trending       T3    ✗       —      │
│  ...                                                 │
├──────────────────────────────────────────────────────┤
│  Integrity: ✓ Chain verified (256 entries)           │
└──────────────────────────────────────────────────────┘
```

#### 7. Session Manager (`/app/sessions`)

```
┌──────────────────────────────────────────────────────┐
│  Browser Sessions                    [+ Connect CDP] │
├──────────────────────────────────────────────────────┤
│  ● prod-chrome    port:9222  3 tabs   [Switch] [✕]  │
│  ○ staging        port:9223  1 tab    [Switch] [✕]  │
│  ○ test-browser   managed   2 tabs    [Switch] [✕]  │
├──────────────────────────────────────────────────────┤
│  Import Cookies: [Choose File] [Import]              │
└──────────────────────────────────────────────────────┘
```

---

### Frontend Directory Structure

```
frontend/
├── package.json
├── vite.config.ts
├── tailwind.config.ts
├── tsconfig.json
├── index.html
├── public/
│   └── favicon.svg
├── src/
│   ├── main.tsx                    # Entry point
│   ├── app.tsx                     # Router + layout
│   ├── api/
│   │   ├── client.ts              # Fetch wrapper (base URL, auth header)
│   │   ├── hooks.ts               # TanStack Query hooks (useSkills, useSites, etc.)
│   │   ├── websocket.ts           # WS connection manager + Zustand integration
│   │   └── types.ts               # API response types (mirrored from backend)
│   ├── stores/
│   │   ├── engine.ts              # Engine status (mode, sessions)
│   │   ├── pipeline.ts            # Active pipeline jobs
│   │   └── notifications.ts       # Toasts, confirmation requests
│   ├── pages/
│   │   ├── dashboard.tsx
│   │   ├── sites/
│   │   │   ├── index.tsx          # Site list
│   │   │   └── [siteId]/
│   │   │       ├── index.tsx      # Site detail
│   │   │       └── skills/
│   │   │           └── [skillId].tsx  # Skill detail + execute
│   │   ├── record.tsx             # Recording studio
│   │   ├── workflows.tsx          # Workflow builder
│   │   ├── audit.tsx              # Audit log
│   │   ├── sessions.tsx           # Session manager
│   │   └── settings.tsx           # Config editor
│   ├── components/
│   │   ├── ui/                    # shadcn/ui primitives
│   │   ├── layout/
│   │   │   ├── sidebar.tsx        # Nav sidebar
│   │   │   ├── header.tsx         # Top bar with engine status
│   │   │   └── shell.tsx          # Page shell
│   │   ├── skills/
│   │   │   ├── skill-card.tsx     # Skill summary card
│   │   │   ├── skill-form.tsx     # Dynamic param form (from JSON Schema)
│   │   │   ├── skill-badge.tsx    # Status/tier badges
│   │   │   └── schema-viewer.tsx  # JSON Schema tree view
│   │   ├── recording/
│   │   │   ├── traffic-feed.tsx   # Live request stream
│   │   │   └── pipeline-bar.tsx   # Progress indicator
│   │   ├── workflow/
│   │   │   ├── flow-canvas.tsx    # Drag-and-drop editor
│   │   │   └── step-node.tsx      # Skill node in flow
│   │   └── shared/
│   │       ├── confirm-dialog.tsx # Skill confirmation gate
│   │       ├── code-block.tsx     # Syntax highlighted code
│   │       ├── status-dot.tsx     # ● ○ ✕ status indicator
│   │       └── data-table.tsx     # Reusable TanStack Table
│   └── lib/
│       ├── schema-to-form.ts      # JSON Schema → form field config
│       ├── format.ts              # Date, duration, byte formatters
│       └── constants.ts           # Tier names, status colors, etc.
```

---

### WebSocket Protocol (New — Required for Frontend)

The daemon needs a new WS endpoint for real-time events:

```
WS /ws?token={authToken}
```

**Event Types**:

```typescript
// Server → Client events
type WSEvent =
  | { type: 'engine:mode';       data: { mode: EngineMode; siteId?: string } }
  | { type: 'pipeline:progress'; data: { jobId: string; phase: string; pct: number } }
  | { type: 'pipeline:complete'; data: { jobId: string; skillIds: string[] } }
  | { type: 'skill:executed';    data: { skillId: string; tier: string; ok: boolean; ms: number } }
  | { type: 'skill:promoted';    data: { skillId: string; from: string; to: string } }
  | { type: 'skill:healed';      data: { skillId: string; amendment: string } }
  | { type: 'confirm:required';  data: { skillId: string; token: string; expiresIn: number } }
  | { type: 'recording:traffic'; data: { method: string; url: string; status: number; ms: number; filtered: boolean } }
  | { type: 'session:changed';   data: { name: string; action: 'created' | 'switched' | 'closed' } }
```

**Client → Server**:

```typescript
type WSCommand =
  | { type: 'subscribe'; channels: string[] }   // e.g., ['pipeline:*', 'recording:traffic']
  | { type: 'unsubscribe'; channels: string[] }
```

---

### API Client Layer

```typescript
// frontend/src/api/client.ts
const BASE = window.location.origin;

export const api = {
  // Status
  status:    ()              => get('/api/v1/status'),
  health:    ()              => get('/api/health'),

  // Sites
  sites:     ()              => get('/api/v1/sites'),
  site:      (id: string)    => get(`/api/v1/sites/${id}`),
  siteSkills:(id: string)    => get(`/api/v1/sites/${id}/skills`),
  deleteSite:(id: string)    => del(`/api/sites/${id}`),

  // Skills
  skills:    (q?: SkillQuery) => get('/api/v1/skills', q),
  search:    (query: string)  => post('/api/v1/skills/search', { query }),
  execute:   (skillId: string, params: Record<string, unknown>) =>
                                 post('/api/v1/execute', { skillId, params }),
  dryRun:    (siteId: string, name: string, params: Record<string, unknown>) =>
                                 post(`/api/sites/${siteId}/skills/${name}/dry-run`, { params }),
  confirm:   (token: string)  => post('/api/confirm', { confirmationToken: token, approve: true }),
  validate:  (siteId: string, name: string) =>
                                 post(`/api/sites/${siteId}/skills/${name}/validate`),

  // Recording
  explore:   (url: string, opts?: ExploreOpts)  => post('/api/v1/explore', { url, ...opts }),
  stop:      ()              => post('/api/v1/stop'),
  pipeline:  (jobId: string) => get(`/api/v1/pipeline/${jobId}`),

  // Sessions
  sessions:  ()              => get('/api/sessions'),
  connectCdp:(opts: CdpOpts) => post('/api/sessions', opts),
  closeSession:(name: string)=> del(`/api/sessions/${name}`),

  // Audit
  audit:     (q?: AuditQuery)=> get('/api/audit', q),
};
```

---

### TanStack Query Hooks

```typescript
// frontend/src/api/hooks.ts
export const useStatus      = () => useQuery({ queryKey: ['status'],  queryFn: api.status,  refetchInterval: 5000 });
export const useSites       = () => useQuery({ queryKey: ['sites'],   queryFn: api.sites });
export const useSite        = (id: string) => useQuery({ queryKey: ['site', id], queryFn: () => api.site(id) });
export const useSiteSkills  = (id: string) => useQuery({ queryKey: ['skills', id], queryFn: () => api.siteSkills(id) });
export const useSkillSearch = (q: string)  => useQuery({ queryKey: ['search', q], queryFn: () => api.search(q), enabled: q.length > 1 });

export const useExecuteSkill = () => useMutation({
  mutationFn: ({ skillId, params }) => api.execute(skillId, params),
  onSuccess: (data) => {
    if (data.status === 202) {
      // Confirmation required — push to notification store
      useNotifications.getState().addConfirmation(data.confirmationToken, data.skillId);
    }
  },
});

export const usePipeline = (jobId: string | null) => useQuery({
  queryKey: ['pipeline', jobId],
  queryFn: () => api.pipeline(jobId!),
  enabled: !!jobId,
  refetchInterval: (data) => data?.status === 'complete' ? false : 2000,
});
```

---

## Part 2: Chrome Extension (Manifest V3)

### Purpose

The Chrome extension provides:
1. **Quick record** — Start/stop recording from any tab without opening the dashboard
2. **Skill execution** — Run skills from a popup or context menu
3. **CDP bridge** — Connect the user's actual Chrome session to Schrute (no separate browser needed)
4. **Live status** — Badge shows engine mode (idle/recording/executing)
5. **Confirmation gate** — Desktop notification for skill approvals

### Extension Architecture

```
┌─────────────────────────────────────────────────────────────┐
│                     Chrome Extension                         │
├──────────────┬──────────────┬───────────────┬───────────────┤
│  Background  │  Side Panel  │  Popup        │  Content      │
│  (Service    │  (React app) │  (Quick       │  Scripts      │
│   Worker)    │              │   actions)    │               │
├──────────────┼──────────────┼───────────────┼───────────────┤
│  - WS conn   │  - Mini      │  - Status     │  - Element    │
│    to daemon  │    dashboard │  - Record     │    selector   │
│  - Badge      │  - Skill     │    toggle     │    overlay    │
│    updates    │    browser   │  - Quick      │  - Annotate   │
│  - Context    │  - Traffic   │    execute    │    clicks     │
│    menus      │    feed      │              │  - Inject      │
│  - Alarms     │  - Execute   │              │    param       │
│  - CDP bridge │    form      │              │    hints       │
│    (chrome.   │              │              │               │
│    debugger)  │              │              │               │
└──────────────┴──────────────┴───────────────┴───────────────┘
         │                                          │
         │  chrome.runtime.sendMessage              │
         ├──────────────────────────────────────────┤
         │                                          │
         v                                          v
   [Schrute Daemon]                          [Active Tab DOM]
   localhost:3000                             (page content)
```

### Extension Directory Structure

```
extension/
├── manifest.json
├── package.json
├── vite.config.ts
├── src/
│   ├── background/
│   │   ├── service-worker.ts      # Main background script
│   │   ├── daemon-client.ts       # REST + WS connection to Schrute daemon
│   │   ├── badge-manager.ts       # Extension icon badge (recording/idle/error)
│   │   ├── context-menus.ts       # Right-click menu entries
│   │   ├── cdp-bridge.ts          # chrome.debugger API → attach to tabs
│   │   └── notifications.ts       # Desktop notifications for confirmations
│   ├── popup/
│   │   ├── popup.html
│   │   ├── popup.tsx              # Quick action popup
│   │   └── components/
│   │       ├── status-bar.tsx     # Engine mode indicator
│   │       ├── quick-record.tsx   # One-click record toggle
│   │       ├── recent-skills.tsx  # Last 5 executed skills
│   │       └── connection.tsx     # Daemon connection status
│   ├── sidepanel/
│   │   ├── sidepanel.html
│   │   ├── sidepanel.tsx          # Full side panel app
│   │   └── components/
│   │       ├── skill-browser.tsx  # Browse + search skills
│   │       ├── execute-form.tsx   # Run skill with params
│   │       ├── traffic-feed.tsx   # Live recording traffic
│   │       ├── pipeline-view.tsx  # Generation progress
│   │       └── mini-dashboard.tsx # Compact status view
│   ├── content/
│   │   ├── selector-overlay.ts    # Visual element picker
│   │   ├── param-hints.ts         # Highlight parameterizable elements
│   │   └── inject.css             # Overlay styles
│   ├── shared/
│   │   ├── types.ts               # Shared types
│   │   ├── messages.ts            # chrome.runtime message protocol
│   │   └── storage.ts             # chrome.storage wrapper (daemon URL, token)
│   └── assets/
│       ├── icon-16.png
│       ├── icon-48.png
│       └── icon-128.png
```

### Manifest V3

```jsonc
{
  "manifest_version": 3,
  "name": "Schrute — Self-Learning Browser Agent",
  "version": "0.1.0",
  "description": "Record, learn, and replay browser actions as reusable API skills",

  "permissions": [
    "activeTab",
    "contextMenus",
    "notifications",
    "storage",
    "sidePanel",
    "debugger",          // CDP bridge to user's Chrome tabs
    "alarms"             // Periodic status polling fallback
  ],

  "host_permissions": [
    "http://localhost:3000/*",
    "http://127.0.0.1:3000/*"
  ],

  "background": {
    "service_worker": "dist/background/service-worker.js",
    "type": "module"
  },

  "action": {
    "default_popup": "dist/popup/popup.html",
    "default_icon": {
      "16": "assets/icon-16.png",
      "48": "assets/icon-48.png",
      "128": "assets/icon-128.png"
    }
  },

  "side_panel": {
    "default_path": "dist/sidepanel/sidepanel.html"
  },

  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["dist/content/selector-overlay.js"],
      "css": ["dist/content/inject.css"],
      "run_at": "document_idle"
    }
  ],

  "icons": {
    "16": "assets/icon-16.png",
    "48": "assets/icon-48.png",
    "128": "assets/icon-128.png"
  }
}
```

### Extension ↔ Daemon Communication

```
┌──────────────┐    REST/WS     ┌──────────────┐
│   Service    │ ◄────────────► │   Schrute    │
│   Worker     │  localhost:3000│   Daemon     │
└──────┬───────┘                └──────────────┘
       │
       │ chrome.runtime.sendMessage
       │
┌──────┴───────┐  ┌────────────┐  ┌────────────┐
│   Popup      │  │ Side Panel │  │  Content   │
│              │  │            │  │  Script    │
└──────────────┘  └────────────┘  └────────────┘
```

**Message Protocol** (internal):

```typescript
// extension/src/shared/messages.ts
type ExtMessage =
  // Popup/SidePanel → Background
  | { type: 'daemon:status' }
  | { type: 'daemon:explore';    url: string }
  | { type: 'daemon:record';     name: string }
  | { type: 'daemon:stop' }
  | { type: 'daemon:execute';    skillId: string; params: Record<string, unknown> }
  | { type: 'daemon:confirm';    token: string }
  | { type: 'daemon:skills';     siteId?: string }
  | { type: 'daemon:search';     query: string }
  | { type: 'cdp:attach';        tabId: number }
  | { type: 'cdp:detach' }

  // Background → Popup/SidePanel (responses + pushes)
  | { type: 'status:update';     data: EngineStatus }
  | { type: 'pipeline:update';   data: PipelineProgress }
  | { type: 'traffic:event';     data: TrafficEvent }
  | { type: 'confirm:needed';    data: ConfirmationRequest }
  | { type: 'connection:state';  connected: boolean }
```

### Key Extension Features

#### CDP Bridge (Connect User's Chrome)

The killer feature — users don't need a separate Playwright browser:

```typescript
// extension/src/background/cdp-bridge.ts
// Uses chrome.debugger API to attach to the user's active tab
// and forward CDP events to the Schrute daemon

async function attachToTab(tabId: number) {
  await chrome.debugger.attach({ tabId }, '1.3');
  await chrome.debugger.sendCommand({ tabId }, 'Network.enable');
  await chrome.debugger.sendCommand({ tabId }, 'Page.enable');

  // Forward network events to daemon via WS
  chrome.debugger.onEvent.addListener((source, method, params) => {
    if (source.tabId === tabId) {
      daemonWs.send(JSON.stringify({ type: 'cdp:event', method, params }));
    }
  });

  // Register session with daemon
  await daemonClient.post('/api/sessions', {
    name: `chrome-tab-${tabId}`,
    port: null, // Not a remote debugging port — we're proxying
    siteId: await getTabSiteId(tabId),
  });
}
```

#### Badge States

```typescript
// extension/src/background/badge-manager.ts
const BADGES = {
  idle:       { text: '',    color: '#4CAF50' },  // Green dot
  exploring:  { text: '👁',  color: '#2196F3' },  // Blue
  recording:  { text: 'REC', color: '#F44336' },  // Red
  executing:  { text: '▶',   color: '#FF9800' },  // Orange
  error:      { text: '!',   color: '#9E9E9E' },  // Gray
  offline:    { text: '?',   color: '#9E9E9E' },  // Gray
};
```

#### Context Menus

```typescript
// Right-click on any page
chrome.contextMenus.create({
  id: 'schrute-record',
  title: 'Record this page with Schrute',
  contexts: ['page'],
});

chrome.contextMenus.create({
  id: 'schrute-execute',
  title: 'Run skill on this site',
  contexts: ['page'],
});

// Right-click on a link
chrome.contextMenus.create({
  id: 'schrute-explore-link',
  title: 'Explore link with Schrute',
  contexts: ['link'],
});
```

---

## Part 3: Shared Infrastructure

### Shared Types Package

Both frontend and extension import types from the backend:

```
packages/
└── schrute-types/
    ├── package.json           # { "name": "@schrute/types" }
    ├── src/
    │   ├── skill.ts           # SkillSpec, SkillStatus, ExecutionTier
    │   ├── site.ts            # SiteManifest, SitePolicy
    │   ├── engine.ts          # EngineStatus, EngineMode
    │   ├── api.ts             # Request/response shapes for REST
    │   ├── ws.ts              # WebSocket event types
    │   └── index.ts           # Re-exports
    └── tsconfig.json
```

Generated from `src/skill/types.ts` — either symlinked or extracted as a shared package in a monorepo.

### Monorepo Structure

```
oneagent/
├── package.json               # Workspace root
├── packages/
│   ├── core/                  # Existing backend (src/)
│   ├── types/                 # @schrute/types (shared)
│   ├── frontend/              # React dashboard
│   └── extension/             # Chrome extension
├── scripts/
├── tests/
└── tsconfig.base.json
```

---

## Part 4: Data Flow Diagrams

### Flow 1: Record a New Skill (Dashboard)

```
User                Dashboard              Daemon               Browser
 │                     │                      │                    │
 │  Open /app/record   │                      │                    │
 │────────────────────>│                      │                    │
 │                     │  POST /api/v1/explore│                    │
 │                     │─────────────────────>│  Launch Playwright │
 │                     │                      │───────────────────>│
 │                     │  WS: engine:mode     │                    │
 │                     │  {mode: 'exploring'} │                    │
 │                     │<─────────────────────│                    │
 │                     │                      │                    │
 │  Click "Record"     │                      │                    │
 │────────────────────>│  POST /api/v1/record │                    │
 │                     │─────────────────────>│                    │
 │                     │  WS: engine:mode     │                    │
 │                     │  {mode: 'recording'} │                    │
 │                     │<─────────────────────│                    │
 │                     │                      │                    │
 │  (user acts in browser)                    │  CDP traffic       │
 │                     │  WS: recording:traffic (live stream)      │
 │                     │<─────────────────────│<───────────────────│
 │                     │                      │                    │
 │  Click "Stop"       │                      │                    │
 │────────────────────>│  POST /api/v1/stop   │                    │
 │                     │─────────────────────>│  Start pipeline    │
 │                     │  { jobId: 'abc123' } │                    │
 │                     │<─────────────────────│                    │
 │                     │                      │                    │
 │                     │  WS: pipeline:progress (polling)          │
 │                     │<─────────────────────│                    │
 │                     │  WS: pipeline:complete                    │
 │                     │  { skillIds: [...] } │                    │
 │                     │<─────────────────────│                    │
 │  View new skills    │                      │                    │
 │<────────────────────│                      │                    │
```

### Flow 2: Execute Skill with Confirmation (Extension)

```
User              Extension Popup       Service Worker         Daemon
 │                     │                      │                   │
 │  Click skill        │                      │                   │
 │────────────────────>│  msg: daemon:execute  │                   │
 │                     │─────────────────────>│  POST /execute    │
 │                     │                      │──────────────────>│
 │                     │                      │  202 + token      │
 │                     │                      │<──────────────────│
 │                     │  msg: confirm:needed  │                   │
 │                     │<─────────────────────│                   │
 │                     │                      │                   │
 │  Desktop notification: "Approve get-bitcoin-price?"           │
 │                     │                      │                   │
 │  Click "Approve"    │                      │                   │
 │────────────────────>│  msg: daemon:confirm  │                   │
 │                     │─────────────────────>│  POST /confirm   │
 │                     │                      │──────────────────>│
 │                     │                      │  200 + result     │
 │                     │                      │<──────────────────│
 │                     │  Show result          │                   │
 │<────────────────────│                      │                   │
```

### Flow 3: CDP Bridge Recording (Extension)

```
User              Content Script      Service Worker          Daemon
 │                     │                     │                   │
 │  Right-click        │                     │                   │
 │  "Record this page" │                     │                   │
 │────────────────────>│  msg: cdp:attach    │                   │
 │                     │────────────────────>│                   │
 │                     │                     │ chrome.debugger   │
 │                     │                     │ .attach(tabId)    │
 │                     │                     │                   │
 │                     │                     │ POST /api/sessions│
 │                     │                     │──────────────────>│
 │                     │                     │                   │
 │                     │                     │ Network.enable    │
 │                     │                     │ (CDP events flow) │
 │                     │                     │─── WS: cdp:event─>│
 │                     │                     │─── WS: cdp:event─>│
 │                     │                     │                   │
 │  Element selector   │                     │                   │
 │  overlay appears    │                     │                   │
 │  (content script)   │                     │                   │
 │                     │  Highlight inputs   │                   │
 │<────────────────────│                     │                   │
```

---

## Part 5: Implementation Sequence

### Phase 1 — Foundation (Week 1-2)

```
Priority: Get the dashboard rendering with real data

Backend:
  [ ] Add WS endpoint to rest-server.ts (engine events, pipeline progress)
  [ ] Add static file serving for /app/* from rest-server.ts
  [ ] Add CORS headers for extension origin (chrome-extension://*)

Frontend:
  [ ] Scaffold Vite + React + Tailwind + shadcn/ui
  [ ] API client + TanStack Query hooks
  [ ] Layout shell (sidebar, header, engine status)
  [ ] Dashboard page (status cards, skill summary)
  [ ] Sites list page
  [ ] Site detail page with skill list

Shared:
  [ ] Extract @schrute/types package
```

### Phase 2 — Core Interactions (Week 3-4)

```
Priority: Skill execution and recording from the UI

Frontend:
  [ ] Skill detail page with dynamic param form
  [ ] Execute + dry-run + confirmation dialog
  [ ] Recording studio page (explore → record → stop)
  [ ] WebSocket integration (live traffic feed, pipeline progress)
  [ ] Audit log page with filters

Backend:
  [ ] WS: broadcast recording:traffic events during capture
  [ ] WS: broadcast pipeline:progress events
  [ ] WS: broadcast skill:executed events
```

### Phase 3 — Chrome Extension (Week 5-6)

```
Priority: Popup + side panel + CDP bridge

Extension:
  [ ] Manifest V3 scaffold + Vite build
  [ ] Service worker: daemon connection, badge manager
  [ ] Popup: status bar, quick record toggle, recent skills
  [ ] Side panel: skill browser, execute form
  [ ] Context menus: record page, explore link
  [ ] CDP bridge: chrome.debugger attach/forward
  [ ] Desktop notifications for confirmations
```

### Phase 4 — Advanced Features (Week 7-8)

```
Frontend:
  [ ] Workflow builder (visual flow editor)
  [ ] Session manager page
  [ ] Settings/policy editor
  [ ] Skill export preview (code snippets)
  [ ] Coverage report visualization

Extension:
  [ ] Content script: element selector overlay
  [ ] Content script: param hint annotations
  [ ] Side panel: live traffic feed during recording
  [ ] Keyboard shortcuts (Ctrl+Shift+R to toggle recording)
```

---

## Part 6: Backend Changes Required

These are modifications needed in the existing Schrute daemon to support the frontend + extension:

| Change | File | Description |
|--------|------|-------------|
| WebSocket server | `src/server/rest-server.ts` | Add `ws` library, `/ws` endpoint, event broadcasting |
| Static serving | `src/server/rest-server.ts` | Serve `frontend/dist/` at `/app/*` |
| CORS for extension | `src/server/rest-server.ts` | Allow `chrome-extension://*` origin |
| Event emitter | `src/core/engine.ts` | Emit events for mode changes, executions, pipeline progress |
| CDP proxy endpoint | `src/server/rest-server.ts` | Accept forwarded CDP events from extension |
| Coverage API | `src/server/rest-server.ts` | `GET /api/v1/sites/:id/coverage` endpoint |
| Workflow suggestions API | `src/server/rest-server.ts` | `GET /api/v1/workflows/suggestions` endpoint |
