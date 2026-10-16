---
title: HttpClient connection lifetime, observed
date: 2025-07-02
description: A small experiment to see what SetHandlerLifetime and PooledConnectionLifetime actually do to connection reuse.
tags: [tech]
---

## Background

`HttpClient` in .NET has two settings for connection lifetime. They look similar, but they solve different problems, and you can see the difference as soon as you watch a real connection:

- `SocketsHttpHandler.PooledConnectionLifetime`: how long an individual pooled connection stays alive before it gets closed and replaced.
- `IHttpClientBuilder.SetHandlerLifetime`: how long the entire `HttpMessageHandler` stays alive before `IHttpClientFactory` rotates it.

I've used both for years, often together, but never watched what they do on the wire. Everything I knew about them came from blog posts and the Microsoft docs.

This is a small follow-up to [Load Balancing Long Lived Connections in Kubernetes](/blog/load-balancing-long-lived-connections-in-kubernetes) from 2024, where I recommended `PooledConnectionLifetime` as one of the fixes without showing what it does to a connection.

Repo with the code: <https://github.com/haiilong/dotnet-http-client-connection-test>

## How I set it up

Two projects in the solution:

- **TestServer**: a small ASP.NET Core API that echoes back `HttpContext.Connection.Id` on every request. Kestrel assigns a unique ID to each TCP connection it accepts, so the same connection always returns the same ID.
- **TestClient**: a console app that hits the server in five different ways and logs the connection IDs it gets back.

The test checks whether each client setup reuses one connection or opens new ones, and if it rotates, when.

## The five setups

1. One `HttpClient` instance, used for every request.
2. A brand new `HttpClient` instance for each request (the famous anti-pattern).
3. A typed client registered with `IHttpClientFactory`.
4. A typed client with `SocketsHttpHandler.PooledConnectionLifetime = 3s`.
5. A typed client with a short `SetHandlerLifetime` and a long `PooledConnectionLifetime`.

The first three are sanity checks. Number four shows what `PooledConnectionLifetime` does on its own. Number five is the question I actually had: if the pool lifetime is long and the handler lifetime is short, which one wins?

## What happens

**Scenarios 1 to 3** matched what I expected.

With one client reused for every request, the connection ID is the same every time. HTTP keep-alive holds the TCP connection open, and it gets reused for the life of the process.

```
Request 1:  Connection OJN, 1st Request (took 3183ms)
Request 2:  Connection OJN, 2nd Request (took 5ms)
Request 3:  Connection OJN, 3rd Request (took 1ms)
Request 4:  Connection OJN, 4th Request (took 1ms)
Request 5:  Connection OJN, 5th Request (took 0ms)
```

The first request paid the cold-start cost (TLS handshake, JIT warmup, the usual first-time overhead). Every request after that used the warm connection and finished in single-digit milliseconds.

With a new client per request, the connection ID changes every time. If you watch `netstat`, sockets pile up in `TIME_WAIT` until the kernel cleans them up after the OS-default timeout. The docs have warned about this for years, but watching the count go up locally is more convincing than reading about it.

```
Request 1:  Connection OJO, 1st Request (took 2027ms)
Request 2:  Connection OJP, 1st Request (took 2073ms)
Request 3:  Connection OJQ, 1st Request (took 2023ms)
Request 4:  Connection OJR, 1st Request (took 2031ms)
Request 5:  Connection OJS, 1st Request (took 2026ms)
```

That's five connection IDs (OJO through OJS) for five requests. There's no `Task.Delay` in this scenario, so the ~2s per request is the cost of opening a new connection on this Windows setup. Most of it is almost certainly the TLS handshake against the localhost dev cert, since Windows is surprisingly slow at certificate chain validation (including possible revocation checks). In scenario 1 a warm connection finished in under 5ms, and here every cold connection costs two seconds. The "don't `new` HttpClient per request" rule isn't theoretical.

In a Linux production setup talking to a known host in the same cloud region, a new TLS connection usually takes well under 50ms, often less with TLS 1.3 and a warm DNS cache. The 2 second figure comes from Windows and the localhost dev cert. Cold connections are still slower than warm ones in any environment; only the size of the gap changes.

With a typed client from `IHttpClientFactory`, the connection ID stays the same across requests. The factory caches one `HttpMessageHandler` and hands out lightweight `HttpClient` wrappers around it, so every request goes through the same connection pool.

