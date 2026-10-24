# Frontend Standard: `apps/web`

## Locked stack

```txt
React 19
Tailwind CSS 4
shadcn/ui on Radix (radix-ui, class-variance-authority, cn, lucide-react, tw-animate-css)
react-router-dom
Lazy-loaded routes/pages
Zustand
Zod
Axios
@/* import alias
```

Do **not** use by default: TanStack Query / Router / Table, Redis, Memcache. Use simple/static data patterns unless the user explicitly asks for advanced server-state, caching, or table libraries.

**Research first.** Before generating UI for a new project or a new screen type, do the design
research in [design-research.md](design-research.md) and write the brief to `knowledge/DESIGN.md`;
`frontend-design` then works from that brief.

When generating frontend UI inside `apps/web`, use the Claude skill named `frontend-design` as the UI/design authority — it drives aesthetic direction, typography, and layout so the result doesn't read as a templated default.

If `frontend-design` is not available (the skill isn't installed), **install it first, then use it** — do not silently skip it. It is an official Anthropic skill.

Source: https://github.com/anthropics/skills/tree/main/skills/frontend-design

Install it into the global skills directory (`~/.claude/skills/frontend-design`) so it's available in every project. Git sparse-checkout needs no extra tooling:

```bash
tmp="$(mktemp -d)"
git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills.git "$tmp"
git -C "$tmp" sparse-checkout set skills/frontend-design
mkdir -p ~/.claude/skills
cp -R "$tmp/skills/frontend-design" ~/.claude/skills/
rm -rf "$tmp"
```

Windows PowerShell equivalent:

```powershell
$tmp = Join-Path $env:TEMP ([System.Guid]::NewGuid())
git clone --depth 1 --filter=blob:none --sparse https://github.com/anthropics/skills.git $tmp
git -C $tmp sparse-checkout set skills/frontend-design
New-Item -ItemType Directory -Force -Path "$HOME/.claude/skills" | Out-Null
Copy-Item -Recurse -Force "$tmp/skills/frontend-design" "$HOME/.claude/skills/"
Remove-Item -Recurse -Force $tmp
```

After installing, invoke `frontend-design` for the UI work. If installation genuinely can't proceed (e.g. no network), follow the frontend rules in this file and state clearly that `frontend-design` is the project's UI standard and was unavailable.

`frontend-design` decides the visual direction; shadcn/ui is the technical foundation that
direction is built on. They don't compete: the direction lands in the token values of
`theme.css` and in how primitives are composed, never in a second component system.

## UI foundation: shadcn/ui

The UI is built on [shadcn/ui](https://ui.shadcn.com) (style `new-york`, Radix base). Its
components are copied into the project, not imported from a package, so they are ours to
adjust. Locked because the module library's components and the `bingkai-navy` preset are
built on it — a project on another foundation could not install them.

- `apps/web/components.json` configures the CLI. `npx shadcn@latest add <name>` writes the
  component to `shared/components/primitives/` and adds any dependency it needs, with no edit
  afterwards.
- Class merging uses `cn` from the [`cn`](https://github.com/shadcn-ui/cn) package — shadcn's
  drop-in replacement for `clsx` + `tailwind-merge`, and what the CLI writes into every
  component (`import { cn } from "cn"`). That is why `aliases.utils` is `"cn"`. Do not add
  `clsx`, `tailwind-merge`, or a local `cn()` helper.
- The scaffold ships the primitives its starter pages use: `badge`, `button`, `card`, `dialog`,
  `input`, `label`, `skeleton`, `spinner`. Add the rest when a screen needs them.
- Icons: `lucide-react`. Anything beyond the foundation (toasts, command palette, charts,
  fonts) arrives with the module or preset that needs it, not up front.

## Structure

```txt
apps/web/
├── public/
├── src/
│   ├── app/
│   │   ├── App.tsx
│   │   ├── providers/
│   │   │   ├── AppProvider.tsx
│   │   │   └── RouterProvider.tsx
│   │   └── routes/
│   │       ├── index.tsx        # builds the router from the registry
│   │       ├── modules.ts       # module registry (elco:* markers)
│   │       └── route-paths.ts   # app-level paths only
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   ├── schemas/
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   ├── types/
│   │   │   └── routes.tsx       # the module's paths + lazy pages
│   │   └── dashboard/
│   ├── shared/
│   │   ├── components/
│   │   │   ├── primitives/  # shadcn/ui as the CLI writes it (button, input, dialog, …)
│   │   │   ├── ui/          # generic compositions (data-table, form-field, page-header, …)
│   │   │   ├── patterns/    # page patterns (toolbar, stepper, sticky-footer, …)
│   │   │   └── feedback/    # LoadingState, EmptyState, ErrorState
│   │   ├── layouts/
│   │   ├── services/
│   │   │   ├── http-client.ts
│   │   │   └── api-endpoints.ts
│   │   ├── stores/
│   │   ├── hooks/
│   │   ├── lib/             # formatter.ts, storage.ts
│   │   ├── types/           # module-routes.ts, api.ts, pagination.ts
│   │   └── constants/
│   ├── theme/
│   │   └── theme.css        # Tailwind entry + the token contract
│   ├── styles/
│   │   └── globals.css
│   ├── main.tsx
│   └── vite-env.d.ts
├── components.json          # shadcn CLI config
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── eslint.config.js
```

`primitives/` holds shadcn components as the CLI writes them; `ui/` composes them into generic
building blocks; `patterns/` composes those into page-level patterns. A component never imports
from a tier above its own.

## Module components vs shared components

`modules/<module>/components/` holds components specific to that module's domain (e.g. `OrderTable`, `OrderForm`, `OrderStatusBadge`, `DeleteOrderModal`).

`shared/components/` holds generic, domain-agnostic UI (e.g. `Button`, `Input`, `Modal`, `Table`).

Rules:

- A component stays in a module if it imports that module's types, services, stores, hooks, schemas, or domain constants.
- Do not move a component to shared just because it is used more than once *inside the same module*.
- Move to shared only when it is truly domain-agnostic and reusable *across* modules.
- Shared UI must not know domain statuses like `ORDER_PAID`, `STOCK_LOW`, or `PAYMENT_FAILED`.

## Routing and lazy loading

Use `react-router-dom`; routes/pages must be lazy-loaded. Each module owns its routes in
`modules/<module>/routes.tsx` and is registered in `app/routes/modules.ts` — the frontend's one
registry, which the module library installs into:

```tsx
// modules/dashboard/routes.tsx
import { lazy } from "react";
import type { ModuleRoutes } from "@/shared/types/module-routes";

const DashboardPage = lazy(() => import("@/modules/dashboard/pages/DashboardPage"));

export const DASHBOARD_PATHS = {
  home: "/dashboard",
} as const;

export const dashboardRoutes: ModuleRoutes = {
  protected: [{ path: DASHBOARD_PATHS.home, element: <DashboardPage /> }],
};
```

```ts
// app/routes/modules.ts
// elco:routes:imports:begin
import { authRoutes } from "@/modules/auth/routes";
import { dashboardRoutes } from "@/modules/dashboard/routes";
// elco:routes:imports:end

export const moduleRoutes: ModuleRoutes[] = [
  // elco:routes:begin
  authRoutes,
  dashboardRoutes,
  // elco:routes:end
];
```

- `app/routes/index.tsx` builds the router from the registry, keeping public and protected
  routes apart so an auth guard can wrap the protected ones in a layout route.
- A module's paths live in its own `routes.tsx`; `app/routes/route-paths.ts` holds app-level
  paths only. Installing a module never edits a file outside the registry.
- Keep the `elco:*` markers; add registrations between them.
- Use layouts at the route level. Wrap lazy pages in Suspense/loading states.

## Zustand

- Global app state → `shared/stores`.
- Module-specific state → `modules/<module>/stores`.
- Do not put everything in one giant global store.
- Use local `useState` / `useReducer` for local UI state.

## Zod

Schemas live in `modules/<module>/schemas/`.

```ts
import { z } from "zod";

export const loginSchema = z.object({
  email: z.string().email("Email tidak valid"),
  password: z.string().min(8, "Password minimal 8 karakter"),
});

export type LoginFormValues = z.infer<typeof loginSchema>;
```

Do not duplicate manual form types when `z.infer` can derive them. Keep module-specific schemas in their module.

## Axios

Centralized client in `src/shared/services/http-client.ts`:

```ts
import axios from "axios";

export const httpClient = axios.create({
  // Empty = same origin. Proxied by Vite in dev, served by the same container in
  // production. Only set VITE_API_BASE_URL when web and api are deployed separately.
  baseURL: import.meta.env.VITE_API_BASE_URL || "",
  timeout: 30000,
  headers: { "Content-Type": "application/json" },
});

// Hooks for the auth module, so it plugs in without editing this file.
let authToken: string | null = null;
const unauthorizedHandlers = new Set<() => void>();

/** Sets the bearer token sent with every request; null clears it. */
export function setAuthToken(token: string | null): void {
  authToken = token;
}

/** Runs handler whenever the API answers 401. Returns a function that removes it. */
export function onUnauthorized(handler: () => void): () => void {
  unauthorizedHandlers.add(handler);
  return () => {
    unauthorizedHandlers.delete(handler);
  };
}

httpClient.interceptors.request.use((config) => {
  if (authToken) config.headers.Authorization = `Bearer ${authToken}`;
  return config;
});

httpClient.interceptors.response.use(undefined, (error: unknown) => {
  if (axios.isAxiosError(error) && error.response?.status === 401) {
    unauthorizedHandlers.forEach((handler) => handler());
  }
  return Promise.reject(error);
});
```

- All HTTP requests go through `shared/services/http-client.ts`.
- `setAuthToken` and `onUnauthorized` are how an auth module attaches its token and reacts to
  an expired session — it never adds its own interceptor or edits this file.
- Modules must not create their own Axios instances.
- Module API calls live in `modules/<module>/services`.
- API paths follow `/api/v1`.

### Dev connectivity: proxy, not CORS

`httpClient`'s `baseURL` defaults to empty (same origin). In dev, `vite.config.ts` proxies
`/api` to the backend (`VITE_DEV_API_TARGET`, default `http://localhost:8080`); no CORS
headers are needed on any backend by default. This keeps dev on the same single-origin model
as production, where one container serves both the API and the built SPA. Only set
`VITE_API_BASE_URL` when web and api are genuinely deployed as separate origins.

## Import alias

Use `@/*` consistently. Avoid long relative imports (`../../../../shared/...`).

```ts
import { Button } from "@/shared/components/primitives/button";
import { userService } from "@/modules/users/services/user.service";
import { ROUTE_PATHS } from "@/app/routes/route-paths";
```

## Theme: the token contract

`src/theme/theme.css` is the one source of color, type, radius, and elevation. It is also the
Tailwind entry (`@import "tailwindcss"`, `tw-animate-css`) and the file `components.json` points
the shadcn CLI at; `styles/globals.css` imports it and holds only app-wide extras. The scaffold
copies it from this skill's `scripts/templates/web/theme.css` — read that file for the full
content rather than a copy here.

**Token names are a contract; token values belong to the project.** The names follow the shadcn
convention plus a few extensions, and every shared and library component is built against
them. A preset or the researched direction in `knowledge/DESIGN.md` changes the values; nothing
renames or removes a name. The scaffold's values are neutral on purpose.

The contract — every one of these is defined in `:root` (or `@theme inline` for the font and
text tokens):

```txt
--radius
--background --foreground --card --card-foreground --popover --popover-foreground
--muted --muted-foreground --secondary --secondary-foreground --border --input
--primary --primary-hover --primary-foreground --accent --accent-foreground --ring
--success --success-soft --warning --warning-soft
--destructive --destructive-foreground --destructive-soft --info --info-soft
--chart-1 --chart-2 --chart-3 --chart-4 --chart-5
--sidebar --sidebar-foreground --sidebar-muted --sidebar-strong --sidebar-accent
--sidebar-accent-foreground --sidebar-active --sidebar-primary --sidebar-primary-foreground
--sidebar-border --sidebar-ring
--row-py
--shadow-card --shadow-md --shadow-pop --shadow-glow
--font-sans --font-display --font-mono --text-2xs
```

`@theme inline` maps the colors to Tailwind utilities, so components use semantic classes:
`bg-card`, `text-muted-foreground`, `border-border`, `bg-primary text-primary-foreground`,
`text-destructive`, `bg-success-soft text-success`, `font-display`, `text-2xs`. Table density
follows `<html data-density="compact|comfortable">` through `--row-py`.

- No raw colors in components: no hex, no palette utilities (`bg-blue-600`), no arbitrary
  values (`text-[#1e3a5f]`). If a needed color has no token, add the token to `theme.css`.
- `dark:` utilities apply under `<html class="dark">`. Dark values are defined by a preset or
  the project; the scaffold sets none.
- Changing the theme never requires editing a component.

## Presets

A preset is a ready-made set of token values plus the fonts that go with them, kept in the
module library (`elcodelabs-modules`, `themes/<name>/`), e.g. `bingkai-navy` for dense
back-office apps. Applying one replaces the values in `theme.css` and installs its fonts. The
library is still being built: until a preset is published there, set the values directly from
the design brief. Which preset (if any) a project uses
is a design decision recorded in `knowledge/DESIGN.md` — see
[design-research.md](design-research.md).
