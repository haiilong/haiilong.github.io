---
title: Why I built SingletonJob
date: 2026-05-11
description: A Redis-backed singleton background job library for high-frequency .NET workloads.
tags: [tech]
---

## Background

I work on a trading system. Without going into the specifics of what we trade, two things matter for the rest of this post.

First, prices tick every second, sometimes faster than that.

Second, the prediction pipeline needs fresh data, and that data has to be pulled from a lot of different sources every 500 ms or so by background threads. If you zoom out far enough, the whole thing is basically "is the data ready, and how stale is it?" on a loop.

This is the story of a library I've wanted to write for years and finally did.

<https://github.com/haiilong/SingletonJob>

## What I wanted

I wanted to run a periodic job across a few pods in Kubernetes, with exactly one pod running it at any given moment. That's basically it, but the requirements piled up:

- Sub-second frequency. Some jobs need to fire every 500 ms.
- Drop-on-overlap. If the previous tick is still running, skip the next one. Don't queue it, and don't run two at once.
- No persistence overhead. I don't need a job history, a dashboard, retry policies, or a database table per job. Just "exactly one pod is the leader, and that pod runs the loop".
- Failover in seconds, not minutes.
- Cheap. Hundreds of bytes per job in Redis, not hundreds of megabytes of in-memory state per pod.
- AOT compatible, because eventually I want everything trimmed and AOT'd anyway.

## Why not Hangfire

Hangfire is great for what it was built for: durable, retryable, observable background jobs with a dashboard, like email queues and nightly reports, where you come back the next day to see what happened.

It just doesn't fit what I needed:

- Cron has a one second minimum. That alone rules it out for tick driven work.
- Overlapping runs queue up. If the previous job runs long, the next one stacks behind it instead of being skipped. For price ticks that's backwards. You want the overlapping run dropped, not queued.
- Memory and CPU spikes on startup. For a worker pod that already holds models in memory and runs hot loops, a Hangfire startup spike is not free.
- The storage backend is overhead I don't need: a SQL Server schema with histories, retries, states, and hash tables. For "one pod runs this every second", that is far too much machinery.

I'm not picking a fight with Hangfire. I needed a different kind of tool, and it happened to be small enough that nobody had bothered to publish it.

## Why Redis

When I brought up the idea, the first question was usually "couldn't you do this with a SQL Server row, or etcd, or ZooKeeper?" Yes, all of those work. I went with Redis anyway because:

- Almost every .NET microservice I have worked on already had Redis somewhere: caching, pub/sub, rate limiting, locks for other things. Adding a 50 byte lock key per job is basically free.
- Lua scripts run atomically on the server, and the acquire-or-renew and release scripts below are a few lines each. The SQL Server equivalent is a transaction with `WITH (UPDLOCK, HOLDLOCK)` wrapped in a stored procedure. It works, but it's a lot more moving parts for the same outcome.
- `StackExchange.Redis` is mature and well behaved under load. I have never once had to debug the client itself, which is more than I can say for some SQL drivers.
- A lock key is around 50 bytes. Three replicas × five jobs, each heartbeat every three seconds → 15/3 = 5 ops/sec. Cost isn't something I have to think about.

If your stack already has etcd or Consul, those work fine too. But for a typical .NET shop with Redis already in the picture, this is about as cheap as it gets.

## The shape of the thing

Three job types ended up covering pretty much every periodic workload I've had at work.

```csharp
// 1) Run, wait, run. "At least N seconds between runs."
public sealed class HeartbeatJob(...) : SingletonIntervalJob(...)
{
    public override string JobName => "heartbeat";
    protected override TimeSpan GetJobInterval() => TimeSpan.FromSeconds(1);
    protected override Task ExecuteJobAsync(CancellationToken ct) { ... }
}

// 2) Fire on a fixed rate. Drop the tick if the previous run is still in flight.
public sealed class PriceTickJob(...) : SingletonFixedRateJob(...)
{
    public override string JobName => "price-tick";
    protected override TimeSpan GetJobInterval() => TimeSpan.FromMilliseconds(500);
    protected override Task ExecuteJobAsync(CancellationToken ct) { ... }
}

// 3) Cron schedule.
public sealed class DailyReportJob(...) : SingletonCronJob(...)
{
    private static readonly CronExpression Expr = CronExpression.Parse("0 3 * * *"); // from the Cronos library
    public override string JobName => "daily-report";
    protected override CronExpression GetCronExpression() => Expr;
    protected override Task ExecuteJobAsync(CancellationToken ct) { ... }
}
```

