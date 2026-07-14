---
title: .NET LocalJob
date: 2026-07-14
description: In-memory recurring background jobs for dotnet.
tags: [tech]
---

## Background

This is a counterpart to [SingletonJob](/blog/why-i-built-singletonjob) where the job runs on every instance of your app. This is much simpler because there is no Redis, no database, no coordination and all the troubles that come with those things.

You can find the package here:

<https://github.com/haiilong/LocalJob>

## Why this exists

Some background work belongs to the process, not to the deployment: flushing a local metrics buffer, trimming this pod's temp directory, pinging a keep-alive, draining an in-memory queue.

This problem is solved by using the popular scheduler framework Quartz or just use .NET background job. However I want a few things:

1. Easier to create new jobs (Auto-discovery, templates, etc.)
2. Easy to configure (polling interval, isEnabled?, ExecutionTimeout, etc.)
3. And some functionalities that are not nicely supported currently:
    1. Overlap protection
    2. Misfire handling
    3. Graceful shutdown
    4. Error handling that doesn't kill the loop
    5. Per-job Configuration
    6. RunOnStartup (for IntervalJob)
    7. Jitter (so that jobs don't hit your DB at the same time)

Take a look at the README and the sample project, it is very easy to use and sufficiently powerful.

## Differences from SingletonJob

1. There is no Redis or Leadership Election and anything related to that, so it's a lot simpler, while carrying the same API shape
2. Per-job settings live on the job class, not in `Program.cs`. Override `ConfigureJobOptions`; it receives the job's private copy of the options and runs last, after `appsettings.json`. LocalJob is all in-process, so class-owned config is the natural home while a lot of configurations for SingletonJob feel more like higher level operations
3. And with no name-keyed config, the `IOptionsFactory<LocalJobOptions>` constructor parameter is technically overkill and `IOptions<>` would do, which was the eventual option.