```
Request 1:  Connection OJT, 1st Request (took 2051ms)
Request 2:  Connection OJT, 2nd Request (took 1ms)
Request 3:  Connection OJT, 3rd Request (took 1ms)
Request 4:  Connection OJT, 4th Request (took 1ms)
Request 5:  Connection OJT, 5th Request (took 1ms)
```

It looks the same as scenario 1: one connection (OJT), a slow first request, and about 1ms for the rest.

**Scenario 4** is the interesting one. With `PooledConnectionLifetime = 3s`, the connection ID stayed the same for about three seconds, then changed, and kept doing that. Connections rotated one at a time while the handler stayed the same.

```
Request 1:  Connection OJU, 1st Request at 12:26:01 (took 2016ms)
Request 2:  Connection OJU, 2nd Request at 12:26:03 (took 3ms)
Request 3:  Connection OJV, 1st Request at 12:26:07 (took 2030ms)
Request 4:  Connection OJV, 2nd Request at 12:26:09 (took 3ms)
Request 5:  Connection OK0, 1st Request at 12:26:13 (took 2040ms)
```

This is what `PooledConnectionLifetime` is supposed to do. Requests 1 and 2 share OJU because they land within the 3 second window. Request 3 comes four seconds after request 2, after OJU has expired, so the pool opens OJV. Requests 3 and 4 share OJV, and request 5 arrives after OJV has expired and gets OK0. The handler is the same for all five requests; only the connections in its pool change.

**Scenario 5** surprised me. I had assumed a long `PooledConnectionLifetime` would keep existing connections alive even when the handler rotated. It doesn't. Once `SetHandlerLifetime` expired and the factory swapped in a new handler, every request after that landed on a new connection, no matter how much time the old pooled connections had left.

```
Request 1:  Connection OK1, 1st Request at 12:26:15 (took 2050ms)
Request 2:  Connection OK2, 1st Request at 12:26:19 (took 2043ms)
Request 3:  Connection OK3, 1st Request at 12:26:23 (took 2050ms)
Request 4:  Connection OK4, 1st Request at 12:26:27 (took 2042ms)
Request 5:  Connection OK5, 1st Request at 12:26:31 (took 2036ms)
```

Five requests went to five connections (OK1 to OK5). The requests are four seconds apart and `SetHandlerLifetime` is one second, so each request arrives after the previous handler has expired. A new handler comes with a new pool, and a new pool opens a new connection. The long `PooledConnectionLifetime` never comes into play because its pool is already gone.

This makes sense in hindsight. `PooledConnectionLifetime` is a setting on the handler's connection pool, and the pool lives inside the handler. When the handler is disposed, the pool and its connections go with it. Handlers in the factory's cache don't share any connection state.

So the two settings are not interchangeable. `PooledConnectionLifetime` rotates connections one at a time under a stable handler, while `SetHandlerLifetime` throws away the whole pool. If both fire, the handler lifetime wins.

## A short detour into how `IHttpClientFactory` works

Looking at how the factory manages handlers explains scenario 5.

When you call `AddHttpClient(...)`, the factory keeps an internal cache mapping the client name to an "active handler entry". Each entry holds:

- The actual `HttpMessageHandler` (which has its own connection pool, in the case of `SocketsHttpHandler`).
- A timestamp for when it was created.
- The configured `HandlerLifetime` (default 2 minutes).

When you ask for an `HttpClient`, the factory checks the cache. If the active entry is still within its lifetime, you get a new `HttpClient` wrapping the same handler, and therefore the same pool. If it's expired, the factory:

1. Moves the expired entry to an "expired handlers" list.
2. Creates a new active entry with a fresh handler.
3. Starts a cleanup timer.

The factory doesn't dispose the expired handler right away. It holds onto it for a grace period (4 minutes, hardcoded last I checked) so any in-flight `HttpClient` instances that already hold a reference can finish their requests. Once the grace period passes and no references remain, the factory disposes the handler, which closes every connection in its pool.

Because of that grace period, existing requests in scenario 5 don't get interrupted. New requests go to the new handler's pool and get a new connection, while the old handler sits in the expired list until it's cleaned up.

## What I use in production