`SingletonIntervalJob` is the simple one: run, wait N seconds, run again. There is a minimum gap between iterations but no maximum, so if a job takes longer than the interval, the next start just gets pushed out.

`SingletonFixedRateJob` is the one I actually wrote this library for. Ticks fire at fixed wall-clock offsets, and if the previous tick is still running, the new one gets dropped. Nothing piles up waiting to run later.

`SingletonCronJob` is for the boring stuff: nightly reports, hourly cleanups, anything where the time of day matters. You give it a cron expression and it runs your job on that schedule.

## How leader election actually works

Leader election comes down to a single Redis key per job.

```
{ProjectName}:{JobName}:lock
```

Every replica, every `HeartbeatInterval` (3 seconds by default), runs one Lua script:

```lua
local v = redis.call('GET', KEYS[1])
if not v then
    redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
    return 1
elseif v == ARGV[1] then
    redis.call('PEXPIRE', KEYS[1], ARGV[2])
    return 1
else
    return 0
end
```

`KEYS[1]` is the lock key, `ARGV[1]` is the node id, and `ARGV[2]` is `LockExpiry` in milliseconds. The script covers three cases:

- The key is free, so this pod takes it and becomes the leader.
- The key holds this pod's id, so it extends the TTL. This is what the leader runs on every heartbeat.
- The key holds another pod's id, so it returns 0 and this pod stays a follower.

Only the holder can extend the TTL. If the leader gets 0 back, it lost leadership (probably because too many heartbeats failed in a row and the key expired in between), and the loop drops back to follower mode.

An earlier version used `SET NX PX` to acquire and a separate script to renew. Merging them means a follower's acquire attempt and the leader's renewal are the same call, so it's one round trip per heartbeat and one code path.

On graceful shutdown, there's a second Lua script:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

## Why these are Lua scripts

Acquire, renew, and release each run as a single Redis operation, on purpose. Anything that does "check, then act" against shared state across multiple round trips is a race waiting to happen.

For acquire, the naive version would be:

```
EXISTS lockKey      # returns 0, nobody owns it
SET lockKey nodeId  # OK, I'll set it
```

Between those two commands, another pod can also see `EXISTS` return 0 and also issue its own `SET`. Now both pods think they're the leader, and you spend the next incident figuring out why two workers fought over the same tick. Inside the Lua script, the `GET` and the `SET` run as one atomic step, so this can't happen.

Renewal has the same problem. The naive version is:

```
GET lockKey            # is it still me?
PEXPIRE lockKey 10000  # yes, extend the TTL
```

Between the `GET` and the `PEXPIRE`, the lock can expire on its own (a network blip, a few missed heartbeats), and another pod can take the lock and become the new leader. If we then run our `PEXPIRE`, we extend *their* lock from a pod that no longer owns it, and we don't even know we lost leadership. The Lua script does `GET` and `PEXPIRE` in one call, and Redis runs the whole script atomically, so nothing can get in between the two steps.

Release is the same shape. `GET` then `DEL` is two commands and a race: if the lock expires and another pod acquires it between the two, our `DEL` deletes *their* lock. The Lua version checks ownership and deletes in one step.

So any operation whose correctness depends on the current state of the lock has to run on the Redis server in one shot, which is why both acquire-or-renew and release are Lua scripts.

## Why explicit release matters

