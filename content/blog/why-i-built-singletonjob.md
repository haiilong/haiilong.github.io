---
title: Why I built SingletonJob
date: 2026-05-11
description: A Redis-backed singleton background job library for high-frequency .NET workloads.
tags: [tech]
---

## Background

I work on a trading system. I won't go into the specifics of what we trade, but two things matter for the rest of this post.

First, prices tick. Every second. Sometimes faster than that.

Second, the prediction pipeline needs fresh data, and that data has to be pulled from a lot of different sources every 500 ms or so by background threads. If you zoom out far enough, the whole thing is basically "is the data ready, and how stale is it?" on a loop.

This is the story of a library I've wanted to write for years and finally did.

<https://github.com/haiilong/SingletonJob>

## What I wanted

A way to run a periodic job across a few pods in Kubernetes, where exactly one pod runs it at any given moment. That's basically it.

But the requirements piled up:

- Sub-second frequency. Some jobs need to fire every 500 ms.
- Drop-on-overlap. If the previous tick is still running, skip the next one. Don't queue it. Don't run two at once. Just drop.
- No persistence overhead. I don't need a job history, a dashboard, retry policies, or a database table per job. Just "exactly one pod is the leader, and that pod runs the loop".
- Failover in seconds, not minutes.
- Cheap. Hundreds of bytes per job in Redis, not hundreds of megabytes of in-memory state per pod.
- AOT compatible, because eventually I want everything trimmed and AOT'd anyway.

## Why not Hangfire

I have nothing against Hangfire for what it was built for: durable, retryable, observable background jobs with a dashboard. Email queues. Nightly reports. The kind of work where you want to come back tomorrow and see what happened.

But it isn't the right shape for what I needed:

- Cron has a one second minimum. That alone disqualifies it for tick driven work.
- Overlapping runs queue. If the previous job runs long, the next one doesn't get skipped, it stacks. For price ticks, that's exactly backwards. You want the new tick to fire and the old one to die.
- Memory and CPU spikes on startup. For a worker pod that already holds models in memory and runs hot loops, a Hangfire startup spike is not free.
- The storage backend is structural overhead I don't need. A SQL Server schema with histories, retries, states, hash tables. For "one pod runs this every second", that is far too much machinery.

I'm not picking a fight with Hangfire. I just needed a different shape of tool, and the right shape happened to be small enough that nobody had bothered to publish it.

## Why Redis

When I floated the idea, the first question I got was usually "couldn't you do this with a SQL Server row, or etcd, or ZooKeeper?" Yes, you can. All of those work. Here is why I went with Redis anyway.

- Almost every .NET microservice I have worked on already had Redis somewhere: caching, pub/sub, rate limiting, locks for other things. Adding a 50 byte lock key per job is basically free.
- `SET NX PX` is one command. The SQL Server equivalent is a transaction with `WITH (UPDLOCK, HOLDLOCK)` wrapped in a stored procedure. It works, but it's a lot more moving parts for the same outcome.
- Lua scripts. The renewal and release patterns below are seven lines each. The SQL equivalents are not.
- `StackExchange.Redis` is mature and well behaved under load. I have never once had to debug the client itself, which is more than I can say for some SQL drivers.
- A lock key is around 50 bytes. Three replicas, five jobs, one Redis call per heartbeat per pod per job comes out to roughly 5 ops/sec. Cost isn't something I have to think about.

If your stack already has etcd or Consul, those work fine too. But for a typical .NET shop with Redis already in the picture, this is about as cheap as it gets.

## The shape of the thing

I ended up with three job types. Between them they cover pretty much every periodic workload I've had at work.

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
    private static readonly CronExpression Expr = CronExpression.Parse("0 3 * * *");
    public override string JobName => "daily-report";
    protected override CronExpression GetCronExpression() => Expr;
    protected override Task ExecuteJobAsync(CancellationToken ct) { ... }
}
```

`SingletonIntervalJob` is the simple one. Run, wait N seconds, run again. The time between iterations is bounded below, not above. If a job takes longer than the interval, the next start just gets pushed out.

`SingletonFixedRateJob` is the one I actually wrote this library for. Ticks come at fixed wall-clock offsets. If the previous tick is still running when the next one fires, that next tick gets dropped on the floor. No queue, no overlap, no surprise stacking later when the load picks back up.

`SingletonCronJob` is for the boring stuff. Nightly reports, hourly cleanups, anything where the time of day matters. Cron expression in, callback out.

## How leader election actually works

Leader election comes down to a single Redis key per job.

```
{ProjectName}:{JobName}:lock
```

Every replica, every `HeartbeatInterval` (3 seconds by default), runs:

```
SET {lockKey} {nodeId} NX PX {LockExpiry}
```

`NX` means "only set if absent". `PX` is a TTL in milliseconds. The first pod to land that SET becomes the leader. Everyone else gets `null` back and stays a follower.

Renewal is a tiny Lua script the leader runs on every heartbeat:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
    return 0
end
```

