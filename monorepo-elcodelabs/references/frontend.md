# Frontend Standard: `apps/web`

## Locked stack

```txt
React 19
Tailwind CSS 4
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
│   │       ├── index.tsx
│   │       ├── public.routes.tsx
│   │       ├── protected.routes.tsx
│   │       └── route-paths.ts
│   ├── modules/
│   │   ├── auth/
│   │   │   ├── pages/
│   │   │   ├── components/
│   │   │   ├── services/
│   │   │   ├── schemas/
│   │   │   ├── stores/
│   │   │   ├── hooks/
│   │   │   ├── types/
│   │   │   └── index.ts
│   │   ├── dashboard/
│   │   └── users/
│   ├── shared/
│   │   ├── components/
│   │   │   ├── ui/          # button, input, textarea, select, checkbox,
│   │   │   │                # modal, drawer, badge, card, table, index.ts
│   │   │   └── feedback/    # LoadingState, EmptyState, ErrorState
│   │   ├── layouts/
│   │   ├── services/
│   │   │   ├── http-client.ts
│   │   │   └── api-endpoints.ts
│   │   ├── stores/
│   │   ├── hooks/
│   │   ├── lib/             # cn.ts, formatter.ts, storage.ts
│   │   ├── types/           # api.ts, pagination.ts, common.ts
│   │   └── constants/
│   ├── theme/               # colors.ts, theme.css, index.ts
│   ├── styles/
│   │   └── globals.css
│   ├── main.tsx
│   └── vite-env.d.ts
├── index.html
├── package.json
├── tsconfig.json
├── vite.config.ts
└── eslint.config.js
```

## Module components vs shared components

`modules/<module>/components/` holds components specific to that module's domain (e.g. `OrderTable`, `OrderForm`, `OrderStatusBadge`, `DeleteOrderModal`).

`shared/components/` holds generic, domain-agnostic UI (e.g. `Button`, `Input`, `Modal`, `Table`).

Rules:

- A component stays in a module if it imports that module's types, services, stores, hooks, schemas, or domain constants.
- Do not move a component to shared just because it is used more than once *inside the same module*.
- Move to shared only when it is truly domain-agnostic and reusable *across* modules.
- Shared UI must not know domain statuses like `ORDER_PAID`, `STOCK_LOW`, or `PAYMENT_FAILED`.

## Routing and lazy loading

Use `react-router-dom`; routes/pages must be lazy-loaded.

```tsx
import { lazy } from "react";

const DashboardPage = lazy(() => import("@/modules/dashboard/pages/DashboardPage"));
const UserListPage = lazy(() => import("@/modules/users/pages/UserListPage"));
```

- Store route paths in `app/routes/route-paths.ts`.
- Separate public routes and protected routes.
- Use layouts at the route level.
- Wrap lazy pages in Suspense/loading states.

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
```

- All HTTP requests go through `shared/services/http-client.ts`.
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
import { Button } from "@/shared/components/ui/button";
import { userService } from "@/modules/users/services/user.service";
import { ROUTE_PATHS } from "@/app/routes/route-paths";
```

## Theme color standard

Theme color must be centralized in `src/theme/` (`colors.ts`, `theme.css`, `index.ts`).

`globals.css`:

```css
@import "tailwindcss";
@import "../theme/theme.css";
```

`theme.css`:

```css
:root {
  --color-primary: #2563eb;
  --color-primary-hover: #1d4ed8;
  --color-primary-soft: #dbeafe;

  --color-secondary: #64748b;
  --color-background: #f8fafc;
  --color-surface: #ffffff;
  --color-border: #e2e8f0;
  --color-text: #0f172a;
  --color-muted: #64748b;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;
}
```

- Do not spread brand colors across many files or hardcode them repeatedly.
- Use CSS variables / centralized theme exports.
- Changing the theme color should not require editing many components.
