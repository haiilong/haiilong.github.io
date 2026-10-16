---
title: Load Balancing Long Lived Connections in Kubernetes
date: 2024-12-09
description: How long lived connections interact with Kubernetes load balancing.
tags: [tech]
---

TL;DR: Kubernetes doesn't load balance long lived connections, and some Pods might receive more requests than others. If you use HTTP/2, gRPC, a long lived HttpClient or long lived database connections, consider client side load balancing or a proxy.

## Service (ClusterIP, NodePort) in k8s

Kubernetes Services don't exist.

No process listens on the Service's IP address and port, and you won't find that IP address on any machine either. You can check this by logging into any node in your cluster and running `netstat -ntlp`.

Instead, kube-proxy reads the IP addresses of all Services and writes rules on every node. The rules say "If you see this Service IP address, rewrite the request and pick one of the Pods as the destination." The Service IP is only a placeholder.

By default, Kubernetes implements Services with iptables. iptables doesn't really do load balancing or round robin, so Kubernetes uses probability rules instead. For example, with 3 pods behind a Service IP, the rules are:

1. With a probability of 33%, select Pod 1. Otherwise, go to the next rule.

2. With a probability of 50%, select Pod 2. Otherwise, go to the next rule.

3. Select Pod 3.

## Long lived connections don't get load balanced

If a client keeps sending requests to the same Service over one connection, they will all go to the same pod.

You can reproduce this with a small test service that sends repeated requests through a single long lived client.

The traffic isn't distributed because:

* Only one TCP connection is opened, and the iptables rule is applied once, when it opens.

* That picks one of the three Pods as the destination.

* All later requests go through the same TCP connection, so iptables never gets involved again.

You get better throughput and latency, but adding more backend pods doesn't spread the load.

## Solutions

### 1. Client side load balancing

This is the most common solution for larger systems. The client does the load balancing itself:

1. Retrieve a list of endpoints from the Service.

2. For each of them, open a connection and keep it open.

3. Pick one of the open connections when you need to make a request.

4. Refresh the list of endpoints at regular intervals, opening or closing connections as needed.