Only the holder can extend the TTL. If the script returns 0, we lost leadership (probably because too many heartbeats failed in a row and the key expired in between), and the loop drops back to follower mode.

On graceful shutdown, there's a third Lua script:

```lua
if redis.call('GET', KEYS[1]) == ARGV[1] then
    return redis.call('DEL', KEYS[1])
else
    return 0
end
```

## Why all three of these are one Redis command

You might notice that acquire, renew, and release are each a single Redis operation. That's deliberate. Anything that does "check, then act" against shared state across multiple round trips is a race waiting to happen.

Take acquire. The naive version would be:

```
EXISTS lockKey      # returns 0, nobody owns it
SET lockKey nodeId  # OK, I'll set it
```

Between those two commands, another pod can also see `EXISTS` return 0 and also issue its own `SET`. Now both pods think they're the leader, and you spend the next incident figuring out why two workers fought over the same tick. `SET ... NX` solves this by collapsing the check and the write into one operation that Redis runs as a single atomic step. There is no window for anyone to slip in.

Renewal has the same problem. The naive version is:

```
GET lockKey            # is it still me?
PEXPIRE lockKey 10000  # yes, extend the TTL
```

Between the `GET` and the `PEXPIRE`, the lock can expire on its own (a network blip, a few missed heartbeats), and another pod can `SET NX` and become the new leader. If we then run our `PEXPIRE`, we just extended *their* lock without realizing it. The new leader now holds a key with twice the TTL it should have, and we don't even know we lost leadership. The Lua script wraps `GET` and `PEXPIRE` into one call. Redis runs the whole script atomically from every other client's perspective, so nothing can sneak in between the two steps.

Release is the same shape. `GET` then `DEL` is two commands and a race: if the lock expires and another pod acquires it between the two, our `DEL` deletes *their* lock. The Lua version checks ownership and deletes in one step.

So the rule is: any operation whose correctness depends on the current state of the lock has to run on the Redis server in one shot. `SET NX` handles acquire. Lua handles the other two.

## Why explicit release matters

Without an explicit release, peers have to wait up to `LockExpiry` (10 seconds by default) before a fresh `SET NX` can win. With release, the next pod takes over within one `HeartbeatInterval`, which is 3 seconds by default.

On a rolling deploy, that's the difference between "10 seconds of nobody running the job" and "3 seconds of nobody running the job". For a tick driven loop firing every 500 ms, that's the difference between a few stale ticks and around thirty of them.

On a hard kill (SIGKILL, OOM, the node dropping off the network), nothing graceful runs. The lock just expires after `LockExpiry`. That's still fine. It's the worst case, and the worst case is bounded by your config.

## Sizing HeartbeatInterval and LockExpiry

There are really only two knobs to tune: `HeartbeatInterval` and `LockExpiry`. The relationship between them is what you actually care about.

`HeartbeatInterval` is how often the leader tries to renew. `LockExpiry` is the TTL on the key. Once `LockExpiry` passes without a successful renewal, the key vanishes from Redis and whichever replica wins the next `SET NX` is the new leader.

Set them too close together (say 3s and 4s), and one slow round trip costs you leadership. Set them too far apart (3s and 60s), and a hard kill takes a full minute to fail over. The rule I land on is `LockExpiry >= 3 * HeartbeatInterval`. Three missed renewals before we lose the lock. The defaults (3s and 10s) fit that rule.

For very fast jobs (every 500 ms, every 100 ms), the job loop tightens up, but the heartbeat doesn't have to match the job tick. The job loop and the election loop run in parallel inside the same hosted service, so you can run the job every 500 ms and still heartbeat at 3 s without anything fighting.

The library also logs a warning if a single iteration of `ExecuteJobAsync` runs longer than 80% of `LockExpiry`. That's the canary for "your job is so slow it's about to time out the lock and another pod will take it from you". If you see that warning regularly, the sizing is wrong, not the job.

## The drop-on-overlap bit

This is what `SingletonFixedRateJob` does. The iteration loop, simplified, is:

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

`PeriodicTimer.WaitForNextTickAsync` gives you ticks at fixed wall-clock instants instead of drifting like `Task.Delay` would. The `_isJobRunning` flag is just a `volatile bool`. If a tick arrives while a previous run is still going, we drop it on the floor.