Without an explicit release, peers have to wait up to `LockExpiry` (10 seconds by default) before another pod can take the lock. With release, the next pod takes over within one `HeartbeatInterval`, which is 3 seconds by default.

On a rolling deploy, that means nobody runs the job for up to 3 seconds instead of 10. For a tick driven loop firing every 500 ms, that's a few stale ticks instead of around thirty.

On a hard kill (SIGKILL, OOM, the node dropping off the network), nothing graceful runs and the lock expires after `LockExpiry`. That's still fine, because your config bounds the worst case.

## Sizing HeartbeatInterval and LockExpiry

There are only two knobs, `HeartbeatInterval` and `LockExpiry`, and the ratio between them is what you tune.

`HeartbeatInterval` is how often the leader tries to renew. `LockExpiry` is the TTL on the key. Once `LockExpiry` passes without a successful renewal, the key vanishes from Redis and whichever replica runs the script next becomes the new leader.

Set them too close together (say 3s and 4s), and one slow round trip costs you leadership. Set them too far apart (3s and 60s), and a hard kill takes a full minute to fail over. My rule is `LockExpiry >= 3 * HeartbeatInterval`, which allows three missed renewals before we lose the lock. The defaults (3s and 10s) fit that rule.

For very fast jobs (every 500 ms or 100 ms), the heartbeat doesn't have to match the job tick. The job loop and the election loop run in parallel inside the same hosted service, so you can run the job every 500 ms and still heartbeat at 3 s without the two interfering.

The library also logs a warning if a single iteration of `ExecuteJobAsync` runs longer than 80% of `LockExpiry`. It means your job is slow enough to outlast the lock, and another pod is about to take it from you. If you see that warning regularly, the sizing is wrong, not the job.

## The drop-on-overlap bit

Here is the `SingletonFixedRateJob` iteration loop, simplified:

```csharp
while (!ct.IsCancellationRequested)
{
    await _timer.WaitForNextTickAsync(ct);

    if (!IsLeader) continue;
    if (_isJobRunning) { /* drop this tick */ continue; }

    _isJobRunning = true;
    try { await ExecuteJobAsync(ct); }
    finally { _isJobRunning = false; }
}
```

`PeriodicTimer.WaitForNextTickAsync` gives you ticks at fixed wall-clock instants instead of drifting like `Task.Delay` would. `_isJobRunning` is a `volatile bool`, and if a tick arrives while the previous run is still going, we drop it on the floor.

Hangfire's recurring job runner queues overlapping runs, and this one drops them. For "run prediction every 500 ms" workloads, dropping is the correct default, because a stale prediction is worse than a missed one.

## AOT and the source generator

The library targets `net8.0` and `net10.0`, and it's marked `IsAotCompatible=true` and `IsTrimmable=true`. Those flags only mean something if you actually avoid reflection at startup, so I shipped a Roslyn source generator inside the package.

The generator scans your compilation, finds every non-abstract subclass of `SingletonBackgroundJob`, and emits an extension method directly into your assembly:

```csharp
internal static class SingletonJobGeneratedRegistration
{
    internal static IServiceCollection AddSingletonJobs(this IServiceCollection services, IConfiguration? configuration = null)
    {
        services.ConfigureSingletonJobOptions(configuration);
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, MyApp.DailyReportJob>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, MyApp.HeartbeatJob>());
        services.TryAddEnumerable(ServiceDescriptor.Singleton<IHostedService, MyApp.PriceTickJob>());
        return services;
    }
}
```

So in `Program.cs` you write:

```csharp
builder.Services.AddSingletonJobs(builder.Configuration);
```

That call goes to the class generated above at compile time, so there's no `Assembly.GetTypes()`, no reflection, and no trim warnings at publish. I’ve built several source generators before, so this was familiar territory.

The generator only runs as part of a build, so on a fresh checkout your IDE will scream `CS1061: 'IServiceCollection' does not contain a definition for 'AddSingletonJobs'` until you `dotnet build` once. After that it resolves and stays resolved.

## Configuration

The defaults look like this:

