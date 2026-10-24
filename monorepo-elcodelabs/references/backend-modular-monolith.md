# Backend Standard: Modular Monolith (`apps/api`)

The backend must be a **Modular Monolith** regardless of language or framework (Go, NestJS, Express/Node, or another stack the user explicitly requests). The architecture stays the same across stacks — only the implementation details differ.

The reason for the modular monolith is to get clean module boundaries (so the codebase stays maintainable and could later be split) without paying the operational cost of microservices up front.

## Core rule

Each module is a boundary. A module must not directly access another module's service, repository, database model, or domain internals. Inter-module communication happens **only** through explicit module clients / interfaces / contracts.

## Strict module structure

Each backend module uses this structure:

```txt
modules/order/
├── contracts/          # public contract/client/interface other modules may depend on
├── application/        # use cases, application services, internal orchestration
├── domain/             # entities, value objects, domain rules
│   └── events/         # domain events (must exist as a concept; not every module emits events)
├── infrastructure/     # repositories, database queries, external adapters
├── presentation/       # HTTP handlers, controllers, routes
└── order.module        # module wiring/bootstrap
```

`events/` must exist as an architectural concept. Not every module needs to define events.

## Public module boundary

Only `contracts/` is public to other modules.

Correct:

```txt
OrderModule -> ProductModule/contracts/ProductClient
OrderModule -> CustomerModule/contracts/CustomerClient
OrderModule -> PaymentModule/contracts/PaymentClient
```

Forbidden:

```txt
OrderModule -> ProductModule/application/ProductService
OrderModule -> ProductModule/infrastructure/ProductRepository
OrderModule -> ProductModule/domain/ProductEntity
```

Contracts are owned by the **provider** (capability) module, not defined inside the consumer:

```txt
product/contracts/ProductClient
customer/contracts/CustomerClient
payment/contracts/PaymentClient
```

## Core modules

`auth` and `users` are normal modules but considered core. Other modules must not query users/auth tables directly.

```txt
modules/
├── auth/
├── users/
├── roles/
├── permissions/
└── ...
```

Correct: `OrderModule -> UserClient.getUserById()`
Forbidden: `OrderRepository JOIN users`

## Backend shared folder

Backend `shared/` contains only technical utilities — never domain logic.

```txt
shared/
├── errors/
├── response/
├── request/
├── logger/
├── validator/
├── pagination/
└── utils/
```

(Go names the error package `apperror/` so it never shadows the standard library's `errors`.
The Go kernel and its module contract are in [backend-go.md](backend-go.md#the-kernel).)

Do not put order/product/payment/customer business rules in `shared/`.

## Database boundary

- A repository may only access tables owned by its own module.
- Cross-module joins are forbidden by default.
- Cross-module relations are stored as primitive IDs, not physical foreign keys.

```txt
orders.customer_id   # primitive ID, OK
orders.product_id    # primitive ID, OK
```

Do not create DB-level foreign keys to `customers` or `products` across module boundaries. Use module clients for validation/lookup instead:

```txt
CustomerClient.getById(customerId)
ProductClient.getById(productId)
```

## Transaction and orchestration

- DB transactions are scoped inside a single module.
- Cross-module flows are handled by an application service / orchestrator through module clients.
- Strong consistency uses explicit orchestration.
- Side effects may use an event/outbox pattern when the project genuinely needs it.

Example flow:

```txt
OrderApplicationService
  -> ProductClient.checkStock()
  -> OrderRepository.create()
  -> ProductClient.decreaseStock()
  -> PaymentClient.createPayment()
```

Never call another module's repository directly.
