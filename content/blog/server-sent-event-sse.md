---
title: Server Sent Event (SSE)
date: 2024-11-25
description: A practical look at Server Sent Events and when to use them.
tags: [tech]
---

## Communication type

There are a few options for real time communication between a server and a client:

1. Long Polling

   1. The client sends an HTTP request, and the server holds it open until new data is available or it times out

   2. Pros: Works with older browsers

   3. Cons: Inefficient, high latency

2. Short Polling

   1. The client sends an HTTP request and the server responds. It's pull based

   2. Pros: Flexible with many systems

   3. Cons: The client has to poll often if it doesn't know when new data is ready, and it's slow to pick up frequent updates

3. Server Sent Event (SSE)

   1. The client opens a persistent HTTP connection, and the server pushes events over it for the client to handle

   2. Pros: Simple, low overhead push from server to client

   3. Cons: One way only (no 2 way communication)

4. WebSockets

   1. The client and server establish a full duplex communication channel over a single TCP connection. Both parties can send and receive data at any time.

   2. Pros: 2 way communication

   3. Cons: Most complex

## SSE

The rest of this post covers how to implement Server Sent Events and what they're used for.

With .NET Core minimal APIs, the server exposes this endpoint:

```csharp
app.MapGet("/data-stream", async (HttpContext ctx, CancellationToken ct) =>
{
    ctx.Response.Headers.Append("Content-Type", "text/event-stream");
    
    while (!ct.IsCancellationRequested)
    {
        var randomNumber = new Random().Next(0, 100);
        var data = $"data: {randomNumber}\n\n";
        
        await ctx.Response.WriteAsync(data, cancellationToken: ct);
        await ctx.Response.Body.FlushAsync(cancellationToken: ct);
        
        await Task.Delay(1000, ct); // Send a new number every second
    }
});
```

1. The handler takes an `HttpContext` and a `CancellationToken`.

2. It writes directly to `HttpContext.Response`:

   1. The `Content-Type` header is set to `text/event-stream`

   2. Data is written straight to the `Response` body

A JavaScript client that wants to receive the events does this:

```javascript
const eventSource = new EventSource(url + "/data-stream");

eventSource.onmessage = function(event) {
    console.log(event.data)
}

eventSource.onerror = function(event) {
    // log error
}
```

If you inspect the client, you will see:

![image-20241206-043340.png](/blog/server-sent-event-sse/image_20241206_043340.png)

Any new client that connects starts receiving events.

Note that SSE has no built-in way to manage clients from the server side (counting connected clients, disconnecting one manually, etc.). If you need that, you have to track the open connections yourself.

## Use cases

The most common use cases are real time updates and notifications:

* Social media notifications

* Notification service events

* News and stock tickers

* Financial dashboards

For example, a social platform can push engagement events (like count, view count, reply count, etc.) to the client over SSE.

![image-20241206-044035.png](/blog/server-sent-event-sse/image_20241206_044035.png)

## Extra things to consider

SSE is simple, but there are a few things to consider for the event stream:

* Compress the data and optimize the format (JSON or Protocol Buffers) if the payloads are big

* Batch data (send batches on an interval instead of instantly, if UX is not affected)

* Prioritize events: send important events first and/or more often
