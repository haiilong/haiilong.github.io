---
title: Building an ML Inference API, Part III
date: 2025-09-05
description: Technical design choices for ML Inference API
tags: [tech]
---

## Template

If you are looking for a template to start building an ML Inference API, check out [haiilong/ml-inference-api-template](https://github.com/haiilong/ml-inference-api-template) on GitHub, which follows on from [Part II](/blog/building-ml-inference-part-2). It covers:

1. Project structure
2. Sample codes with 2 different endpoints
3. 2 sample models
4. Middlewares set up
5. Dockerfile
6. uv as Python package manager
7. Unit tests (pytest), load tests (k6), e2e tests (node-fetch)
8. Deployment (Docker registry, Kubernetes cluster, gitlab-ci)
9. How to extend and apply to your use case

This structure is **production-ready**. Of course you can always add your own stuff like HPA, VPA or other middlewares if needed.

PLEASE READ THE README CAREFULLY IF YOU WANT TO USE THIS TEMPLATE :D.

This post explains the technical decisions behind the template, which we eventually used for all our ML Inference APIs.

**Sections:**

1. [Why FastAPI / Uvicorn / Gunicorn (not Flask + gevent)](#_1-why-fastapi-uvicorn-gunicorn-not-flask-gevent)
2. [Why orjson over the default JSON encoder](#_2-why-orjson-over-the-default-json-encoder)
3. [Why uv over conda](#_3-why-uv-over-conda)
4. [anyio vs asyncio](#_4-anyio-vs-asyncio)
5. [`async def` plus `run_in_threadpool` (the importance of the offload)](#_5-async-def-plus-run_in_threadpool-the-importance-of-the-offload)
6. [Why an initContainer loads models from a PVC in Kubernetes](#_6-why-an-initcontainer-loads-models-from-a-pvc-in-kubernetes)
7. [Hot reload models in production, or redeploy?](#_7-hot-reload-models-in-production-or-redeploy)


## 1. Why FastAPI / Uvicorn / Gunicorn (not Flask + gevent)

A common Python ML serving stack is Flask under gunicorn with gevent workers. It's deployed everywhere and fine for very simple cases, but the template uses **FastAPI on Uvicorn workers under Gunicorn** instead, for these reasons:

**Concurrency model.** Gevent gets concurrency by monkey-patching the standard library so blocking I/O cooperatively yields. That's great for I/O-bound web apps, but it breaks down with C extensions. NumPy, scikit-learn, XGBoost, and CatBoost spend most of their time inside C code that does not yield to gevent's scheduler, so one slow inference still blocks every request the worker is multiplexing.

FastAPI on Uvicorn uses an asyncio event loop and offloads CPU-bound inference explicitly to a bounded thread pool (see section 5), so the loop doesn't block even when a prediction takes 200 ms. The goal is the same as gevent's, but the boundaries are explicit instead of monkey-patched.

**Validation and schema for free.** FastAPI builds on Pydantic. Defining a request body as a `BaseModel` gives you:

- automatic 422 responses with field-level error messages on bad input,
- generated OpenAPI / Swagger UI at `/`,
- typed request handlers, so editor tooling and `mypy` understand the code.

In Flask, you write that boilerplate by hand or pull in extensions (`marshmallow`, `flask-pydantic`, `flask-smorest`). For an inference API, where the request shape is the contract with the caller, FastAPI's defaults are close to what you would build anyway.

**Why Gunicorn at all if Uvicorn can serve directly.** Uvicorn is the ASGI server (one process, one event loop). Gunicorn is a process supervisor that manages multiple worker processes, handles graceful reload on SIGHUP, restarts crashed workers, listens on a single socket and load-balances across workers, and integrates with most ops tooling. Running `gunicorn -k uvicorn.workers.UvicornWorker` gives you:

- process-level isolation across CPU cores (one event loop per worker),
- production-grade signal handling and graceful shutdown,
- Uvicorn's ASGI runtime inside each worker.

Tuning: set `GUNICORN_WORKERS` to roughly `min(cpu_count, target_concurrency / threads_per_worker)`. For inference workloads, one worker per CPU core is usually a good starting point.


## 2. Why orjson over the default JSON encoder

Python's stdlib `json` module is slow compared to orjson, even with its C accelerator. For inference APIs that return predictions as JSON, encoding can take a measurable share of request time, especially with numpy floats or long batch outputs.

orjson is written in Rust and:

- Serializes something like 10x as fast as stdlib `json`, according to [orjson's own benchmarks](https://github.com/ijl/orjson?tab=readme-ov-file#performance).
- Returns `bytes` directly, which is the native ASGI write type. Stdlib `json` produces a `str` that has to be encoded to bytes again.
- Handles `datetime`, `UUID`, `dataclasses`, and (via passthrough flags) numpy arrays without a custom `default=` function.
- Is strict about the JSON spec (no NaN by default, deterministic key order if asked).

We wire it in once on the app object:

```python
app = FastAPI(default_response_class=ORJSONResponse, ...)
```

After that, every endpoint returns orjson-encoded responses with no per-route changes.

Don't bother if your responses are tiny (a single float) and throughput is low (under 100 RPS), since the win is microseconds. For batch predictions, payload size grows linearly with batch size, so orjson is the right default.


## 3. Why uv over conda

ML projects often default to conda because that is what notebook environments use. For a deployable inference service, `uv` is much better.

**Speed.** uv is written in Rust, and a clean dependency install for this template takes a few seconds. The equivalent conda env solve (especially with custom channels and pinned versions) often takes minutes, and every CI and Docker build pays that difference.

**Simpler container images.** With conda, you typically end up with two Dockerfiles:

- `Dockerfile.base` that installs micromamba and creates the env.
- `Dockerfile` that copies source on top of the base.

You also end up with a `Dockerfile.local` and a `Dockerfile.test` to keep things consistent, and the base image has to be pre-built and cached in a registry to keep main builds fast.

With uv, the production image is one stage with no base image and no separate registry artifact, because `uv sync --frozen --no-dev` installs into `/opt/venv` fast enough. The template uses a single `Dockerfile` (plus a tiny `Dockerfile.test`).

**First-class lockfile.** `uv.lock` is committed and reproducible. `uv lock --check` in CI fails fast if anyone forgot to update it. Conda's lockfile story (`conda-lock`) works but is a separate tool with separate pitfalls.

**Pure PyPI.** Everything comes from PyPI, so there are no custom channels, no channel ordering bugs, and no "which channel does this come from" mysteries.

When conda still wins:

- Hard non-Python dependencies that conda packages provide and PyPI does not (some MKL builds, some GIS stacks, some CUDA-pinned tooling).
- Notebook / data science workflows where you want one tool managing kernels, Python versions, and packages together.

For an ML inference *service* whose dependencies are joblib, scikit-learn, xgboost, and FastAPI, those gaps do not apply.


## 4. anyio vs asyncio

`asyncio` is the stdlib async runtime. `anyio` is a higher-level wrapper that runs on top of asyncio (or trio) and adds:

- structured concurrency (task groups with proper cancellation propagation),
- a global thread limiter so `anyio.to_thread.run_sync` does not spawn unbounded threads,
- cleaner cancel scopes and timeout primitives,
- a portable API: the same code runs on asyncio or trio.

You do not need to import `anyio` directly, because Starlette and FastAPI use it internally. That means:

- `fastapi.concurrency.run_in_threadpool` is a thin wrapper over `anyio.to_thread.run_sync`.
- The thread pool that runs your offloaded inference is anyio's, capped by anyio's global limiter (default 40 threads).
- Dependency injection, background tasks, and lifespan all run on the anyio runtime.

In practice:

- Do not write `asyncio.to_thread(...)` in handlers, because it bypasses the limiter and uses a separate pool that anyio can't control. Use `run_in_threadpool` (or `anyio.to_thread.run_sync` directly).
- If you need to raise the thread limit for high-concurrency CPU-bound inference, do it once at startup with `anyio.to_thread.current_default_thread_limiter().total_tokens = N`. Threads have memory overhead and switching cost, so don't push it too high.
- Using `asyncio.create_task` is fine, but prefer `anyio.create_task_group` when you want clean cancellation on error.


## 5. `async def` plus `run_in_threadpool` (the importance of the offload)

The README covers the basic recipe; this section explains why.

**The pitfall.** This handler looks fine:

```python
@app.post("/predict/price")
async def post_predict_price(request: PricePredictionRequest):
    return calculate_price(request)  # WRONG: blocking call inside async handler
```

`calculate_price` calls `model.predict(...)`, a synchronous CPU-bound C extension call that blocks the event loop until it returns. While it runs:

- no other request handler on this worker can make progress,
- no health check can be answered,
- no timeout, cancellation, or middleware can interleave.

If predictions take 50 ms and you receive 100 concurrent requests, the 100th caller waits 5 seconds for what should be a 50 ms operation, and the event loop gives you no concurrency at all.

**The fix.** Offload the blocking call to a worker thread:

```python
@app.post("/predict/price")
async def post_predict_price(request: PricePredictionRequest):
    return await run_in_threadpool(calculate_price, request)
```

Now the event loop awaits the thread pool and stays responsive, and other requests are served concurrently up to the pool size. The GIL still serializes pure-Python work between threads, but ML libraries (numpy, sklearn, xgboost) release it inside their C kernels, so multi-threaded inference does scale.

**Why not let FastAPI do it implicitly with `def` instead of `async def`?**

If you write a *sync* handler (`def`, not `async def`), FastAPI auto-runs it in the threadpool for you. So you could write:

```python
@app.post("/predict/price")
def post_predict_price(request: PricePredictionRequest):
    return calculate_price(request)
```

and it would behave correctly. The template still prefers explicit `async def` plus `run_in_threadpool` for three reasons:

- **Boundary visibility.** The reader sees exactly which call is blocking and which is async. With auto-offload, every reader has to remember the FastAPI rule.
- **Mixed work.** The moment you need to await something else (fetch a fresh feature from a cache, log to an async sink, call a remote service) you must convert the handler to `async def`. Starting that way avoids the rewrite.
- **Middleware composition.** Async middleware (like the access log middleware in this template) interleaves more cleanly when handlers are async and only the inference itself is offloaded.

Both patterns are valid; the template picks the more explicit one.


## 6. Why an initContainer loads models from a PVC in Kubernetes

The deployment spec uses an `initContainer` that copies model files from a PVC into a shared `emptyDir`, which the app container then mounts read-only. Why not just bake the model into the image?

**Image size and rebuild cost.** Model files are often hundreds of MB to several GB. Baking them into the image means:

- every deploy pushes those bytes to the registry,
- every node pulls them on cold start,
- a model update requires a full image rebuild, registry round-trip, and rollout.

For frequently retrained models, that makes every deploy slow and expensive, even when the code did not change.

**Decoupled lifecycle.** Models come from a training pipeline and code comes from an application repo. Putting both in one image means you cannot:

- update a model without code review for the API repo,
- run two pods with different model versions for A/B testing without two images,
- roll back the API independently of the model.

The PVC + initContainer pattern lets the training pipeline write to a known location (object storage backed by a PVC, or a model registry mount) and the API consumes whatever is there at pod start.

**Failure-loud at startup.** The `cp ... || echo "not found"` in the initContainer doesn't care *which* files are present, but the `lifespan` handler in `app.py` crashes startup if a model is missing. If the PVC mount is broken, the pod fails its readiness probe and the rolling deploy stops, so you never serve traffic with a partially loaded model.

**Trade-offs.** This pattern has costs:

- a deployment is no longer fully described by `image:tag` alone; you also need to know what was in the PVC at the moment of pod start. For audit / compliance, capture the model checksum at startup and log it.
- the cluster needs shared storage. In simple single-node setups, baking the model into the image is fine.
- cold start is slower (initContainer pulls model files into the emptyDir).

When to bake the model into the image instead:

- the model is small (under ~100 MB) and changes only when code changes,
- you do not have shared storage in the target cluster,
- you specifically *want* the deployment to be reproducible from `image:tag` alone (regulated environments).

When to use a model registry (MLflow, Vertex AI, S3 prefixes) instead of a PVC:

- multiple clusters need the same model files,
- you want versioned model URIs in the config rather than "whatever is on the PVC,"
- you want rollback to a specific historical version.

The PVC pattern in the template is the smallest k8s-native version of "model lives outside the image." Swap the PVC for a `gcsfuse` or `s3fs` mount, or replace the initContainer with an in-process download from a registry, when you outgrow it.


## 7. Hot reload models in production, or redeploy?

Two designs:

- **(A) Hot reload.** A background task watches a model registry (or a file path, or polls an HTTP endpoint), and atomically swaps the in-memory model reference when a new version arrives. Pods stay up. Optionally, an admin endpoint triggers a manual reload.
- **(B) Redeploy.** Model paths or versions are pinned in source / config. Updating the model means rolling out a new pod (with a new initContainer fetch, or a new image).

This template uses **(B)**. The trade-offs:

**Reproducibility.** With (B), a git SHA plus an image tag (plus, for this template, the model file checksum logged at startup) fully describes runtime behavior. When something goes wrong in production at 02:00, you can reconstruct exactly what was running. With (A), you also need "which model version was loaded in this pod at the moment of the request," which means more logging discipline and more places for drift.

**Atomic rollout.** Kubernetes already gives you a great rollout primitive: rolling deploys with health checks, automatic rollback on failed readiness, traffic shifting. With (B), updating a model uses that machinery for free. With (A), you have to build that yourself: a per-pod swap protocol, a way to drain in-flight requests off the old reference, and a rollback mechanism that is not just "swap back."

**Multi-pod consistency.** During a hot reload, different pods will briefly serve different model versions. That's usually fine, but it can surprise downstream consumers if the model output range changed between versions. Rolling redeploys also cause this briefly, but the Deployment's rollout strategy gives you knobs (`maxSurge`, `maxUnavailable`) to bound the window. Hot reload across N pods does not.

**Failure surface.** Hot reload adds:

- a background polling thread or scheduler,
- a model registry client,
- an admin endpoint or signal handler (which needs auth),
- atomic swap logic that is correct under concurrent reads from N request handlers,
- monitoring for "did the swap actually happen on every pod?"

Each of those can have bugs, while redeploys reuse Kubernetes machinery you already trust.

**When you would still want hot reload:**

- Models retrain hourly or faster and redeploys are expensive (multi-GB images, slow startup with large models, many pods).
- You need A/B testing where the routing changes at runtime, not at deploy time.
- You operate at a fleet scale where triggering N redeploys is itself a problem.

For a template aimed at a first ML inference service, (B) is the right call because it is simpler, more reproducible, and gives you Kubernetes-native rollout for free. If you outgrow it, the template's `MLModels` singleton with explicit accessor methods keeps a new `reload()` method localized and safe.


## Summary table

| Decision | Choice | Main reason |
|----------|--------|-------------|
| Web framework | FastAPI on Uvicorn under Gunicorn | Native async, Pydantic validation, OpenAPI for free, no monkey-patching |
| JSON encoder | orjson via `ORJSONResponse` | About 10x faster, returns bytes, handles numpy and datetime cleanly |
| Package / env manager | uv | Fast, single Dockerfile, first-class lockfile, no custom channels |
| Async runtime | anyio (via FastAPI) | Bounded thread pool, structured concurrency, what FastAPI uses anyway |
| Inference call style | `async def` plus `run_in_threadpool` | Explicit offload boundary, composes with async middleware |
| Model loading in k8s | initContainer plus PVC plus emptyDir | Decouples model lifecycle from image lifecycle, smaller images |
| Model update strategy | Redeploy, not hot reload | Reproducibility, atomic rollout, fewer failure modes |
