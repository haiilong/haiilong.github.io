---
title: Spreading HttpClient connections across Kubernetes pods
date: 2026-05-15
description: Cloud-friendly HttpClient extensions for .NET, independent connection pools, cloud-tuned defaults, and composition with Microsoft's resilience pipeline.
tags: [tech]
---

## Background

Back in 2024 I wrote [Load Balancing Long Lived Connections in Kubernetes](/blog/load-balancing-long-lived-connections-in-kubernetes). In short, long-lived HTTP/2 connections from a .NET service to a Kubernetes Service do not spread across the upstream pods the way most people assume. DNS is resolved once and kube-proxy picks a backend, then every request rides the same TCP connection to the same pod until the handler recycles it.

That post ended with four workarounds: a hand-written client-side load balancer, a service mesh, scaling down so it stops mattering, or shortening the pooled connection lifetime. They all work, but the first is a lot of code to maintain and the others come with tradeoffs not every team wants.

In real services I always used a lighter option that I never properly packaged. You register N named `HttpClient` instances for the same logical upstream, give each its own `SocketsHttpHandler` and connection pool, then round-robin (or weight, or health-check) across them. Each pool does its own DNS lookup, opens its own TCP connection, and lands on whichever backend kube-proxy hands it. It's not perfect, but each pool gets its own chance at the load balancer.

CloudHttp is that hand-written pattern, plus the `SocketsHttpHandler` defaults I keep typing in every new service, plus a few small ergonomic helpers around it.

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

DNS resolves the Service to its ClusterIP, kube-proxy picks a backend pod at random, and the TCP connection is set up. `IHttpClientFactory` keeps the handler alive for two minutes by default, and with HTTP/2 multiplexing every request from this caller pod goes over that one connection to the same backend pod for those two minutes.

Even if the upstream Service has ten replicas, each caller pod sticks to one of them.

There are two workarounds at the connection layer:

1. Shorten the pool lifetime so the connection rotates more often, which gives kube-proxy a fresh chance to pick a different backend. This is what `PooledConnectionLifetime = 2 minutes` does.
2. Run several connection pools in parallel so different requests from the same caller pod can ride different connections. Three pools means three chances at the load balancer instead of one.

CloudHttp does the second, and gets the first for free from its cloud-tuned defaults.

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

Every call to `http.GetAsync<T>(...)` picks one of the four underlying named clients based on the distribution mode, sends the request, and returns. To the caller it looks the same as a normal `HttpClient` call.

Each of the four handlers gets the cloud-tuned defaults from `ConfigureForCloud()`. To tweak them, use the `configurePrimaryHandler` callback, which runs once per handler after the defaults are applied:

```csharp
configurePrimaryHandler: handler =>
{
    handler.ConnectTimeout = TimeSpan.FromSeconds(3);
    handler.MaxConnectionsPerServer = 200;
}
```

## The three distribution modes

### Round-robin

Round-robin is the default. Every call increments a counter with `Interlocked.Increment` (lock-free, no allocation, nothing to tune) and uses `counter % ClientCount` as the index. Use it when the upstream pods are interchangeable and roughly equal in capacity.

```csharp
services.AddRoundRobinDistribution(
    name: "payments",
    clientCount: 4,
    configureClient: c => c.BaseAddress = new Uri("https://payments.svc.cluster.local"));
```

### Weighted

Weighted is for canary deployments or mixed-capacity pools. Each client index gets a relative weight. To pick a client, CloudHttp rolls `Random.Shared.NextDouble() * totalWeight` and binary searches a sorted list of cumulative weights.

```csharp
services.AddWeightedDistribution(
    name: "search",
    weights: new Dictionary<int, double> { [0] = 9, [1] = 1 },
    configureClient: c => c.BaseAddress = new Uri("https://search.svc.cluster.local"));
```

That example sends roughly 10% of traffic to the second pool, which is handy for gradually shifting traffic to a different upstream, like another cluster, a new version of a service, or another region.

