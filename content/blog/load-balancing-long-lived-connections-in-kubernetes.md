---
title: Load Balancing Long Lived Connections in Kubernetes
date: 2024-12-09
description: How long lived connections interact with Kubernetes load balancing.
tags: [tech]
---

TL;DR: Kubernetes doesn't load balance long lived connections, and some Pods might receive more requests than others. Consider client side load balancing or a proxy if you're using HTTP/2, gRPC, long lived HttpClient or other long lived database connection.

## Service (ClusterIP, NodePort) in k8s

Kubernetes Services don't exist.

There's no process for listening to the IP address and port of the Service. Even the IP address can't be found anywhere.

You can check that this is the case by accessing any node in your Kubernetes cluster and executing `netstat -ntlp`.

Kube proxy reads the list of IP addresses for all Services and writes rules in every node.

The rules are meant to say, " If you see this Service IP address, rewrite the request and pick one of the Pods as the destination." The IP Address is only a placeholder.

### By default, Kubernetes uses iptables to implement Services. iptables traditionally does not implement load balancing or round robin strategy, but Kubernetes implements an interesting rule into their iptable. For example, with 3 pods under this service IP, they will implement the rule:

1. With a likelihood of 33%, select Pod 1 as the destination. Otherwise, proceed to the following rule.

2. With a probability of 50%, choose Pod 2 as the destination. Otherwise, proceed to the following rule.

3. Select Pod 3 as the destination (no probability).

## Long lived connections don't get load balanced

What happened if the clients keep sending requests to the same Service? They will be sent to the same pods

You can reproduce this with a small test service that sends repeated requests through a single long lived client.

Why is the traffic not distributed?

* A single TCP connection is open, and the iptables rule was invoked the first time.

* One of the three Pods was selected as the destination.

* Since all subsequent requests are channelled through the same TCP connection, iptables doesn't invoke anymore.

So now you achieve better throughput and latency but completely lost the ability to scale your backend services.

## Solutions

### 1. Client side load balancing

This is the most common solution for larger systems.

The client side code that executes the load balancing should follow the logic below:

1. Retrieve a list of endpoints from the Service.

2. For each of them, open a connection and keep it open.

3. Pick one of the open connections When you need to make a request.

4. At regular intervals, refresh the list of endpoints and remove or add new connections.

5. Refresh the list of endpoints when you have host error

   1. In .NET, you can detect host error with this (you can't use http status code for this error)

```csharp
catch (HttpRequestException ex) when 
    (ex.InnerException is SocketException socketEx && 
     (socketEx.ErrorCode == 11001 || socketEx.ErrorCode == 11004))
{
    Console.WriteLine("IP Resolution Failed");
}
```

Or you can do something more complicated with a dedicated client side load balancer.

You can check sample code at the end.

Cons: Complicated

### 2. Service Mesh to the rescue

A service mesh decouples the communication between services from the application layer to the infrastructure layer. The abstraction at the infrastructure level happens by proxying the traffic between services. Many companies use Service Mesh

![image-20241206-073028.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073028.png)

One of the key benefit of this is the proxy will do the load balancing for you.

There are 2 big players in the market: istio vs linkerd

You can check the CNCF landscape or service mesh project documentation for more options.

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

* Better to be maintained by a dedicated IT team

Service Mesh basically handles client side load balancing for you.

### 3. Scaled down number of pods

If you have more clients than servers, there should be limited issue. The servers will be more utilized

![image-20241206-073629.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073629.png)

The opposite scenario is the troublesome one

![image-20241206-073740.png](/blog/load-balancing-long-lived-connections-in-kubernetes/image_20241206_073740.png)

This is why Horizontal Scaling will not help unless you can load balance long lived connection properly.

So obviously 1 of the solution is to scale down, potentially to even 1 pod, and do Vertical Scaling if needed

Cons: what are the cons of fewer pods, or 1 pod, with vertical scaling?

### 4. Shorter long lived clients

```csharp
services.AddHttpClient<TClient, TImplementation>()
  .ConfigurePrimaryHttpMessageHandler(_ => new SocketsHttpHandler
  {
      PooledConnectionLifetime = TimeSpan.FromMinutes(60)
  });
```

We can make the connection lifetime shorter. You cannot make it too short or else there is no point of having a long lived client

### 5. Changing architecture

This is not possible most of the time, but if you use Event driven architecture, load balancing task is handled by Kafka/RabbitMQ or whatever library you use

### Code for number 1

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
