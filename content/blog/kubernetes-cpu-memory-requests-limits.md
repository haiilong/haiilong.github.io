---
title: Kubernetes CPU and memory requests are four different knobs
date: 2026-07-08
description: How CPU and memory requests and limits map to different scheduler, cgroup, and OOM behavior.
tags: [tech]
---

For the longest time, when I saw

```yaml
resources:
  requests:
    cpu: "100m"
    memory: "256Mi"
  limits:
    cpu: "400m"
    memory: "1Gi"
```

I thought request is the minimum and limit is the maximum. CPU has one pair, memory has another, and your pod gets something in between.

That sounds like common sense, but after a few problems and some digging into these 4 numbers, it turns out they are barely related to each other.

- CPU request is scheduler math and CPU weight.
- CPU limit is a CFS quota.
- Memory request is scheduler math and OOM preference.
- Memory limit is a cgroup memory ceiling.

Note: CFS stands for the Completely Fair Scheduler. It is the core algorithm inside the Linux Kernel that decides which process gets to use the CPU. (Google this if you're interested in how it works, quite interesting).

## 1. Background Context: the pod that looked fine

The workload was a .NET background worker. Every second it woke up, pulled a bunch of data from some hybrid caches, evaluated rules across live matches, built a 30 to 50KB log string, serialized some JSON, pushed work through queue workers, talked to Redis, then went back around the loop. Nothing fancy, but parallel enough to be CPU-spiky.

Grafana said the pod averaged around 150m CPU. The node had spare CPU. The 400m limit looked generous enough.

But the logs had gaps. The job logs its start time every second, and sometimes the timestamps jumped by 3 or 4 seconds. Profiling did not show any obvious slow function, Redis looked fine, and the node was not busy.

Whole ticks were being skipped, so something was clearly wrong with CPU. Here is what the CPU limit and the other 3 numbers actually do.

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

The quota is shared by all threads in the cgroup. If 8 threads run at once, they can burn the 40ms budget in about 5ms of wall time, and then the whole container waits out the rest of the 100ms period. App threads, timer callbacks, Redis callbacks, GC, everything in that cgroup waits.

This happens even when the node has idle CPU, because the kernel is only enforcing this cgroup's quota. It is not looking at the rest of the node.

So a pod averaging 150m can still get throttled by a 400m limit, because the average hides the burst.

For a worker that wakes up once per second, this shape is common:

```text
900ms mostly idle
100ms busy with several threads
```

The 1 minute average looks boring, but the problem happens inside the 100ms quota window.

A burst that needs 200ms of actual CPU under a 400m limit needs five quota periods:

```text
40ms quota per period * 5 periods = 200ms CPU
5 periods * 100ms = 500ms wall time
```

Add a Gen2 GC or a Redis callback backlog in the same second and the log gaps make sense.

This is also why it's so confusing to debug. The app isn't slow in the normal sense, and there may be no bad LINQ query, lock, or slow network call. The process just stops getting CPU for chunks of time.

### The metric that tells on it

If you have Prometheus metrics from cAdvisor, these are the two I usually check:

```promql
rate(container_cpu_cfs_throttled_periods_total[5m])
rate(container_cpu_cfs_throttled_seconds_total[5m])
```

`throttled_periods` tells you how often the cgroup hit quota. `throttled_seconds` tells you how much wall time got spent waiting.

A small amount of throttling is not always a problem. Batch jobs can tolerate it. A web API or 1 second worker may not. I care more when app latency, queue delay, or tick gaps line up with throttled seconds.

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

It's a good sanity check when the dashboards average everything out.

## 3. CPU request is not a smaller CPU limit

CPU request does not cap the pod, so you can use more than you request. It does two other jobs.

First, the scheduler uses it for placement. If a pod requests 500m, Kubernetes puts it on a node where the sum of CPU requests still fits. On that node, each pod is guaranteed at least its request.

Second, the runtime turns it into CPU weight. In cgroup v1 this was `cpu.shares`. In cgroup v2 it is `cpu.weight`. When the node is busy, that weight decides how CPU time is split between cgroups.

On an idle node, a pod requesting 100m can use 4 cores if nothing stops it. That isn't stealing, it's how CPU is supposed to work: spare CPU is available until somebody else needs it.

Say 2 pods request 500m and 1000m on a node with 3000m CPU. If both try to use as much CPU as they can and nothing else on the node competes, they get up to 1000m and 2000m, split by their request weights.

That's why removing CPU limits is usually fine for normal services. When CPU is contested, other pods are still protected by their requests. Your pod can use idle cycles, but it can't ignore everyone else's weight on a busy node.

You trade "hard pause every time I hit quota" for "normal Linux scheduling under contention", and for bursty workloads I prefer the second.

One caveat: in shared or multi-tenant clusters, some teams keep CPU limits on purpose as a cost or fair-use control, so one team's burst does not eat another team's headroom. In that case, removing the limit is a conversation to have with whoever owns cluster capacity.

### The HPA gotcha

CPU request is also the denominator for HPA CPU utilization.

If a pod requests 100m and uses 150m, HPA sees 150% CPU utilization for that pod. If the same pod requests 500m and uses 150m, HPA sees 30%.

The workload and CPU usage are the same, but the scaling signal is different.

So if HPA scales on CPU utilization, raising the request is not a free change. You may need to adjust the HPA target at the same time, or switch to a raw CPU metric or an app metric.

Also, if CPU request is missing for a container, HPA cannot calculate CPU utilization for that pod. This is another reason BestEffort pods and CPU-based HPA do not mix well.

Requests look like capacity planning, so it's easy to forget they affect autoscaling too.

## 4. Memory limit is not throttle, it kills

Memory does not fail as nicely as CPU. CPU is compressible: the kernel can give you less CPU time and your app still runs, just slower.

Memory isn't compressible. Once memory is allocated, the kernel cannot ask your process to "use RAM slower". It can reclaim page cache and apply pressure, and eventually it kills something.

In cgroup v1, the memory limit maps to `memory.limit_in_bytes`. In cgroup v2, it maps to `memory.max`.

If your container crosses the memory limit and the kernel cannot reclaim enough memory, the OOM killer gets involved. In the usual one-process container, PID 1 dies and Kubernetes restarts the container. Your app does not get a clean exception and `finally` blocks do not run. The pod status says `OOMKilled` and that's it.

## 5. Memory request is not reserved RAM

Memory request is mainly scheduler math.

If a pod requests 1Gi, Kubernetes only places it on a node with 1Gi of unrequested memory. The kernel does not set that 1Gi aside for the pod or stop anyone else from using it.

At runtime, the request matters when the node is under memory pressure. Kubernetes uses the QoS class and OOM score adjustment to decide which pods to evict or kill first.

On plain cgroup setups, memory request does not normally become `memory.min` or `memory.low`. Kubernetes has a MemoryQoS feature for cgroup v2 that adds more memory protection, but don't assume it's on unless you know your cluster enabled it. MemoryQoS also uses `memory.high`, a soft ceiling where the kernel starts slowing down allocation before the cgroup reaches `memory.max`. That's the closest thing memory has to CPU throttling, though it's still not the same guarantee.

The rough idea:

- Guaranteed pods are protected the most.
- BestEffort pods are the easiest to evict or kill.
- Burstable pods sit in the middle, and using much more than requested does not help your case.

So a tiny memory request is not only a scheduling lie, it also moves the pod closer to the front of the kill line when the node runs out of memory.

For services I care about, I set the memory request close to the normal working set and the memory limit at the point where a restart is better than letting the process keep growing. Often that means request equals limit:

```yaml
resources:
  requests:
    memory: "1Gi"
  limits:
    memory: "1Gi"
```

## 6. QoS has a trap

Kubernetes QoS is like a survival ranking:

- Guaranteed: every container has CPU and memory request and limit set, and request equals limit for both.
- Burstable: at least one request or limit is set, but the pod is not Guaranteed.
- BestEffort: no requests and no limits.

If you remove the CPU limit, the pod is no longer Guaranteed, even if memory request equals memory limit.

That can be fine. I'd rather run a normal API pod with no CPU limit than force `cpu request == cpu limit` to get Guaranteed QoS and then spend the next month chasing latency spikes from throttling.

## 7. Guaranteed QoS and CPU Manager static policy

CPU Manager static policy is a kubelet feature that can give a container exclusive physical CPU cores instead of time-slicing it with everything else on the node. It only pins cores when the pod is Guaranteed QoS and the CPU request is a whole integer that matches the limit (e.g., 1, 2, or 4, not 1.5 or 150m).

Exclusive cores mean no noisy-neighbor interference and no context-switching jitter. That's useful for low-latency, CPU-sensitive workloads like real-time signal processing, high-frequency trading, telco/NFV, or anything sensitive to CPU cache eviction and scheduling jitter.

It's not meant for typical workloads with variable usage patterns, like a service that averages 150 millicpu but occasionally spikes to 400m. For that kind of workload, Burstable QoS with a modest CPU request and no CPU limit is the better fit, like the default in section 11.

## 8. The defaults can betray you

Two Kubernetes defaults can change what you asked for.

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

An `emptyDir` with `medium: Memory` counts against your memory limit.

For example:

```yaml
volumes:
  - name: scratch
    emptyDir:
      medium: Memory
```

Files written there live in tmpfs, outside your language runtime, so the .NET GC cannot see or clean them. If your app writes 600Mi of temporary files there, that 600Mi still counts.

Per the Kubernetes docs, if you set a memory limit, a memory-backed `emptyDir` can grow up to the pod's memory limit unless you give it its own size limit.

So if a pod OOMs and heap graphs look fine, check tmpfs, file buffers, native memory, and page cache. Not every OOM is a managed heap problem.

## 10. The .NET gotcha after removing CPU limit

`Environment.ProcessorCount` respects CPU utilization limits. With a 400m CPU limit, .NET rounds up and the process usually sees:

```text
ProcessorCount = 1
```

Remove the CPU limit and the runtime may suddenly see the node's CPU count. On a 32 core node, that can change ThreadPool behavior, parallelism defaults, and Server GC heap count.

So the CPU fix can turn into a memory change. You remove the CPU limit, throttling goes away, and then the pod starts using more memory because the runtime now thinks it's on a much bigger machine. That's a fun one to explain.

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

Either way, set the runtime's view of the machine on purpose instead of letting it guess.

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

The Vertical Pod Autoscaler helps with the tuning. Set its `updateMode` to `Off` and VPA computes recommendations from historical usage and shows them in the VerticalPodAutoscaler object's status, but never applies them, so there are no restarts or evictions.

```bash
kubectl describe vpa my-app-vpa
```

That gives you `target`, `lowerBound`, `upperBound`, and `uncappedTarget` for CPU and memory, based on what the pod actually used, not a guess.

VPA's recommendation is based on usage, not throttling. It will tell you p90 CPU usage looked fine, but not that the cgroup got throttled 40 times last week. That is the same gap this post started with. So I use VPA in `Off` mode as an input for picking a request, and I still check `cfs_throttled_periods` and `cfs_throttled_seconds` from section 2 before I trust the number.

## References

- [Kubernetes resource management for Pods and containers](https://kubernetes.io/docs/concepts/configuration/manage-resources-containers/)
- [Kubernetes QoS classes](https://kubernetes.io/docs/tasks/configure-pod-container/quality-service-pod/)
- [Kubernetes CPU Manager policies](https://kubernetes.io/docs/tasks/administer-cluster/cpu-management-policies/)
- [Kubernetes Horizontal Pod Autoscaling](https://kubernetes.io/docs/concepts/workloads/autoscaling/horizontal-pod-autoscale/)
- [Kubernetes LimitRange](https://kubernetes.io/docs/concepts/policy/limit-range/)
- [Vertical Pod Autoscaler](https://github.com/kubernetes/autoscaler/tree/master/vertical-pod-autoscaler)
- [.NET Environment.ProcessorCount](https://learn.microsoft.com/en-us/dotnet/api/system.environment.processorcount)
- [.NET DOTNET_PROCESSOR_COUNT override](https://learn.microsoft.com/en-us/dotnet/core/compatibility/core-libraries/6.0/environment-processorcount-on-windows)