---
title: HttpClient connection lifetime, observed
date: 2025-07-02
description: A small experiment to see what SetHandlerLifetime and PooledConnectionLifetime actually do to connection reuse.
tags: [tech]
---

## Background

`HttpClient` in .NET has two configuration knobs around connection lifetime. They look similar on paper, but they're solving different problems and the difference shows up the moment you watch a real connection:

- `SocketsHttpHandler.PooledConnectionLifetime`: how long an individual pooled connection stays alive before it gets closed and replaced.
- `IHttpClientBuilder.SetHandlerLifetime`: how long the entire `HttpMessageHandler` stays alive before `IHttpClientFactory` rotates it.

I've been using both for years, often together, without ever sitting down and actually watching what they do on the wire. I had a vague mental model from blog posts and the Microsoft docs, but never the receipts.

This is a small follow-up to [Load Balancing Long Lived Connections in Kubernetes](/blog/load-balancing-long-lived-connections-in-kubernetes) from 2024, where I leaned on `PooledConnectionLifetime` as one of the recommended fixes without ever showing what it actually does to a connection.

Repo with the code: <https://github.com/haiilong/dotnet-http-client-connection-test>

## How I set it up

Two projects in the solution:

- **TestServer**: a small ASP.NET Core API. On every incoming request, it grabs `HttpContext.Connection.Id` (Kestrel assigns a unique ID to each TCP connection it accepts) and echoes it back. Same TCP connection means same ID. New TCP connection means new ID.
- **TestClient**: a console app that hits the server in five different ways and logs the connection IDs it sees come back.

So the test is just: does each client setup reuse one connection, or does it open new ones, and if it rotates, when?

## The five setups

1. One `HttpClient` instance, used for every request.
2. A brand new `HttpClient` instance for each request (the famous anti-pattern).
3. A typed client registered with `IHttpClientFactory`.
4. A typed client with `SocketsHttpHandler.PooledConnectionLifetime = 3s`.
5. A typed client with a short `SetHandlerLifetime` and a long `PooledConnectionLifetime`. This is the one I actually wanted to look at.

The first three are sanity checks against the mental model. Number four shows what `PooledConnectionLifetime` does on its own. Number five is the question I had: if you set the pool lifetime to "long" but the handler lifetime to "short", which one wins?

## What actually happens

**Scenarios 1 to 3** lined up with what I expected.

One client reused for every request: same connection ID, every time. The TCP connection is held open by HTTP keep-alive and reused for the life of the process.

```
Request 1:  Connection OJN, 1st Request (took 3183ms)
Request 2:  Connection OJN, 2nd Request (took 5ms)
Request 3:  Connection OJN, 3rd Request (took 1ms)
Request 4:  Connection OJN, 4th Request (took 1ms)
Request 5:  Connection OJN, 5th Request (took 0ms)
```

The first request paid the cold-start cost (TLS handshake, JIT warmup, the usual first-time overhead). Every subsequent request hit the warm connection and finished in single-digit milliseconds.

A new client per request: fresh connection ID every time, and (if you watch `netstat`) a slow accumulation of sockets stuck in `TIME_WAIT` for the OS-default duration before the kernel cleans them up. The docs have called this out for years, but watching the count tick up locally is more concrete than reading about it.

```
Request 1:  Connection OJO, 1st Request (took 2027ms)
Request 2:  Connection OJP, 1st Request (took 2073ms)
Request 3:  Connection OJQ, 1st Request (took 2023ms)
Request 4:  Connection OJR, 1st Request (took 2031ms)
Request 5:  Connection OJS, 1st Request (took 2026ms)
```

Five different connection IDs (OJO through OJS) for five requests. There's no `Task.Delay` in this scenario; the ~2s per request is the actual cost of opening each new connection on this Windows setup, almost certainly dominated by the TLS handshake against the localhost dev cert (Windows does certificate chain validation, including possible revocation checks, surprisingly slowly). The contrast with scenario 1 is the lesson: a warm reused connection completed in under 5ms, while every cold connection here costs two full seconds. The "don't `new` HttpClient per request" rule isn't theoretical.

For context: in a Linux production setup talking to a known host in the same cloud region, a new TLS connection is usually well under 50ms, often less with TLS 1.3 and a warm DNS cache. The 2 second figure here is a Windows-localhost-dev-cert artifact. But cold-versus-warm is always going to be meaningfully slower in any environment; the magnitude just shifts with where you're running.

Typed client via `IHttpClientFactory`: same connection ID across requests. The factory keeps one `HttpMessageHandler` alive in its internal cache and hands out lightweight `HttpClient` wrappers around it. From the connection's point of view, every request through this client looks the same.

