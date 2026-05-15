---
title: Spreading HttpClient connections across Kubernetes pods
date: 2026-05-15
description: Cloud-friendly HttpClient extensions for .NET, independent connection pools, cloud-tuned defaults, and composition with Microsoft's resilience pipeline.
tags: [tech]
---

## Background

Back in 2024 I wrote [Load Balancing Long Lived Connections in Kubernetes](/blog/load-balancing-long-lived-connections-in-kubernetes). The short version: long-lived HTTP/2 connections from a .NET service to a Kubernetes Service do not spread across the upstream pods the way most people assume. DNS is consulted once. kube-proxy picks a backend. After that, every request rides the same TCP connection to the same pod until the handler decides to recycle.

That post ended with four workarounds: a client-side load balancer written by hand, a service mesh, scaling down so it stops mattering, or shortening the pooled connection lifetime. Useful, but the first is a lot of code to maintain, and the others involve tradeoffs that not every team wants.

The lightweight option I always reached for in real services was the one I never properly packaged: register N named `HttpClient` instances for the same logical upstream, give each its own `SocketsHttpHandler` and its own connection pool, then round-robin (or weight, or health-check) across them. Each pool independently does its own DNS lookup, opens its own TCP connection, and lands on whichever backend kube-proxy hands it. Not perfect, but each pool gets a fresh chance at the load balancer.

That hand-written pattern is what CloudHttp is now. Plus the `SocketsHttpHandler` defaults I keep typing in every new service, plus a few small ergonomic helpers around it.

<https://github.com/haiilong/CloudHttp>

```sh
dotnet add package haiilong.http.extensions
```

## The problem more concretely

A typical .NET service in Kubernetes calls another service through a cluster DNS name:

```csharp
services.AddHttpClient<InventoryClient>(c =>
{
    c.BaseAddress = new Uri("https://inventory.svc.cluster.local");
});
```

DNS resolves the Service to the kube-proxy ClusterIP. kube-proxy probabilistically picks one backend pod. The TCP connection is set up. `IHttpClientFactory` keeps the handler alive for two minutes by default. With HTTP/2 multiplexing, every request from this caller pod rides the same TCP connection for those two minutes, and every one of those requests lands on the same backend pod.

Even if the upstream Service has ten replicas, this caller-pod-to-upstream-replica edge is sticky.

Two reasonable workarounds at the connection layer:

1. Shorten the pool lifetime so the connection rotates more often, which gives kube-proxy a fresh chance to pick a different backend. This is what `PooledConnectionLifetime = 2 minutes` does.
2. Run several connection pools in parallel so different requests from the same caller pod can ride different connections. Three pools means three chances at the load balancer instead of one.

CloudHttp does the second, and pulls in the first for free via the cloud-tuned defaults.

## Wiring it up

The entry point is `DistributedHttpClient`. Register it like a normal HTTP client, but with a count:

```csharp
builder.Services.AddDistributedHttpClient(
    name: "inventory",
    configureOptions: opts =>
    {
        opts.Mode = DistributionMode.RoundRobin;
        opts.ClientCount = 4;
    },
    configureClient: c =>
    {
        c.BaseAddress = new Uri("https://inventory.svc.cluster.local");
        c.DefaultRequestHeaders.Accept.Add(new("application/json"));
    },
    configureBuilder: clientBuilder =>
    {
        clientBuilder.AddStandardResilienceHandler();
    });
```

Under the hood this creates four named clients (`inventory#0` through `inventory#3`), each with its own `SocketsHttpHandler` and its own connection pool. The `DistributedHttpClient` itself is registered as a keyed singleton, and you inject it where you would normally inject `HttpClient`:

```csharp
public sealed class InventoryService(
    [FromKeyedServices("inventory")] DistributedHttpClient http)
{
    public Task<StockLevel?> GetStockAsync(string sku, CancellationToken ct)
    {
        var path = HttpRouteBuilder.BuildPath(
            "/stock/{sku}",
            new Dictionary<string, object?> { ["sku"] = sku });

        return http.GetAsync<StockLevel>(path, ct);
    }
}
```

Every call to `http.GetAsync<T>(...)` picks one of the four underlying named clients based on the distribution mode, sends the request, and returns. From the caller's perspective, this looks identical to a normal `HttpClient` call.

The four underlying handlers each get the cloud-tuned defaults from `ConfigureForCloud()`. If you want to tweak them per pool, there is a `configurePrimaryHandler` callback that runs once for each handler, after the defaults:

```csharp
configurePrimaryHandler: handler =>
{
    handler.ConnectTimeout = TimeSpan.FromSeconds(3);
    handler.MaxConnectionsPerServer = 200;
}
```

## The three distribution modes

### Round-robin

