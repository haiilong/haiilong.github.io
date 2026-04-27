---
title: Server Sent Event (SSE)
date: 2024-11-25
description: A practical look at Server Sent Events and when to use them.
tags: [tech]
---

## Communication type

In the realm of real time transportations, there are some options to communicate between 2 entities (server and client)

1. Long Polling

   1. The client sent an HTTP request to the server, the server will hold the request open until new data is available or time out occur

   2. Pros: Work with older browser

   3. Cons: Inefficient, high latency

2. Short Polling

   1. Client sent an HTTP request to the server, the server will respond. Pull based request

   2. Pros: Flexible with many systems

   3. Cons: Frequent polling needed if the client doesn't know when new data is ready. Also slow to frequent update

3. Server Sent Event (SSE)

   1. The client creates a persistent HTTP connection with the server. The server can send events to the client and the client can act accordingly

   2. Pros: Simple one way server to client push based communication with low overhead

   3. Cons: It only does what it does (no 2 way communication)

4. WebSockets

   1. The client and server establish a full duplex communication channel over a single TCP connection. Both parties can send and receive data at any time.

   2. Pros: 2 way communication

   3. Cons: Most complex and not supported by all browsers

## SSE

I will focus on Server Sent Events, their use cases and how to implement them.

In .NET Core, using minimal API, the server will expose this endpoint:

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

1. A `HttpContext` and `CancellationToken` are needed.

2. We directly modify the `HttpContext` `Response`

   1. The `Content-Type` header will be `text/event-stream`

   2. Data is directly written to the `Response` body

Any Javascript Client that want to receive the event will implement

```javascript
const eventSource = new EventSource(url + "/data-stream");

eventSource.onmessage = function(event) {
    console.log(event.data)
}

eventSource.onerror = function(event) {
    // log error
}
```

If you inspect the client, you will see

![image-20241206-043340.png](/blog/server-sent-event-sse/image_20241206_043340.png)

Any time a new client join, they will start receiving events

Note that there is no way to manage clients from server side (how many clients are connected, manually disconnect client, etc.) due to the nature of SSE.

## Use cases

The most common use cases are real time updates and notifications

* Social media notifications

* Notification service events

* News and stock tickers

* Financial Dashboard

An example is a social platform pushing engagement events (like count, view count, reply count, etc.) to the client using SSE

![image-20241206-044035.png](/blog/server-sent-event-sse/image_20241206_044035.png)

## Extra thing to consider

Even though SSE is very simple, there are a few things you can consider with regard to the event stream

* Compress data and optimize data format (JSON or Protocol Buffer) if the data size is big

* Batch data together (send every interval with batches instead of instantly if UX is not affected)

* Prioritize Events: important events can be sent first, and/or more often