```
Request 1:  Connection OJT, 1st Request (took 2051ms)
Request 2:  Connection OJT, 2nd Request (took 1ms)
Request 3:  Connection OJT, 3rd Request (took 1ms)
Request 4:  Connection OJT, 4th Request (took 1ms)
Request 5:  Connection OJT, 5th Request (took 1ms)
```

Same shape as scenario 1: one connection (OJT), warm-up on the first hit, sub-millisecond for the rest.

**Scenario 4** is the interesting one. With `PooledConnectionLifetime = 3s`, the connection ID stayed the same for around three seconds, then flipped. Then stayed the same for another three seconds, then flipped again. One connection rotated at a time, the handler itself stayed put, no hiccup in the request stream.

```
Request 1:  Connection OJU, 1st Request at 12:26:01 (took 2016ms)
Request 2:  Connection OJU, 2nd Request at 12:26:03 (took 3ms)
Request 3:  Connection OJV, 1st Request at 12:26:07 (took 2030ms)
Request 4:  Connection OJV, 2nd Request at 12:26:09 (took 3ms)
Request 5:  Connection OK0, 1st Request at 12:26:13 (took 2040ms)
```

The pattern is exactly what `PooledConnectionLifetime` is supposed to produce. Requests 1 and 2 share OJU because they happen within the 3 second window. Request 3, four seconds after request 2, arrives after OJU's pooled lifetime has expired, so the pool rotates and produces OJV. Requests 3 and 4 share OJV because they too land within a 3 second window. Request 5 hits after OJV has expired and OK0 takes over. Throughout all five requests the handler itself is the same; only the connections inside its pool cycle.

**Scenario 5** is where I learned something. Before running it, I had quietly assumed that a long `PooledConnectionLifetime` would protect existing connections even when the handler rotated underneath. It does not. As soon as `SetHandlerLifetime` expired and the factory swapped in a fresh handler, every subsequent request landed on a brand new connection ID, regardless of how much time those pooled connections had left on the clock.

```
Request 1:  Connection OK1, 1st Request at 12:26:15 (took 2050ms)
Request 2:  Connection OK2, 1st Request at 12:26:19 (took 2043ms)
Request 3:  Connection OK3, 1st Request at 12:26:23 (took 2050ms)
Request 4:  Connection OK4, 1st Request at 12:26:27 (took 2042ms)
Request 5:  Connection OK5, 1st Request at 12:26:31 (took 2036ms)
```

Five requests, five different connections (OK1, OK2, OK3, OK4, OK5). Requests are four seconds apart, `SetHandlerLifetime` is one second, so by the time each request lands, the previous handler has already aged out of the factory's active slot. A fresh handler means a fresh pool means a fresh connection. The long `PooledConnectionLifetime` setting doesn't get a chance to matter because the pool it lives in has already been discarded.

Which makes sense once you think about it. `PooledConnectionLifetime` is a property *on the handler's connection pool*. The pool lives inside the handler. Once the handler is disposed, the pool goes with it, and so do the connections. There is no shared connection state across handlers in the factory's cache.

So the two settings really are not interchangeable. `PooledConnectionLifetime` rotates connections gracefully under a stable handler. `SetHandlerLifetime` resets the whole pool. If both fire, the handler one wins, because the pool only exists inside the handler.

## A short detour into how `IHttpClientFactory` actually works

I had to map this out before scenario 5 stopped feeling surprising, so it's worth a paragraph.

When you call `AddHttpClient(...)`, the factory keeps an internal cache mapping the client name to an "active handler entry". Each entry holds:

- The actual `HttpMessageHandler` (which has its own connection pool, in the case of `SocketsHttpHandler`).
- A timestamp for when it was created.
- The configured `HandlerLifetime` (default 2 minutes).

When you ask for an `HttpClient`, the factory checks the cache. If the active entry is still within its lifetime, you get a fresh `HttpClient` wrapping the same handler, and therefore the same pool. If it's expired, the factory:

1. Moves the expired entry to an "expired handlers" list.
2. Creates a new active entry with a fresh handler.
3. Starts a cleanup timer.

The expired handler is not disposed right away. The factory holds onto it for a grace period (4 minutes, hardcoded last I checked) so any in-flight `HttpClient` instances that already hold a reference can finish their requests. Once that grace period passes and no references remain, the expired handler is disposed, which closes every connection in its pool.

That grace period is why in scenario 5 you don't see existing requests get interrupted. New requests start landing on a new handler's pool, which means a new connection. The old handler is still alive in the factory's expired list, waiting to be cleaned up.

