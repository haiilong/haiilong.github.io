---
title: Building an ML Inference API, Part III
date: 2025-09-05
description: Technical design choices for ML Inference API
tags: [tech]
---

## Template

As a follow-up to [Part II](/blog/building-ml-inference-part-2): if you are looking for a template to start building an ML Inference API engine, check out [haiilong/ml-inference-api-template](https://github.com/haiilong/ml-inference-api-template) on GitHub. It covers:

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

In this blog, I will be explaining the technical decisions used in this template that we eventually used for all ML Inference API.

**Sections:**

1. [Why FastAPI / Uvicorn / Gunicorn (not Flask + gevent)](#_1-why-fastapi-uvicorn-gunicorn-not-flask-gevent)
2. [Why orjson over the default JSON encoder](#_2-why-orjson-over-the-default-json-encoder)
3. [Why uv over conda](#_3-why-uv-over-conda)
4. [anyio vs asyncio](#_4-anyio-vs-asyncio)
5. [`async def` plus `run_in_threadpool` (the importance of the offload)](#_5-async-def-plus-run_in_threadpool-the-importance-of-the-offload)
6. [Why an initContainer loads models from a PVC in Kubernetes](#_6-why-an-initcontainer-loads-models-from-a-pvc-in-kubernetes)
7. [Hot reload models in production, or redeploy?](#_7-hot-reload-models-in-production-or-redeploy)


## 1. Why FastAPI / Uvicorn / Gunicorn (not Flask + gevent)

A common Python ML serving stack is Flask running under gunicorn with gevent workers. It works, it has been deployed everywhere, and for very simple cases it is fine. The template uses **FastAPI on Uvicorn workers under Gunicorn** instead. Reasons:

**Concurrency model.** Gevent achieves concurrency by monkey-patching the standard library to make blocking I/O cooperatively yield. That model is great for I/O-bound web apps but has well-known sharp edges with C extensions. NumPy, scikit-learn, XGBoost, and CatBoost all spend most of their time inside C code that does not yield to gevent's scheduler, so a single slow inference still blocks every request that the worker is multiplexing. You end up tuning around the very thing you wanted concurrency for.

FastAPI on Uvicorn uses an asyncio event loop. CPU-bound inference is offloaded explicitly to a bounded thread pool (see section 5), which means the loop never blocks even when prediction takes 200 ms. It is the same end goal as gevent but with explicit boundaries instead of monkey-patched implicit ones.

**Validation and schema for free.** FastAPI builds on Pydantic. Defining a request body as a `BaseModel` gives you:

- automatic 422 responses with field-level error messages on bad input,
- generated OpenAPI / Swagger UI at `/`,
- typed request handlers, so editor tooling and `mypy` actually understand the code.

In Flask, you write that boilerplate by hand or pull in extensions (`marshmallow`, `flask-pydantic`, `flask-smorest`). For an inference API where the request shape is the contract with the caller, the FastAPI default is much closer to "what you would build anyway."

**Why Gunicorn at all if Uvicorn can serve directly.** Uvicorn is the ASGI server (one process, one event loop). Gunicorn is a process supervisor that manages multiple worker processes, handles graceful reload on SIGHUP, restarts crashed workers, listens on a single socket and load-balances across workers, and integrates with most ops tooling. The combination `gunicorn -k uvicorn.workers.UvicornWorker` gives you:

- process-level isolation across CPU cores (one event loop per worker),
- production-grade signal handling and graceful shutdown,
- the ASGI runtime you actually want.

Tuning: set `GUNICORN_WORKERS` to roughly `min(cpu_count, target_concurrency / threads_per_worker)`. For inference workloads, one worker per CPU core is usually a good starting point.


## 2. Why orjson over the default JSON encoder

Python's stdlib `json` module is pure Python. For inference APIs that return predictions as JSON, the encoder can become a measurable share of total request time, especially when responses contain numpy floats or longer batch outputs.

orjson is written in Rust and:

- Serializes typically 3 to 10 times faster than stdlib `json` and 2 to 4 times faster than ujson.
- Returns `bytes` directly, which is the native ASGI write type. Stdlib `json` produces a `str` that has to be encoded to bytes again.
- Handles `datetime`, `UUID`, `dataclasses`, and (via passthrough flags) numpy arrays without a custom `default=` function.
- Is strict about the JSON spec (no NaN by default, deterministic key order if asked).

We wire it in once on the app object:

```python
app = FastAPI(default_response_class=ORJSONResponse, ...)
```

After that, every endpoint returns orjson-encoded responses with no per-route changes.

When *not* to bother: if your responses are tiny (a single float) and your throughput is low (under 100 RPS), the win is nanoseconds and you should not care. For batch predictions, payload sizes grow linearly with batch size and orjson is the right default.


## 3. Why uv over conda

ML projects often default to conda because that is what notebook environments use. For a deployable inference service, `uv` is dramatically better.

**Speed.** uv is written in Rust. A clean dependency install for this template takes a few seconds. The equivalent conda env solve (especially with custom channels and pinned versions) routinely takes minutes. CI and Docker builds inherit that delta.

**Simpler container images.** With conda, you typically end up with two Dockerfiles:

- `Dockerfile.base` that installs micromamba and creates the env.
- `Dockerfile` that copies source on top of the base.

Plus a `Dockerfile.local` and a `Dockerfile.test` to keep things consistent. The base image has to be pre-built and cached in a registry to keep main builds fast.

With uv, the production image is one stage, no base, no separate registry artifact. `uv sync --frozen --no-dev` installs into `/opt/venv` quickly enough that you do not need a pre-built base. The template uses a single `Dockerfile` (plus a tiny `Dockerfile.test`).

**First-class lockfile.** `uv.lock` is committed and reproducible. `uv lock --check` in CI fails fast if anyone forgot to update it. Conda's lockfile story (`conda-lock`) works but is a separate tool with separate pitfalls.

**Pure PyPI.** No custom channels. No channel ordering bugs. No "which channel does this come from" mysteries.

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

You do not need to import `anyio` directly. **Starlette and FastAPI use anyio internally**, which means:

- `fastapi.concurrency.run_in_threadpool` is a thin wrapper over `anyio.to_thread.run_sync`.
- The thread pool that runs your offloaded inference is anyio's, capped by anyio's global limiter (default 40 threads).
- Dependency injection, background tasks, and lifespan all run on the anyio runtime.

Practical implications:

- Do not write `asyncio.to_thread(...)` in handlers. It bypasses the limiter and creates a separate pool that anyio cannot govern. Use `run_in_threadpool` (or `anyio.to_thread.run_sync` directly).
- If you need to raise the thread limit for high-concurrency CPU-bound inference, do it once at startup with `anyio.to_thread.current_default_thread_limiter().total_tokens = N`. Be deliberate; threads have memory overhead and switching cost.
- Mixing `asyncio.create_task` is fine, but prefer `anyio.create_task_group` for anything where you want clean cancellation on error.

In short: anyio is the runtime; asyncio is the engine underneath. Code against the FastAPI / anyio surface and you stay portable and bounded.


## 5. `async def` plus `run_in_threadpool` (the importance of the offload)

The README covers the basic recipe. This section explains the "why it matters" part.

**The pitfall.** A handler written like this looks innocent:

```python
@app.post("/predict/price")
async def post_predict_price(request: PricePredictionRequest):
    return calculate_price(request)  # WRONG: blocking call inside async handler
```

`calculate_price` calls `model.predict(...)`, which is a synchronous CPU-bound C extension call. The event loop is blocked for the entire duration of that call. While it runs:

- no other request handler on this worker can make progress,
- no health check can be answered,
- no timeout, cancellation, or middleware can interleave.

If predictions take 50 ms and you receive 100 concurrent requests, the 100th caller waits 5 seconds for what should be a 50 ms operation. The event loop's whole value proposition (cheap concurrency) is wasted.

**The fix.** Offload the blocking call to a worker thread:

```python
@app.post("/predict/price")
async def post_predict_price(request: PricePredictionRequest):
    return await run_in_threadpool(calculate_price, request)
```

Now the event loop awaits the thread pool and stays responsive. Other requests are served concurrently up to the size of the thread pool. The Python GIL still serializes pure-Python work between threads, but ML libraries (numpy, sklearn, xgboost) release the GIL inside their C kernels, so multi-threaded inference does scale.

**Why not let FastAPI do it implicitly with `def` instead of `async def`?**

If you write a *sync* handler (`def`, not `async def`), FastAPI auto-runs it in the threadpool for you. So you could write:

```python
@app.post("/predict/price")
def post_predict_price(request: PricePredictionRequest):
    return calculate_price(request)
```

and it would behave correctly. The reason the template prefers explicit `async def` plus `run_in_threadpool` anyway:

- **Boundary visibility.** The reader sees exactly which call is blocking and which is async. With auto-offload, every reader has to remember the FastAPI rule.
- **Mixed work.** The moment you need to await something else (fetch a fresh feature from a cache, log to an async sink, call a remote service) you must convert the handler to `async def`. Starting that way avoids the rewrite.
- **Middleware composition.** Async middleware (like the access log middleware in this template) interleaves more cleanly when handlers are async and only the inference itself is offloaded.

Both patterns are valid. The template picks the more explicit one.


## 6. Why an initContainer loads models from a PVC in Kubernetes

The deployment spec uses an `initContainer` that copies model files from a PVC into a shared `emptyDir`, which the app container then mounts read-only. Why not just bake the model into the image?

**Image size and rebuild cost.** Model files are often hundreds of MB to several GB. Baking them into the image means:

- every deploy pushes those bytes to the registry,
- every node pulls them on cold start,
- a model update requires a full image rebuild, registry round-trip, and rollout.

For frequently retrained models, this turns deploys into slow, expensive operations even when the code did not change.

**Decoupled lifecycle.** Models are produced by a training pipeline. Code is produced by an application repo. Tying them together in a single image means you cannot:

- update a model without code review for the API repo,
- run two pods with different model versions for A/B testing without two images,
- roll back the API independently of the model.

The PVC + initContainer pattern lets the training pipeline write to a known location (object storage backed by a PVC, or a model registry mount) and the API simply consumes whatever is there at pod start.

**Failure-loud at startup.** The `cp ... || echo "not found"` pattern in the initContainer is intentionally permissive about *which* files are present, but the `lifespan` handler in `app.py` is strict: a missing model crashes startup. That gives you the right behavior:

- if the PVC mount is broken, the pod fails its readiness probe and the rolling deploy stops, so you never serve traffic with a partially loaded model.

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

**Atomic rollout.** Kubernetes already gives you a great rollout primitive: rolling deploys with health checks, automatic rollback on failed readiness, traffic shifting. With (B), updating a model uses that machinery for free. With (A), you reinvent it: you need a per-pod swap protocol, a way to drain in-flight requests off the old reference, and a rollback mechanism that is not just "swap back."

**Multi-pod consistency.** During a hot reload, different pods will briefly serve different model versions. Usually fine, occasionally surprising (especially if the model output range changed between versions and downstream consumers care). Rolling redeploys still cause this transiently, but the kubelet's rollout strategy gives you knobs (`maxSurge`, `maxUnavailable`) to bound the window. Hot reload across N pods does not.

**Failure surface.** Hot reload adds:

- a background polling thread or scheduler,
- a model registry client,
- an admin endpoint or signal handler (which needs auth),
- atomic swap logic that is correct under concurrent reads from N request handlers,
- monitoring for "did the swap actually happen on every pod?"

Each of those is a place a bug can live. Redeploys reuse Kubernetes machinery you already trust.

**When you would still want hot reload:**

- Models retrain hourly or faster and redeploys are expensive (multi-GB images, slow startup with large models, many pods).
- You need A/B testing where the routing changes at runtime, not at deploy time.
- You operate at a fleet scale where triggering N redeploys is itself a problem.

For a template aimed at "first ML inference service," (B) is correct: it is simpler, more reproducible, and gives you Kubernetes-native rollout for free. If you outgrow it, the structure of the template (a `MLModels` singleton with explicit accessor methods) makes adding a `reload()` method localized and safe.


## Summary table

| Decision | Choice | Main reason |
|----------|--------|-------------|
| Web framework | FastAPI on Uvicorn under Gunicorn | Native async, Pydantic validation, OpenAPI for free, no monkey-patching |
| JSON encoder | orjson via `ORJSONResponse` | 3 to 10x faster, returns bytes, handles numpy and datetime cleanly |
| Package / env manager | uv | Fast, single Dockerfile, first-class lockfile, no custom channels |
| Async runtime | anyio (via FastAPI) | Bounded thread pool, structured concurrency, what FastAPI uses anyway |
| Inference call style | `async def` plus `run_in_threadpool` | Explicit offload boundary, composes with async middleware |
| Model loading in k8s | initContainer plus PVC plus emptyDir | Decouples model lifecycle from image lifecycle, smaller images |
| Model update strategy | Redeploy, not hot reload | Reproducibility, atomic rollout, fewer failure modes |
