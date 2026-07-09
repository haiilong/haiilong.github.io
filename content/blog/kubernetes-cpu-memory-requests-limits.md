---
title: Kubernetes CPU and memory requests are four different knobs
date: 2026-07-08
description: How CPU and memory requests and limits map to different scheduler, cgroup, and OOM behavior.
tags: [tech]
---

For the longest time, when I see

```yaml
resources:
  requests:
    cpu: "100m"
    memory: "256Mi"
  limits:
    cpu: "400m"
    memory: "1Gi"
```

I always think request is the minimum, limit is the maximum. CPU has one pair and Memory has another pair and your pods will get something in between them.

Intuitively that should be common sense, but after some painful problems and deep dives into these 4 numbers, they are not even that related to each other.

- CPU request is scheduler math and CPU weight.
- CPU limit is a CFS quota.
- Memory request is scheduler math and OOM preference.
- Memory limit is a cgroup memory ceiling.

One can technically think of them as 4 different mechanisms.

Note: CFS stands for the Completely Fair Scheduler. It is the core algorithm inside the Linux Kernel that decides which process gets to use the CPU. (Google this if you're interested in how it works, quite interesting).

## 1. Background Context: the pod that looked fine

The workload was a .NET background worker. Every second it woke up, called a bunch of data from some hybrid caches, evaluated rules across live matches, built a 30 to 50KB log string, serialized some JSON, pushed work through queue workers, talked to Redis, then went back around the loop. Nothing fancy but just parallel enough to be CPU-spiky.

Grafana said the pod averaged around 150m CPU. The node had spare CPU. The 400m limit looked generous enough.

But the logs had gaps. A log that denotes job's start time should have appeared every second. Sometimes it jumped by 3 or 4 seconds. Profiling did not show one obvious slow function. Redis looked fine. The node was not busy.

So obviously there is just something wrong with the CPU that the job was just completely missed. Let's dive into what CPU limit, as well as the other 3 numbers mean.

## 2. CPU limit is a tiny bucket

On Linux, Kubernetes usually enforces CPU limits with CFS bandwidth control. In cgroup v1 you see it as:

```text
cpu.cfs_quota_us
cpu.cfs_period_us
```

In cgroup v2 you see it as:

```text
cpu.max
```

The default period is usually 100ms. A `400m` CPU limit means 0.4 CPU:

```text
0.4 * 100ms = 40ms
```

So the container gets 40ms of CPU time per 100ms period. Once it spends that budget, the kernel throttles the cgroup until the next period.

In cgroup v2 that often looks like this:

```text
40000 100000
```

That means 40,000 microseconds of quota in a 100,000 microsecond period. If there is no CPU limit, the first value is `max`.

The rude bit: the quota is shared by all threads in the cgroup.

If 8 threads run at once, they can spend 40ms of CPU budget in about 5ms of wall time. Then the whole container waits for the rest of the 100ms period. Your app thread waits. Timer callbacks wait. Redis callbacks wait. GC waits. Everything in that cgroup waits.

This can happen while the node has idle CPU. The kernel is not doing a cluster-wide fairness calculation at that point. It is enforcing the quota for this one cgroup.

That is how a pod averaging 150m can still get hurt by a 400m limit. The average hides the burst.

For a worker that wakes up once per second, this shape is common:

```text
900ms mostly idle
100ms busy with several threads
```

The 1 minute average looks boring. The 100ms quota window is where the problem lives.

A burst that needs 200ms of actual CPU under a 400m limit needs five quota periods:

```text
40ms quota per period * 5 periods = 200ms CPU
5 periods * 100ms = 500ms wall time
```

Now add a Gen2 GC or a Redis callback backlog in the same second. The log gap is no longer mysterious.

It also explains why this problem feels so weird when you debug it. The app is not slow in the normal sense. There may be no bad LINQ query, no lock, no bad network call. The process just stops getting CPU for chunks of time.

### The metric that tells on it

If you have Prometheus metrics from cAdvisor, these are the two I usually check:

```promql
rate(container_cpu_cfs_throttled_periods_total[5m])
rate(container_cpu_cfs_throttled_seconds_total[5m])
```

`throttled_periods` tells you how often the cgroup hit quota. `throttled_seconds` tells you how much wall time got spent waiting.

The gotcha is that a small amount of throttling is not always a problem. Batch jobs can tolerate it. A web API or 1 second worker may not. I care more when app latency, queue delay, or tick gaps line up with throttled seconds.

Inside a container on cgroup v2, `cpu.stat` is also useful:

```bash
cat /sys/fs/cgroup/cpu.stat
```

You may see fields like:

```text
nr_periods 12345
nr_throttled 678
throttled_usec 9012345
```

That is a nice sanity check when dashboards are too averaged.

## 3. CPU request is not a smaller CPU limit

CPU request does not cap the pod (It does not mean you will only get what you request). It does two different jobs.

First, the scheduler uses it for placement. If a pod requests 500m, Kubernetes tries to put it on a node where the sum of CPU requests still fits. Inside that node, each pod is guaranteed at least its request.

Second, the runtime turns it into CPU weight. In cgroup v1 this was `cpu.shares`. In cgroup v2 it is `cpu.weight`. When the node is genuinely busy, that weight decides relative CPU time between cgroups.

On an idle node, a pod requesting 100m can use 4 cores if nothing stops it. That is not stealing. That is how CPU is supposed to work. Spare CPU is available until somebody else needs it.

So imagine if there are 2 pods, cpu request of 500m and 1000m in a node with 3000m CPU, and both pods are trying to use as much CPU as they can with nothing else on the node contending for it, they can use up to 1000m and 2000m respectively, split according to their request weights.

This is why removing CPU limits is usually fine for normal services. Other pods are protected by their requests when CPU is contested. Your pod can use idle cycles, but it does not get to ignore everyone else's weight when the node is busy.

The trade changes from "hard pause every time I hit quota" to "normal Linux scheduling under contention". For bursty workloads, I usually prefer the second failure mode.

One caveat: in shared or multi-tenant clusters, some teams keep CPU limits on purpose, not because of correctness, but as a cost or fair-use control so one team's burst does not eat another team's headroom. If that is your situation, the "just remove the limit" advice trades one problem for a different conversation with whoever owns cluster capacity.

### The HPA gotcha

CPU request is also the denominator for HPA CPU utilization.

If a pod requests 100m and uses 150m, HPA sees 150% CPU utilization for that pod. If the same pod requests 500m and uses 150m, HPA sees 30%.

The workload and CPU usage are the same, but the scaling signal is different.

That is why "just raise the request" is not a free change if HPA is based on CPU utilization. You may need to adjust the HPA target at the same time, or switch to a raw CPU metric or an app metric.

Also, if CPU request is missing for a container, HPA cannot calculate CPU utilization for that pod. This is another reason BestEffort pods and CPU-based HPA do not mix well.

This one is easy to forget because requests look like capacity planning, but they leak into autoscaling behavior too.

## 4. Memory limit is not throttle, it kills

Memory does not have the same nice failure mode as CPU. CPU is compressible. The kernel can give you less CPU time and your app still runs, just slower.

Memory is not like that. Once memory is allocated, the kernel cannot ask your process to "use RAM slower". It can reclaim page cache. It can apply pressure. Eventually it can kill something.

In cgroup v1, the memory limit maps to `memory.limit_in_bytes`. In cgroup v2, it maps to `memory.max`.

If your container crosses the memory limit and the kernel cannot reclaim enough memory, the OOM killer gets involved. In the usual one-process container, PID 1 dies and Kubernetes restarts the container. Your app does not get a clean exception. `finally` blocks do not save you. The pod status says `OOMKilled` and that is that.

## 5. Memory request is not reserved RAM

Memory request is mainly scheduler math.

If a pod requests 1Gi, Kubernetes schedules as if that 1Gi matters. It does not mean the kernel puts 1Gi aside for that pod and refuses to let anyone else touch it.

At runtime, the request affects survival under memory pressure. Kubernetes uses QoS class and OOM score adjustment to decide which pods are better candidates when the node is under pressure.

On plain cgroup setups, memory request does not normally become `memory.min` or `memory.low`. Kubernetes has a MemoryQoS feature for cgroup v2 that can add more memory protection behavior, but I would not assume it exists unless you know your cluster has it enabled. The related knob to know about is `memory.high`, a soft ceiling the kernel uses to lean on a cgroup and slow down allocation before it ever reaches `memory.max`. It is the closest thing memory has to CPU throttling, but it is still not the same guarantee, and MemoryQoS is what wires request/limit into it.

The rough idea:

- Guaranteed pods are protected the most.
- BestEffort pods are the easiest to evict or kill.
- Burstable pods sit in the middle, and using much more than requested does not help your case.

This is why a tiny memory request is not just a scheduling lie. It can also move the pod closer to the front of the kill line when the node runs out of memory.

For services I care about, I usually want memory request close to normal working set, then memory limit at the point where restart is better than letting the process keep growing.

Often that means request equals limit for memory.

```yaml
resources:
  requests:
    memory: "1Gi"
  limits:
    memory: "1Gi"
```

That covers the four knobs themselves. What follows is where they start interacting with each other, and where Kubernetes quietly changes what you asked for.

## 6. QoS has a trap

Kubernetes QoS is like survival ranking

- Guaranteed: every container has CPU and memory request and limit set, and request equals limit for both.
- Burstable: at least one request or limit is set, but the pod is not Guaranteed.
- BestEffort: no requests and no limits.

Here is the trap: if you remove CPU limit, the pod is not Guaranteed anymore, even if memory request equals memory limit.

That can be fine. I would still rather run a normal API pod with no CPU limit than force `cpu request == cpu limit` just to get Guaranteed QoS and then spend the next month chasing latency spikes caused by throttling.

## 7. Guaranteed QoS and CPU Manager static policy

CPU Manager static policy is a kubelet feature that, when enabled, can assign exclusive physical CPU cores to a container instead of letting it share time-sliced CPU with everything else on the node. But it only does this under specific conditions: the pod must be Guaranteed QoS, and the CPU request must be a whole integer (e.g., 1, 2, 4 - not 1.5 or 150m).

Why they're linked to Guaranteed QoS: If you want exclusive pinned cores (no noisy-neighbor interference, no context-switching jitter), you need Guaranteed QoS and whole-number CPU requests that match limits. That's the only combination the static policy will actually pin.

Guaranteed QoS + exclusive cores is a specialized tool for a specific problem: low-latency, CPU-sensitive workloads, things like real-time signal processing, high-frequency trading systems, telco/NFV workloads, or anything sensitive to CPU cache eviction and scheduling jitter. These need consistent, dedicated access to the same physical cores.

It's not meant for typical workloads with variable usage patterns, like a service that averages 150 millicpu but occasionally spikes to 400m. For that kind of workload, a Burstable QoS with a modest request and higher limit is the better fit.

## 8. The defaults can betray you

Two Kubernetes defaults are worth knowing.

First, if you set a limit but no request, Kubernetes may copy the limit into the request, unless an admission policy already supplied a request.

This:

```yaml
resources:
  limits:
    cpu: "500m"
    memory: "512Mi"
```

can effectively become this:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "512Mi"
  limits:
    cpu: "500m"
    memory: "512Mi"
```

That may be fine, but it is not always what you meant.

Second, a `LimitRange` can inject default requests and limits into pods at admission time. You can remove `limits.cpu` from your manifest and still get a CPU limit after the API server admits the pod.

If throttling makes no sense, check the live pod:

```bash
kubectl get pod my-pod -o yaml
```

Do not only check the Helm values or the Deployment template you thought you applied.

## 9. The tmpfs emptyDir surprise

Another memory detail that is easy to miss: `emptyDir` with `medium: Memory` counts against memory.

For example:

```yaml
volumes:
  - name: scratch
    emptyDir:
      medium: Memory
```

Files written there live in tmpfs. They are not managed by your language runtime. The .NET GC cannot see them and cannot clean them. If your app writes 600Mi of temporary files into a memory-backed `emptyDir`, that memory still counts.

Kubernetes also says that if you set a memory limit, the maximum size of a memory-backed `emptyDir` is tied to the pod's memory limit unless you set a size limit separately.

So if a pod OOMs and heap graphs look fine, check tmpfs, file buffers, native memory, and page cache. Not every OOM is a managed heap problem.

## 10. The .NET gotcha after removing CPU limit

`Environment.ProcessorCount` respects CPU utilization limits. With a 400m CPU limit, .NET rounds up and the process usually sees:

```text
ProcessorCount = 1
```

Remove the CPU limit and the runtime may suddenly see the node's CPU count. On a 32 core node, that can change ThreadPool behavior, parallelism defaults, and Server GC heap count.

So the CPU fix can accidentally become a memory change.

That is a fun one to explain after you remove the CPU limit, throttling disappears, and then the pod starts using more memory because the runtime now thinks it has a much bigger machine.

If the app depends on runtime CPU count, pin it explicitly:

```yaml
env:
  - name: DOTNET_PROCESSOR_COUNT
    value: "2"
```

Do not copy `4` because a blog post used it. Pick the number based on how much parallelism the app should have.

For JVM workloads, the equivalent knob is usually:

```text
-XX:ActiveProcessorCount=4
```

It is the same idea: make the runtime view of the machine intentional.

## 11. My default now

For most normal services, I like this shape:

```yaml
resources:
  requests:
    cpu: "500m"
    memory: "1Gi"
  limits:
    memory: "1Gi"
```

Then tune from real metrics.

One tool worth knowing: the Vertical Pod Autoscaler has an updateMode field, and one of the modes is Off. In that mode VPA computes recommendations from historical usage and exposes them on the VerticalPodAutoscaler object's status, but it never applies them, no restarts, no evictions, nothing changes at runtime.

```bash
kubectl describe vpa my-app-vpa
```

That gives you `target`, `lowerBound`, `upperBound`, and `uncappedTarget` for CPU and memory, based on what the pod actually used, not a guess.

The caveat is that VPA's recommendation is usage-based, not throttling-aware. It will tell you the p90 CPU usage looked fine. It will not tell you the cgroup got throttled 40 times last week while that average sat there looking calm. That is exactly the gap this whole post started in. So I use VPA in `Off` mode as an input for picking a request, and I still check `cfs_throttled_periods` and `cfs_throttled_seconds` from section 2 before I trust the number.

## References

- [Kubernetes resource management for Pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes QoS classes](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Kubernetes CPU Manager policies](https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/)
- [Kubernetes Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Kubernetes LimitRange](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [.NET Environment.ProcessorCount](https://learn.microsoft.com/en-us/dotnet/api/system.environment.processorcount)
- [.NET DOTNET_PROCESSOR_COUNT override](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/6.0/environment-processorcount-on-windows)