5. Also refresh the list of endpoints when you get a host error

   1. In .NET, you can detect a host error like this (there's no HTTP status code for it)

```csharp
catch (HttpRequestException ex) when 
    (ex.InnerException is SocketException socketEx && 
     (socketEx.ErrorCode == 11001 || socketEx.ErrorCode == 11004))
{
    Console.WriteLine("IP Resolution Failed");
}
```

You can also go further and use a dedicated client side load balancer. Sample code is at the end of the post.

Cons: Complicated

### 2. Service Mesh to the rescue

A service mesh moves service to service communication out of the application and into the infrastructure layer by proxying the traffic between services. Many companies use one.

![image-20241206-073028.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073028.png)

One of the main benefits is that the proxy does the load balancing for you.

The 2 big players are istio and linkerd. The CNCF landscape lists more options. With istio, round robin looks like this:

```yaml
apiVersion: networking.istio.io/v1alpha3
kind: DestinationRule
metadata:
  name: my-service-destination
spec:
  host: my-service
  trafficPolicy:
    loadBalancer:
      simple: ROUND_ROBIN
```

Cons:

* You have an extra container in every pod

* Costs more to operate

* Ideally needs a dedicated team to maintain it

### 3. Scale down the number of pods

If you have more clients than servers, this is mostly fine, and the servers are well utilized.

![image-20241206-073629.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073629.png)

The opposite case is the problem:

![image-20241206-073740.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073740.png)

So horizontal scaling doesn't help unless long lived connections are load balanced properly. One option is to scale down, maybe even to 1 pod, and scale vertically if needed.

Cons:

* Less redundancy. With 1 pod, a crash or a node going down takes the whole service down

* Vertical scaling has a ceiling, a pod can only be as big as the node it runs on

* Restarts and deployments hurt more when there are fewer pods to pick up the traffic

### 4. Shorter long lived clients

```csharp
services.AddHttpClient<TClient, TImplementation>()
  .ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler
  {
      PooledConnectionLifetime = TimeSpan.FromMinutes(60)
  });
```

A shorter connection lifetime makes clients reconnect, and get re-balanced, more often. Don't make it too short, or there's no point having a long lived client.

### 5. Change the architecture

This usually isn't an option, but with an event driven architecture, Kafka/RabbitMQ (or whatever you use) handles the load balancing.

### Code for solution 1

```csharp
public class RoundRobinK8sClientHandler : HttpClientHandler
{
    private ConcurrentDictionary<string, HttpClient> _persistentClients;
    private ReaderWriterLockSlim _clientsLock = new ReaderWriterLockSlim();
    private int _currentIndex = 0;

    private readonly string _namespace;
    private readonly string _serviceName;
    private readonly Kubernetes _k8sClient = new Kubernetes(KubernetesClientConfiguration.BuildDefaultConfig());

    public RoundRobinK8sClientHandler(string namespace, string serviceName)
    {
        _namespace = namespace;
        _serviceName = serviceName;
        _persistentClients = new ConcurrentDictionary<string, HttpClient>();
        RefreshClient();
    }

    private async Task<List<PodInfo>> GetPodsByServiceWithIpAsync()
    {
        var service = await _k8sClient.ReadNamespacedServiceAsync(_serviceName, _namespace);
        var podList = await _k8sClient.ListNamespacedPodAsync(
            _namespace, 
            labelSelector: string.Join(",", 
                service.Spec.Selector.Select(kvp => $"{kvp.Key}={kvp.Value}"))
        );

        return podList.Items.Select(pod => pod.Status.PodIP).ToList();
    }

    private void RefreshClient()
    {
        _clientsLock.EnterWriteLock();
        try
        {
            var endpoints = GetPodsByServiceWithIpAsync().GetAwaiter().GetResult();

            var newClients = new ConcurrentDictionary<string, HttpClient>();
            foreach (var endpoint in endpoints)
            {
                if (!_persistentClients.TryGetValue(endpoint, out var existingClient))
                {
                    existingClient = new HttpClient(new HttpClientHandler())
                    {
                        BaseAddress = new Uri(endpoint)
                    };
                }
                newClients[endpoint] = existingClient;
            }

            _persistentClients = newClients;
        }
        finally 
        {
            _clientsLock.ExitWriteLock();
        }
    }

    protected override async Task<HttpResponseMessage> SendAsync(
        HttpRequestMessage request, 
        CancellationToken cancellationToken)
    {
        _clientsLock.EnterReadLock();
        try
        {
            if (_persistentClients.Count == 0)
            {
                RefreshClient();
            }

            var endpoints = _persistentClients.Keys.ToList();
            if (endpoints.Count == 0)
            {
                throw new InvalidOperationException("No endpoints available");
            }

            // Round-robin endpoint selection
            string selectedEndpoint = endpoints[
                Interlocked.Increment(ref _currentIndex) % endpoints.Count];

            var client = _persistentClients[selectedEndpoint];

            // Clone the request for the specific endpoint
            var newRequest = new HttpRequestMessage(request.Method, request.RequestUri);
            newRequest.Content = request.Content;
            foreach (var header in request.Headers)
            {
                newRequest.Headers.TryAddWithoutValidation(header.Key, header.Value);
            }

            return await client.SendAsync(newRequest, cancellationToken);
        }
        catch (HttpRequestException ex) when 
            (ex.InnerException is SocketException socketEx && 
              (socketEx.ErrorCode == 11001 || socketEx.ErrorCode == 11004))
        {
            RefreshClient();
        }
        finally 
        {
            _clientsLock.ExitReadLock();
        }
    }
}


services.AddHttpClient("MyClient")
    .ConfigurePrimaryHttpMessageHandler(sp => new RoundRobinK8sClientHandler("app-namespace", "sample-service"));
```