This is the default mode. An atomic counter increments on every call and the index is `counter % ClientCount`. The increment is lock-free via `Interlocked.Increment`, with no allocation and no tuning required. Round-robin is the right choice when the upstream pods are interchangeable and roughly equal in capacity.

```csharp
services.AddRoundRobinDistribution(
    name: "payments",
    clientCount: 4,
    configureClient: c => c.BaseAddress = new Uri("https://payments.svc.cluster.local"));
```

### Weighted

Weighted distribution is useful for canary deployments or mixed-capacity pools. Each client index gets a relative weight, and selection is `Random.Shared.NextDouble() * totalWeight` plus a binary search into a sorted cumulative ladder.

```csharp
services.AddWeightedDistribution(
    name: "search",
    weights: new Dictionary<int, double> { [0] = 9, [1] = 1 },
    configureClient: c => c.BaseAddress = new Uri("https://search.svc.cluster.local"));
```

That example sends roughly 10% of traffic to the second pool. Useful when you want to dip into a different upstream gradually: a different cluster, a different version of a service, a different region.

### Health-aware

Health-aware mode is round-robin with a temporary degraded list. When a pool returns a transient status code or throws a transient exception, CloudHttp records `now + HealthDegradedTimeout` for that pool and skips it on subsequent picks until the timestamp expires. The default timeout is 30 seconds.

```csharp
services.AddHealthAwareDistribution(
    name: "inventory",
    clientCount: 4,
    degradedTimeout: TimeSpan.FromSeconds(30),
    configureClient: c => c.BaseAddress = new Uri("https://inventory.svc.cluster.local"));
```

Recovery is purely time-based. There is no positive "this pool is healthy again" signal that immediately reinstates it. Concurrent in-flight requests complete out of order, and a stale healthy marker should not overwrite a newer degraded one.

The clock is `Environment.TickCount64` rather than `DateTime.UtcNow`, so NTP nudges to the wall clock do not corrupt the degradation state.

If every pool ends up degraded at the same time, the selector falls back to round-robin instead of failing outright. Calling a possibly-degraded pool is better than refusing to call anything.

## A reality check on what this can do

Several sentences in this post say "more chances at the load balancer" rather than "always different backends". That hedging is real and worth being honest about.

The N-pool setup gives kube-proxy N opportunities to pick different backends. If the upstream Service has only two replicas and you have four pools, by the pigeonhole principle at least two pools share a backend. If kube-proxy's hash function happens to map two pools to the same backend, you live with that for the next connection lifetime.

A proper service mesh sidecar (Envoy under Istio, the Linkerd2-proxy) does L7 client-side load balancing and will distribute each request reliably. If you have a mesh, prefer the mesh. CloudHttp is the workaround for when you do not have one, cannot write a custom client-side load balancer, and still want better odds than a single TCP connection's worth of luck.

## Cloud-tuned handler defaults

The other thing the library does is bundle up the `SocketsHttpHandler` defaults I have ended up typing into every cloud service for the last few years. They are applied automatically inside `AddDistributedHttpClient`, but you can also use them on their own with a normal named client:

```csharp
services.AddHttpClient("orders", c => c.BaseAddress = new Uri("https://orders.svc"))
    .ConfigureForCloud();
```

The values it picks, and why:

| Property | Value | What it gets you |
|---|---|---|
| `PooledConnectionLifetime` | 2 minutes | DNS refresh on the cadence of rolling deploys; the .NET default is infinite, which means a connection opened on day 1 still hits the same pod on day 30. |
| `ConnectTimeout` | 5 seconds | Fail fast on broken routes. The .NET default is also infinite, which is the wrong shape for cluster traffic. |
| `MaxConnectionsPerServer` | 100 | Bounded concurrency per origin, with enough headroom for bursty service traffic. |
| `AutomaticDecompression` | All | gzip, deflate, brotli (and zstd on .NET 10). Adds `Accept-Encoding` automatically. |
| `EnableMultipleHttp2Connections` | true | Lets the handler open another HTTP/2 connection when stream limits saturate. |
| `InitialHttp2StreamWindowSize` | 128 KiB | Larger per-stream flow-control window. Fewer round trips on non-trivial response bodies. |
| `KeepAlivePingDelay` | 30 seconds | Detect dead connections proactively. The default is infinite, meaning no pings at all. |
| `KeepAlivePingTimeout` | 10 seconds | How long to wait for a pong before declaring the connection dead. |
| `KeepAlivePingPolicy` | WithActiveRequests | Only ping while requests are in flight. The default pings idle connections too, which is wasted work. |
| `ResponseDrainTimeout` | 5 seconds | Bound the time spent draining an unread response body when a request is disposed. The .NET default is 2 seconds; 5 is more pool-friendly. |

The builder version (`IHttpClientBuilder.ConfigureForCloud()`) adds two more knobs that only make sense at the factory layer:

| Property | Value | What it gets you |
|---|---|---|
| `HttpClient.Timeout` | 30 seconds | Bounded total per-request time. The .NET default is 100 seconds, which is far too long for cluster-internal calls. |
| Factory handler lifetime | `Timeout.InfiniteTimeSpan` | Stops `IHttpClientFactory` from rotating handlers on its own schedule. `PooledConnectionLifetime` handles connection recycling instead. |

The last one matters more than it looks. By default, `IHttpClientFactory` rotates the whole handler every two minutes for DNS-refresh reasons. If you also set `PooledConnectionLifetime = 2 minutes` on the handler, you are paying twice: the factory throws the whole pool away every two minutes, AND each connection has its own two-minute clock that never gets to run because the handler dies first. I wrote about this in more detail in [HttpClient connection lifetime, observed](/blog/httpclient-connection-lifetime-observed); the short version is "pin the factory lifetime to infinite, let `PooledConnectionLifetime` do the rotation".

Each setting has a longer explanation in [docs/cloud-defaults.md](https://github.com/haiilong/CloudHttp/blob/main/docs/cloud-defaults.md) inside the repo. Every default is overridable through the `customize` callback if your case is different.

## Composition with Microsoft.Extensions.Http.Resilience

CloudHttp does pool selection. It deliberately does not do retries, backoff, jitter, or circuit breaking. Microsoft's [`Microsoft.Extensions.Http.Resilience`](https://learn.microsoft.com/dotnet/core/resilience/http-resilience) package does all of that on top of Polly v8, and it does it well.

The two libraries compose cleanly. The `configureBuilder` callback runs per underlying named client, so the resilience handler attaches inside each pool:

```csharp
services.AddDistributedHttpClient("payments",
    configureOptions: opts => opts.ClientCount = 4,
    configureClient: c => c.BaseAddress = new Uri("https://payments.svc"),
    configureBuilder: cb => cb.AddStandardResilienceHandler(o =>
    {
        o.Retry.MaxRetryAttempts = 3;
        o.Retry.UseJitter = true;
        o.CircuitBreaker.FailureRatio = 0.2;
        o.CircuitBreaker.BreakDuration = TimeSpan.FromSeconds(30);

        o.AttemptTimeout.Timeout = TimeSpan.FromSeconds(5);
        o.TotalRequestTimeout.Timeout = TimeSpan.FromSeconds(30);
    }));
```

The execution order for a `GetAsync<T>` call:

1. The distributor picks client `#0`.
2. The resilience pipeline on `#0` runs, including jittered retries. Each retry stays on the same pool.
3. If the response or exception is still transient after that pipeline, CloudHttp rotates once to a different client.
4. The resilience pipeline on the rotated client runs.
5. Whatever the second client returns is what the caller gets. No further rotation.

Each named client has its own circuit breaker, so a stuck pool does not drag the others down with it.

The part of the math people miss: with `MaxRetryAttempts = 3`, the caller can see up to eight attempts total (four on the first pool, four on the rotated pool). With `c.Timeout = 30s`, the worst-case wall clock for two attempts is 60 seconds. If you want to bound the total wall clock, set it at the caller with `CancellationTokenSource.CancelAfter`:

```csharp
using var cts = CancellationTokenSource.CreateLinkedTokenSource(callerCt);
cts.CancelAfter(TimeSpan.FromSeconds(30));
await http.GetAsync<Foo>("/x", cts.Token);
```

Caller cancellation always wins. CloudHttp does not rotate when the caller's `CancellationToken` fires; it rethrows `OperationCanceledException` immediately.

## Reads can rotate, writes cannot

Two operations on `DistributedHttpClient` can rotate after a transient failure:

- `GetAsync<T>(path, ct)`
- `SendAsync(factory, ct)` (the explicit "build your own request" version)

The mutating JSON helpers (`PostAsync`, `PutAsync`, `PatchAsync`, `DeleteAsync`) do not auto-rotate. That is deliberate. A `POST` that times out may have already created the row, charged the card, or sent the email. Replaying it can duplicate side effects in ways CloudHttp has no way to detect from the outside.

If a write is genuinely safe to replay, make that explicit at the call site with an idempotency key and use `SendAsync` directly:

```csharp
public Task<HttpResponseMessage> ChargeAsync(
    ChargeRequest body,
    string idempotencyKey,
    CancellationToken ct)
{
    return http.SendAsync((client, token) =>
    {
        using var request = new HttpRequestMessage(HttpMethod.Post, "/charges")
        {
            Content = JsonContent.Create(body)
        };
        request.Headers.Add("Idempotency-Key", idempotencyKey);
        return client.SendAsync(request, token);
    }, ct);
}
```

The idempotency key belongs to the API contract between your caller and the upstream. CloudHttp cannot invent it.

## A few smaller helpers

Three small utilities that ended up in the library because they kept coming up in real service code:

**Route templates**:

```csharp
var path = HttpRouteBuilder.BuildPath(
    "/api/v{ver}/users/{id}",
    new Dictionary<string, object?> { ["ver"] = 2, ["id"] = userId });
```

It URL-encodes each value, uses no template engine, and allocates nothing per call beyond the final string.

**Query merging**:

```csharp
var uri = new Uri("https://api.example.com/search")
    .AddQuery(new[]
    {
        new KeyValuePair<string, string?>("q", searchTerm),
        new KeyValuePair<string, string?>("page", page.ToString()),
    });
```

**Best-effort error fallback**:

```csharp
public async Task<FeatureFlags> GetFlagsAsync(HttpClient client, ILogger logger, CancellationToken ct)
{
    return await client.GetWithErrorHandlingAsync(
        "/flags",
        defaultResponse: FeatureFlags.Empty,
        logger: logger,
        errorLogLevel: LogLevel.Warning,
        ct: ct);
}
```

This is not a general error strategy. It is for non-critical calls where a fallback value is genuinely acceptable, like feature flags or optional metadata. Caller cancellation is always propagated; only HTTP failures, JSON errors, and I/O errors fall through to the default value, and they always get logged.

## Out of scope, on purpose

It's worth being explicit about what the library deliberately stays away from.

- No retries, exponential backoff, jitter, or circuit breaking. Use `Microsoft.Extensions.Http.Resilience` and let CloudHttp compose with it.
- No distributed health state across caller pods. Each replica of your caller service tracks its own health-aware degradations. Pool `#2` being marked degraded on pod A does not propagate to pod B.
- No service discovery beyond cluster DNS. No Consul, no Kubernetes API integration, no Eureka.
- No guarantee of even distribution. The N-pool trick is best-effort. If you need actual L7 load balancing, a service mesh is the right tool.
- No automatic replay of mutating operations. `POST`, `PUT`, `PATCH`, `DELETE` will not retry across pools. That is by design.

These are not bugs. They are scope decisions. Doing fewer things means each one is easier to reason about, and Microsoft already ships a better retry / circuit-breaker library that this one composes with.

## When this is the right fit

You probably want CloudHttp if:

- Your .NET service calls another service through a cluster DNS name.
- You see one TCP connection from each caller pod sticking to the same upstream pod across long lifetimes.
- You do not have a service mesh handling L7 load balancing for you.
- You want a `SocketsHttpHandler` profile sane for cluster traffic without writing it from scratch every time.

Skip it when:

- You only call public internet APIs. The cluster-traffic defaults are not the right shape for slow, distant, less reliable upstreams.
- A single connection pool is enough for your throughput.
- You already run a service mesh sidecar that handles L7 balancing.
- Your upstream already does client-side balancing (e.g. gRPC name resolvers, AWS SDK-style retries with discovery).

## Try it

The repo includes a Docker Compose sample that runs several upstream containers behind one DNS name and prints which backend handled each request:

```powershell
$env:REQUESTS = "48"
$env:CLIENT_COUNT = "8"
$env:DISTRIBUTION_MODE = "RoundRobin"

docker compose `
  --file .\samples\CloudHttp.Sample\compose.yaml `
  up --build --abort-on-container-exit --exit-code-from client `
  --scale upstream=4 client
```

After the run, the client prints a summary like this:

```text
Summary
-------
cloudhttp-sample-upstream-1: 11 responses
cloudhttp-sample-upstream-2: 14 responses
cloudhttp-sample-upstream-3: 12 responses
cloudhttp-sample-upstream-4: 11 responses
Failures observed by client: 0
```

The distribution will not be perfectly even, since Docker DNS, connection pooling, and timing all interfere, but you can see a single logical upstream getting reached through several independent client pools. There is also an unstable variant that makes upstreams return 503 every Nth request, which is the cleanest way to watch `GetAsync` rotation in action.

The full walkthrough, including environment variables, the health-aware and weighted variants, and a Docker-less local script, is in [samples/CloudHttp.Sample/README.md](https://github.com/haiilong/CloudHttp/blob/main/samples/CloudHttp.Sample/README.md).

## Wrapping the HTTP series

This is the third post on this blog about HTTP in .NET, and probably the last for a while. The 2024 piece described the underlying load-balancing problem in Kubernetes. The HttpClient connection lifetime post was about understanding the machinery. CloudHttp turns the workaround into a library you can install.

The package itself is small: a handful of extension methods, one selector type, three distribution strategies, a curated set of cloud defaults, a few JSON helpers. The README and the three docs files in the repo go further than this post for anyone who wants more.

Repo: <https://github.com/haiilong/CloudHttp>