## What I actually want in production

For long-running .NET services that talk to other services over HTTP (which, in a Kubernetes world, is most of them), the configuration I keep coming back to is:

```csharp
services
    .AddHttpClient<MyClient>()
    .ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    })
    .SetHandlerLifetime(Timeout.InfiniteTimeSpan);
```

One handler that stays alive for the whole app, with `PooledConnectionLifetime` quietly rotating connections underneath it. If you set both to short values, you stack the handler-disposal pain on top of pool rotation, paying twice for what one of them already does.

## Why `Timeout.InfiniteTimeSpan`, and what the default is

The default for `SetHandlerLifetime` is **2 minutes**. If you call `AddHttpClient(...)` and never touch the lifetime, the factory will rotate the handler every two minutes for the life of your app.

That default exists for historical reasons. `IHttpClientFactory` shipped in .NET Core 2.1 (2018) to solve two `HttpClient` problems people kept hitting in production: socket exhaustion from `new HttpClient()` per request, and stale DNS on long-lived clients that never re-resolve. Its answer to the DNS problem was the heavy hammer: rotate the entire handler on a fixed schedule, dispose the old one after a grace period, force a fresh DNS lookup on the next request. Two minutes was a reasonable balance between DNS freshness and the cost of throwing the pool away.

The same release also introduced `SocketsHttpHandler`, the fully managed HTTP handler that's been the underlying implementation under `HttpClient` ever since. It exposes `PooledConnectionLifetime`, which does the DNS-refresh job at a finer grain than handler rotation: each pooled connection has its own age, and they cycle individually without disposing the handler or losing its TLS session tickets. For DNS refresh specifically, that's better in basically every measurable way than rotating the whole handler.

Worth being precise about which release did what, because it took me a while to untangle: **`SocketsHttpHandler` only became the default *primary* handler for `IHttpClientFactory` in [.NET 9 Preview 6](https://learn.microsoft.com/en-us/dotnet/core/compatibility/networking/9.0/default-handler)**. Before that, the factory's default primary handler was `HttpClientHandler`, which is a thin wrapper around `SocketsHttpHandler` that does not expose `PooledConnectionLifetime`. So on .NET 8 and earlier, the only way to get `PooledConnectionLifetime` in your factory setup was to explicitly opt in with `ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler { ... })`, which is exactly what the config block above does.

.NET 9 also added a nice touch: when the default primary handler is `SocketsHttpHandler`, the factory now auto-sets `PooledConnectionLifetime` to match `HandlerLifetime` if you don't configure either. The motivation, [per the docs](https://learn.microsoft.com/en-us/dotnet/core/compatibility/networking/9.0/default-handler#reason-for-change), is the singleton-capture footgun: if someone injects a typed client into a singleton service, the factory can no longer rotate that handler, and pre-.NET 9 the connections inside it would keep their stale DNS forever. With `PooledConnectionLifetime` linked to `HandlerLifetime` by default, the underlying connections still rotate even when the handler doesn't.

The 2 minute default for `SetHandlerLifetime` itself never went away. Partly back-compat, partly because not every primary handler is `SocketsHttpHandler`. People still pick `HttpClientHandler` explicitly for cookie or proxy property access, or run on .NET Framework where `SocketsHttpHandler` isn't supported at all. The factory can't assume the modern primitive is available.

If you're on a recent .NET and using `SocketsHttpHandler` (default since .NET 9, opt-in via `ConfigurePrimaryHttpMessageHandler` before that), the recommendation is still to set `SetHandlerLifetime(Timeout.InfiniteTimeSpan)` and let `PooledConnectionLifetime` do the rotation. Microsoft says as much in [the current HttpClient guidelines](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines).

Practical rules of thumb:

- If you control your handler and you're on a recent .NET, set `SetHandlerLifetime(Timeout.InfiniteTimeSpan)` and configure `PooledConnectionLifetime` to something sensible like 1 to 5 minutes.
- If you don't configure anything, the 2 minute default still gives you DNS refresh, just less efficiently. It's not broken, it's doing things the old way.
- If you're stuck with `HttpClientHandler` (legacy bind, custom handler chain), keep the default `SetHandlerLifetime`. It's the only mechanism you have for DNS refresh.

## Closing

The thing I keep noticing when I write these small experiments up is how much more I retain after watching the thing run. I have read about `PooledConnectionLifetime` versus `SetHandlerLifetime` more times than I can count. The difference didn't click until I saw the connection IDs flip on the screen.

Repo, again, if you want to clone and poke at it yourself: <https://github.com/haiilong/dotnet-http-client-connection-test>