This is the semantic Hangfire's recurring job runner doesn't give you. Hangfire queues overlapping runs. Mine drops them. For "run prediction every 500 ms" workloads, drop is the correct default. A stale prediction is worse than a missed one.

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

That call expands at compile time into the class above. No `Assembly.GetTypes()`, no reflection, no trim warnings at publish. Writing a source generator was something I've been doing for a while since its first release and I had many experience with this stuff.

One small catch: the generator only runs as part of a build. On a fresh checkout your IDE will scream `CS1061: 'IServiceCollection' does not contain a definition for 'AddSingletonJobs'` until you `dotnet build` once. After that it resolves and stays resolved.

## Configuration

Defaults look like:

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

The relationship that actually matters is `LockExpiry >= 3 * HeartbeatInterval`. A single dropped network call shouldn't cost you leadership. Three in a row, sure.

Per-job override if you have one heavy job that needs a longer lock:

```csharp
services.PostConfigureSingletonJob("heavy-job", o =>
{
    o.LockExpiry = TimeSpan.FromMinutes(5);
});
```

Per-job options are frozen at startup. Want to change them? Redeploy. I went back and forth on whether to support hot reload and eventually convinced myself that hot reloading leader election config is a great way to invent a heisenbug. So, frozen.

## What it does not do

Libraries that try to do too much are how you end up rebuilding Hangfire, so the non-goals matter here.

- No retries. If `ExecuteJobAsync` throws, it's logged and the next tick runs. Want retries? Write them in your handler.
- No history. Ticks aren't persisted anywhere. Want a record? Log it yourself.
- No dashboard. There is no UI. There never will be.
- No cross-pod work distribution. Exactly one pod runs the job, the others sit idle. If you want round-robin or sharded execution, that's a different problem and a different library.
- No durability. Jobs are in-memory loops. A pod restart means the loop restarts. That is on purpose.

What's left is the one thing the library actually does: make sure exactly one pod across N replicas runs a given periodic loop, with fast and bounded failover.

## A few things I learned along the way

**`volatile` is the right primitive for `IsLeader`.** Single writer (the election loop), many readers (the job loop, the release path). Eventually consistent publication is fine here, because losing leadership only delays a single iteration check by one tick at worst. Reaching for `Interlocked` or a lock would be cargo culted.

**`PeriodicTimer` is the right primitive for fixed rate ticks.** It produces ticks at fixed wall-clock instants. `await Task.Delay(interval)` does not. The drift adds up over a few hours, and you only notice when you check the timestamps in the logs and realize you've quietly lost a beat.

**Lua scripts make Redis atomic for free.** `GET` then `PEXPIRE` is two round trips and a race. The Lua version is one round trip and atomic. Once I had written one Lua script I wrote three: renew, release, and a no-op ownership check.

**Backoff with jitter.** When Redis comes back after an outage, you don't want N replicas to all retry at the exact same moment and dogpile the server. The formula is `delay = min(HeartbeatInterval * 2^failures, MaxBackoffDelay)` plus or minus 20% jitter. Four lines. Saves you an entire class of follow-on incident.

**Cron without a time zone is UTC.** Cronos is great. The default for "cron with no time zone" is UTC, though. We're in Singapore (UTC+8), so a daily 3 AM job actually fires at 11 AM local. I added the optional `TimeZone` override on `SingletonCronJob` after I ran into this exact problem in a test deployment. If you only ever run in UTC, ignore. If not, set it explicitly. Most likely you want to set it to your server's own local time.

## Try it

```sh
dotnet add package SingletonJob
```

Or clone the repo and spin up three workers locally:

```sh
cd samples
docker compose up --build --scale worker=3
```

Exactly one of them prints `became LEADER`. Kill it. Another takes over within `HeartbeatInterval`. That's it.

Repo: <https://github.com/haiilong/SingletonJob>

## Closing

I've wanted a library like this to exist for years. Every team I've been on has eventually written some version of it: a half broken `try/finally` around a Redis `SET NX`, a hand rolled scheduler that quietly queues runs it should have dropped, and worst of all: a `Quartz`/BackgroundService that runs in every pod or configured to "only run on a pod 0" (extremely brittle). None of them were ever good enough to pull out into a package.

This one I think actually is. The code is short enough to read in one sitting. The surface area is small enough that I keep failing to find new things to add to it. And the design has held up across enough rewrites at work that I'm not nervous about it anymore. If you have a tick driven workload in .NET and you've been fighting Hangfire about it, give this a try.