For long-running .NET services that call other services over HTTP (in Kubernetes, that's most of them), this is the config I keep coming back to:

```csharp
services
    .AddHttpClient<MyClient>()
    .ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler
    {
        PooledConnectionLifetime = TimeSpan.FromMinutes(2),
    })
    .SetHandlerLifetime(Timeout.InfiniteTimeSpan);
```

The handler lives for the whole app, and `PooledConnectionLifetime` rotates the connections inside it. If you set both to short values, you pay for handler disposal on top of pool rotation, when pool rotation alone already does the job.

## Why `Timeout.InfiniteTimeSpan`, and what the default is

The default for `SetHandlerLifetime` is **2 minutes**, so if you call `AddHttpClient(...)` and never set it, the factory rotates the handler every two minutes for the life of your app.

The default is historical. `IHttpClientFactory` shipped in .NET Core 2.1 (2018) to fix two `HttpClient` problems people kept hitting in production: socket exhaustion from `new HttpClient()` per request, and stale DNS on long-lived clients that never re-resolve. It fixed DNS the blunt way, by rotating the entire handler on a fixed schedule, disposing the old one after a grace period, and forcing a fresh DNS lookup on the next request. Two minutes was a reasonable balance between DNS freshness and the cost of throwing the pool away.

The same release introduced `SocketsHttpHandler`, the fully managed handler that `HttpClient` has used under the hood ever since. It exposes `PooledConnectionLifetime`, which refreshes DNS per connection instead of per handler. Each pooled connection has its own age and gets replaced on its own, without disposing the handler or losing its TLS session tickets. For DNS refresh, that beats rotating the whole handler in basically every way.

It took me a while to work out which release did what. **`SocketsHttpHandler` only became the default *primary* handler for `IHttpClientFactory` in [.NET 9 Preview 6](https://learn.microsoft.com/en-us/dotnet/core/compatibility/networking/9.0/default-handler)**. Before that, the factory's default primary handler was `HttpClientHandler`, which is a thin wrapper around `SocketsHttpHandler` that does not expose `PooledConnectionLifetime`. So on .NET 8 and earlier, the only way to get `PooledConnectionLifetime` in your factory setup was to opt in with `ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler { ... })`, which is what the config above does.

.NET 9 also made the factory set `PooledConnectionLifetime` to match `HandlerLifetime` when the default primary handler is `SocketsHttpHandler` and you don't configure either. [Per the docs](https://learn.microsoft.com/en-us/dotnet/core/compatibility/networking/9.0/default-handler#reason-for-change), this is for the singleton-capture footgun. If someone injects a typed client into a singleton service, the factory can't rotate that handler, and before .NET 9 its connections kept their stale DNS forever. With the two lifetimes linked by default, the connections still rotate even when the handler doesn't.

The 2 minute default for `SetHandlerLifetime` is still there, partly for back-compat and partly because not every primary handler is `SocketsHttpHandler`. People still pick `HttpClientHandler` explicitly to get at its cookie or proxy properties, or run on .NET Framework where `SocketsHttpHandler` isn't supported at all, so the factory can't assume it's available.

If you're on a recent .NET and using `SocketsHttpHandler` (default since .NET 9, opt-in via `ConfigurePrimaryHttpMessageHandler` before that), you should still set `SetHandlerLifetime(Timeout.InfiniteTimeSpan)` and let `PooledConnectionLifetime` do the rotation. Microsoft says the same in [the current HttpClient guidelines](https://learn.microsoft.com/en-us/dotnet/fundamentals/networking/http/httpclient-guidelines).

Rules of thumb:

- If you control your handler and you're on a recent .NET, set `SetHandlerLifetime(Timeout.InfiniteTimeSpan)` and configure `PooledConnectionLifetime` to something sensible like 1 to 5 minutes.
- If you don't configure anything, the 2 minute default still gives you DNS refresh, just less efficiently. It's not broken, it's doing things the old way.
- If you're stuck with `HttpClientHandler` (legacy bind, custom handler chain), keep the default `SetHandlerLifetime`. It's the only mechanism you have for DNS refresh.

## Closing

Every time I write up one of these small experiments, I notice how much more sticks after watching the thing run. I'd read about `PooledConnectionLifetime` versus `SetHandlerLifetime` plenty of times, but the difference only made sense once I watched the connection IDs change on screen.

Repo, again, if you want to clone and poke at it yourself: <https://github.com/haiilong/dotnet-http-client-connection-test>
