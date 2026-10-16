---
title: .NET LocalJob
date: 2026-07-14
description: In-memory recurring background jobs for dotnet.
tags: [tech]
---

## Background

This is a counterpart to [SingletonJob](/blog/why-i-built-singletonjob) where the job runs on every instance of your app. It's much simpler, since there's no Redis, no database, no coordination, and none of the trouble that comes with them.

You can find the package here:

<https://github.com/haiilong/LocalJob>

## Why this exists

Some background work belongs to the process, not to the deployment: flushing a local metrics buffer, trimming this pod's temp directory, pinging a keep-alive, draining an in-memory queue.

You can already do this with Quartz or a plain .NET background service, but I wanted a few more things:

1. Easier to create new jobs (Auto-discovery, templates, etc.)
2. Easy to configure (polling interval, isEnabled?, ExecutionTimeout, etc.)
3. Features that are not well supported today:
    1. Overlap protection
    2. Misfire handling
    3. Graceful shutdown
    4. Error handling that doesn't kill the loop
    5. Per-job Configuration
    6. RunOnStartup (for IntervalJob)
    7. Jitter (so that jobs don't hit your DB at the same time)

Take a look at the README and the sample project. It's easy to use and powerful enough.

## Differences from SingletonJob

1. No Redis, leader election, or anything related, so it's a lot simpler while keeping the same API shape
2. Per-job settings live on the job class, not in `Program.cs`. Override `ConfigureJobOptions`; it receives the job's private copy of the options and runs last, after `appsettings.json`. Since LocalJob is all in-process, the job class is the natural home for its config, while a lot of SingletonJob's configuration feels more like an operations concern
3. With no name-keyed config, an `IOptionsFactory<LocalJobOptions>` constructor parameter would be overkill, so it takes `IOptions<>` instead.