### Health-aware

Health-aware mode is round-robin with a temporary degraded list. When a pool returns a transient status code or throws a transient exception, CloudHttp records `now + HealthDegradedTimeout` for that pool and skips it until then. The default timeout is 30 seconds.

```csharp
services.AddHealthAwareDistribution(
    name: "inventory",
    clientCount: 4,
    degradedTimeout: TimeSpan.FromSeconds(30),
    configureClient: c => c.BaseAddress = new Uri("https://inventory.svc.cluster.local"));
```

Recovery is only time-based. A successful response does not bring a pool back early, because in-flight requests complete out of order and a late success should not overwrite a newer failure.

It uses `Environment.TickCount64` instead of `DateTime.UtcNow`, so NTP adjustments to the wall clock don't mess up the degradation state.

If every pool ends up degraded at the same time, the selector falls back to round-robin instead of failing outright. Calling a possibly-degraded pool is better than refusing to call anything.

## A reality check on what this can do

N pools give kube-proxy N chances to pick different backends, which is why this post says "more chances at the load balancer" and not "always different backends". If the upstream Service has only two replicas and you have four pools, at least two pools share a backend (pigeonhole principle). And if kube-proxy happens to send two pools to the same backend, you live with that until the connection lifetime runs out.

A service mesh sidecar (Envoy under Istio, the Linkerd2-proxy) load balances every request at L7, so if you have a mesh, use it. CloudHttp is for when you don't have one, can't write your own client-side load balancer, and still want better odds than a single TCP connection.

## Cloud-tuned handler defaults

The library also bundles the `SocketsHttpHandler` defaults I've been typing into every cloud service for the last few years. They are applied automatically inside `AddDistributedHttpClient`, but you can also use them on their own with a normal named client:

```csharp
services.AddHttpClient("orders", c => c.BaseAddress = new Uri("https://orders.svc"))
    .ConfigureForCloud();
```

The values it picks, and why:

| Property | Value | What it gets you |
|---|---|---|
| `PooledConnectionLifetime` | 2 minutes | DNS refresh on the cadence of rolling deploys; the .NET default is infinite, which means a connection opened on day 1 still hits the same pod on day 30. |
| `ConnectTimeout` | 5 seconds | Fail fast on broken routes. The .NET default is also infinite, which is wrong for cluster traffic. |
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

By default, `IHttpClientFactory` rotates the whole handler every two minutes to pick up DNS changes. If you also set `PooledConnectionLifetime = 2 minutes` on the handler, you pay twice: the factory throws the whole pool away every two minutes, AND each connection's own two-minute clock never gets to run because the handler dies first. I went into this in [HttpClient connection lifetime, observed](/blog/httpclient-connection-lifetime-observed). In short, pin the factory lifetime to infinite and let `PooledConnectionLifetime` do the rotation.