```json
{
  "ConnectionStrings": { "Redis": "localhost:6379" },
  "SingletonJob": {
    "ProjectName": "myapp",
    "HeartbeatInterval": "00:00:03",
    "LockExpiry": "00:00:10"
  }
}
```

Keep `LockExpiry >= 3 * HeartbeatInterval`. A single dropped network call shouldn't cost you leadership. Three in a row, sure.

If one heavy job needs a longer lock, override it per job:

```csharp
services.PostConfigureSingletonJob("heavy-job", o =>
{
    o.LockExpiry = TimeSpan.FromMinutes(5);
});
```

Per-job options are frozen at startup. If you need to change them, redeploy. I went back and forth on whether to support hot reload and eventually convinced myself that hot reloading leader election config is a great way to invent a heisenbug.

## What it does not do

A library that tries to do too much ends up as another Hangfire, so here are the non-goals:

- No retries. If `ExecuteJobAsync` throws, it's logged and the next tick runs. If you want retries, write them in your handler.
- No history. Ticks aren't persisted anywhere. If you want a record, log it yourself.
- No dashboard. There is no UI and there never will be.
- No cross-pod work distribution. Exactly one pod runs the job, the others sit idle. If you want round-robin or sharded execution, that's a different problem and a different library.
- No durability. Jobs are in-memory loops, so a pod restart just restarts the loop.

The library does one thing: it makes sure exactly one pod across N replicas runs a given periodic loop, with fast and bounded failover.

## A few things I learned along the way

**`volatile` is the right primitive for `IsLeader`.** There is a single writer (the election loop) and many readers (the job loop, the release path). Eventually consistent publication is fine here, because losing leadership only delays a single iteration check by one tick at worst. Reaching for `Interlocked` or a lock would be cargo-cult programming, more complexity than the problem needs.

**`PeriodicTimer` is the right primitive for fixed rate ticks.** It ticks at fixed wall-clock instants, and `await Task.Delay(interval)` does not. The drift adds up over a few hours, and you only notice it when you look at the timestamps in the logs.

**Lua scripts make Redis atomic for free.** `GET` then `PEXPIRE` is two round trips and a race, while the Lua version is one round trip and atomic. Once the acquire-or-renew script was written, the release script was easy.

**Backoff with jitter.** When Redis comes back after an outage, you don't want N replicas to all retry at the exact same moment and dogpile the server. The formula is `delay = min(HeartbeatInterval * 2^failures, MaxBackoffDelay)` plus or minus 20% jitter. It's four lines of code and avoids a whole class of follow-on incidents.

**Cron without a time zone is UTC.** Cronos is great, but it defaults to UTC. We're in Singapore (UTC+8), so a daily 3 AM job actually fires at 11 AM local. I ran into this in a test deployment and added the optional `TimeZone` override on `SingletonCronJob`. If you only ever run in UTC, ignore it. If not, set it explicitly, most likely to your server's own local time.

## Try it

```sh
dotnet add package SingletonJob
```

Or clone the repo and spin up three workers locally:

```sh
cd samples
docker compose up --build --scale worker=3
```

Exactly one of them prints `became LEADER`. Kill it, and another takes over within `HeartbeatInterval`.

Repo: <https://github.com/haiilong/SingletonJob>

If you are interested, check out the `README.md` and all the technical documents under `./doc`. I'm happy to hear any feedbacks.

## Closing

I've wanted a library like this to exist for years. Every team I've been on has eventually written some version of it: a half broken `try/finally` around a Redis `SET NX`, a hand rolled scheduler that queues runs it should have dropped, and, worst of all, a `Quartz`/`BackgroundService` that runs in every pod or is configured to "only run on a pod 0" (extremely brittle). None of them were ever good enough to pull out into a package.

I think this one is. The code is short enough to read in one sitting, I keep failing to find new things to add to it, and the design has held up across enough rewrites at work that I'm not nervous about it anymore. If you have a tick driven workload in .NET and you've been fighting Hangfire about it, give this a try.
