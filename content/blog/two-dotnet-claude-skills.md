---
title: Two Claude Code skills I wrote for .NET
date: 2026-04-22
description: A pair of opinionated .NET skills for Claude Code, one for coding conventions, one for performance review.
tags: [tech]
---

## Background

I use Claude Code a lot for .NET work. The code it produces is fine by default, just not in my style. A few patterns kept coming up that I'd manually rewrite every time:

- Services that should use primary constructors but don't.
- DTOs and records without `required` + init-only properties.
- Minimal API endpoints registered one by one in `Program.cs` instead of being auto-scanned via an `IEndpoint` interface.

None of those are bugs. They're reasonable defaults, just not mine. So I wrote two skills to nudge Claude toward the way I'd actually write the code.

## dotnet-skills

<https://github.com/haiilong/dotnet-skills>

A collection of opinionated .NET 10 / C# 14 conventions, packaged as Markdown skill files. Roughly the stuff that comes up on a normal day at work:

- C# coding standards (records with `required { get; init; }`, primary constructors for services, `sealed` by default)
- Type design (class vs record vs struct vs readonly record struct)
- Value objects (`readonly record struct` patterns)
- Concurrency (`TimeProvider`, `PeriodicTimer`, bounded `Channel<T>`)
- Error handling (`Result<T>`, RFC 9457 `ProblemDetails`)
- ASP.NET Core minimal APIs with auto-registered `IEndpoint` implementations
- Dependency injection with `extension(IServiceCollection)` blocks
- Configuration with `IOptions<T>` and `ValidateOnStart`
- Resilient HTTP clients via `Microsoft.Extensions.Http.Resilience`
- Serialization (System.Text.Json source gen, MessagePack)
- Structured logging with `[LoggerMessage]`
- Testing (xUnit, NSubstitute, FluentAssertions, TestContainers, Verify)

Very opinionated, and the opinions are good ones (in my opinion). The other reason: it doubles as onboarding material for the team. "Read this folder" is a faster answer than explaining the same conventions one PR at a time.

## dotnet-performance-skill

<https://github.com/haiilong/dotnet-performance-skill>

The second skill has a different goal: it runs through code that already exists and flags performance problems.

It walks a catalog of around 90 anti-patterns, grouped by severity:

- High: thread pool starvation, sync over async (`.Result`), N+1 queries, LOH allocation. The stuff that takes a service down as soon as real load shows up.
- Medium: missing pooling, cancellation propagation, middleware ordering.
- Low: micro-optimizations like `sealed`, SIMD, `stackalloc`. Only worth touching inside a measured hot path.

Each entry has a name, a short paragraph on why it matters, and a `// BAD` / `// GOOD` code pair you can copy from. When you ask the skill to apply a fix, it pulls from the catalog instead of inventing one, which keeps the output predictable run to run.

The goal is to find places where the existing code is doing something dumb, not to lecture about architecture. The clearest example is multiple enumeration on `IEnumerable`.

```csharp
// BAD: enumerates the IEnumerable twice (and the source might be a database query)
if (items.Any()) return items.Count();
```

One thing that's still unclear: it sometimes surfaces stuff that isn't really a performance issue at all. Style nits, design smells, that kind of thing. The catalog and the skill description are both pretty explicit about scope, so it's not obvious why this happens. For now, read the High tier closely and treat the rest as suggestions.

EF Core isn't covered either, because it's not something I've used in production, so the catalog doesn't include it. Fork and add your own if you want it.

## Install

Both are manual clone. No plugin marketplace entry, and I don't plan to publish one.

```bash
git clone https://github.com/haiilong/dotnet-skills ~/.claude/skills/dotnet-skills
git clone https://github.com/haiilong/dotnet-performance-skill ~/.claude/skills/dotnet-performance
```

Restart Claude Code or `/reload` and they show up.

I'm not publishing as a plugin because these aren't broad enough for a general .NET audience. No ORM (EF Core, Dapper, Marten), no Razor, no Blazor, no MVC, plus a handful of other slices of the ecosystem I just don't touch at work. They reflect my own habits in the corner of .NET I actually live in. If your taste happens to overlap, fine. If it doesn't, the skills will spend their time fighting your defaults instead of helping, which is worse than not installing them at all.

## Closing

Honestly the main audience here is me and my team. Me, because I want Claude Code to produce .NET that already passes my own review. The team, because "go read this folder" turns out to be a faster onboarding answer than "watch me review your first ten PRs and pick it up by osmosis".

If you happen to share the taste, take a look. Otherwise fork it and rewrite the bits you disagree with. The files are short enough that this is realistic, not a project.