Each setting has a longer explanation in [docs/cloud-defaults.md](https://github.com/haiilong/CloudHttp/blob/main/docs/cloud-defaults.md) inside the repo. You can override any of them through the `customize` callback.

## Composition with Microsoft.Extensions.Http.Resilience

CloudHttp only does pool selection, not retries, backoff, jitter, or circuit breaking. Microsoft's [`Microsoft.Extensions.Http.Resilience`](https://learn.microsoft.com/dotnet/core/resilience/http-resilience) package does all of that on top of Polly v8, and does it well.

The two libraries compose cleanly. `configureBuilder` runs for each underlying named client, so the resilience handler sits inside each pool:

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

What happens on a `GetAsync<T>` call:

1. The distributor picks client `#0`.
2. The resilience pipeline on `#0` runs, including jittered retries. Each retry stays on the same pool.
3. If the response or exception is still transient after that pipeline, CloudHttp rotates once to a different client.
4. The resilience pipeline on the rotated client runs.
5. The caller gets whatever the second client returns. There is no further rotation.

Each named client has its own circuit breaker, so a stuck pool does not drag the others down with it.

With `MaxRetryAttempts = 3`, one call can make up to eight attempts (four on the first pool, four on the rotated pool). With `c.Timeout = 30s`, the worst case for two attempts is 60 seconds. To cap the total time, set a deadline at the caller with `CancellationTokenSource.CancelAfter`:

```csharp
using var cts = CancellationTokenSource.CreateLinkedTokenSource(callerCt);
cts.CancelAfter(TimeSpan.FromSeconds(30));
await http.GetAsync<Foo>("/x", cts.Token);
```

Caller cancellation always wins. CloudHttp does not rotate when the caller's `CancellationToken` fires; it rethrows `OperationCanceledException` immediately.

## Reads can rotate, writes cannot

Only two operations on `DistributedHttpClient` rotate after a transient failure:

- `GetAsync<T>(path, ct)`
- `SendAsync(factory, ct)` (the explicit "build your own request" version)

The mutating JSON helpers (`PostAsync`, `PutAsync`, `PatchAsync`, `DeleteAsync`) never rotate, on purpose. A `POST` that times out may have already created the row, charged the card, or sent the email, and replaying it can duplicate side effects that CloudHttp can't detect from the outside.

If a write is safe to replay, make that explicit at the call site with an idempotency key and call `SendAsync` directly:

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

The idempotency key is part of the API contract between your caller and the upstream, so CloudHttp can't make one up for you.

## A few smaller helpers

These three ended up in the library because they kept coming up in real service code.

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

Only use this for non-critical calls where a fallback value is fine, like feature flags or optional metadata. Caller cancellation still propagates. Only HTTP failures, JSON errors, and I/O errors fall back to the default value, and they always get logged.

## Out of scope, on purpose

CloudHttp does not do any of these:

- No retries, exponential backoff, jitter, or circuit breaking. Use `Microsoft.Extensions.Http.Resilience` and let CloudHttp compose with it.
- No distributed health state across caller pods. Each replica of your caller service tracks its own health-aware degradations. Pool `#2` being marked degraded on pod A does not propagate to pod B.
- No service discovery beyond cluster DNS. No Consul, no Kubernetes API integration, no Eureka.
- No guarantee of even distribution. The N-pool trick is best-effort. If you need actual L7 load balancing, a service mesh is the right tool.
- No automatic replay of mutating operations. `POST`, `PUT`, `PATCH`, `DELETE` will not retry across pools.

Keeping the scope small makes each part easier to reason about, and Microsoft already ships a better retry and circuit-breaker library.

## When this is the right fit

You probably want CloudHttp if:

- Your .NET service calls another service through a cluster DNS name.
- You see one TCP connection from each caller pod sticking to the same upstream pod across long lifetimes.
- You do not have a service mesh handling L7 load balancing for you.
- You want sane `SocketsHttpHandler` settings for cluster traffic without writing them from scratch every time.

Skip it when:

- You only call public internet APIs. The defaults are tuned for cluster traffic, not slow, distant, less reliable upstreams.
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

The split won't be perfectly even because Docker DNS, connection pooling, and timing all play a part, but you can see one logical upstream being reached through several client pools. There is also an unstable variant where upstreams return 503 every Nth request, so you can watch `GetAsync` rotate.

The full walkthrough, including environment variables, the health-aware and weighted variants, and a Docker-less local script, is in [samples/CloudHttp.Sample/README.md](https://github.com/haiilong/CloudHttp/blob/main/samples/CloudHttp.Sample/README.md).

## Wrapping the HTTP series

This is the third post on this blog about HTTP in .NET, and probably the last for a while. The 2024 post described the load-balancing problem in Kubernetes, the HttpClient connection lifetime post looked at how the handler behaves, and CloudHttp packages the workaround as a library.

The package itself is small: a handful of extension methods, one selector type, three distribution strategies, a set of cloud defaults, and a few JSON helpers. The README and the three docs files in the repo go into more detail than this post.

Repo: <https://github.com/haiilong/CloudHttp>
