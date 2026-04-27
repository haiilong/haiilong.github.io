---
title: Building an ML Inference API, Part II
date: 2025-09-04
description: Building Scalable Python Web API for ML Inference
tags: [tech]
---

## Background

Picking up where [Part I](/blog/building-ml-inference-part-1) left off: by 2023, all our services had been Dockerized and were running on Kubernetes. The VM era, and the constraint that we couldn't run Python web services, was over. The question became: now that we can run Python directly, what should an inference API look like?

This post covers the two phases I went through. The first was Flask + gunicorn + gevent + conda. The second was a rewrite to FastAPI + Uvicorn, which is what we run today. [Part III](/blog/building-ml-inference-part-3) covers the technical decisions in detail; this post is how I got there.

## I. Flask + gunicorn + gevent + conda

The first version used the most familiar tools. Flask is what every Python developer knows. I honestly don't remember why I decided to use Gunicorn + Gevent, so most likely from Googling and reading other people's blogs. Conda was what the data science team used, so the pickled model files dropped in without numpy version conflicts.

### The two-Dockerfile dance

The conda environment solve for our dependencies (`numpy`, `pandas`, `xgboost`, `catboost`, `flask`, `gunicorn`, `gevent`) routinely took five to seven minutes on every CI build. To keep build times down, the image was split in two:

* `Dockerfile.base`: installs the conda environment from `environment.yml`. Built once, pushed to the internal registry, rebuilt only when dependencies changed.
* `Dockerfile`: starts `FROM <registry>/inference-env`, copies `src/`, sets the entrypoint. Rebuilt every CI run.

The base image:

```dockerfile
FROM python:3.11-slim AS builder
ARG MAMBA_VERSION=1.5.8

RUN apt-get update && apt-get install -y --no-install-recommends curl bzip2 && \
    curl -Ls "https://micro.mamba.pm/api/micromamba/linux-64/${MAMBA_VERSION}" \
        | tar -xvj -C /tmp bin/micromamba && \
    apt-get purge -y --auto-remove curl bzip2 && \
    rm -rf /var/lib/apt/lists/*

FROM python:3.11-slim
ENV MAMBA_ROOT_PREFIX="/opt/conda"
ENV PATH="${MAMBA_ROOT_PREFIX}/bin:/usr/local/bin:${PATH}"

COPY --from=builder /tmp/bin/micromamba /usr/local/bin/micromamba
COPY environment.yml .

RUN micromamba create -n inference-env -f environment.yml -y && \
    micromamba clean -a -y
```

And the app image, the one CI rebuilt every commit:

```dockerfile
FROM <registry>/inference-env

WORKDIR /app
COPY src/* .

ENTRYPOINT ["conda", "run", "--no-capture-output", "-n", "inference-env", \
            "gunicorn", "--worker-class", "gevent", "--log-level", "INFO", \
            "-w", "2", "-b", "0.0.0.0:80", "app:app"]
```

Two gevent workers per pod. One environment, two images, one extra registry artifact to maintain.

### The handler

A single `app.py`, one route per model:

```python
import pickle
import pandas as pd
from flask import Flask, request

app = Flask(__name__)

# Models loaded at import time as module globals
score_model = pickle.load(open("score_model.pkl", "rb"))
risk_model = pickle.load(open("risk_model.pkl", "rb"))


@app.route("/health")
def healthcheck():
    return "1"


@app.route("/predict/score", methods=["POST"])
def predict_score():
    try:
        body = request.json
        features = pd.json_normalize(body["features"])
        result = score_model.predict(features)
        return {"score": float(result[0])}
    except Exception as e:
        app.logger.error(repr(e))
        return {"score": 0.0}, 400
```

This worked. Models served traffic.

### Where it started to fall apart

Three things became obvious over time.

**Requests felt synchronous.** Under load, latencies spiked in patterns that didn't match the underlying inference cost. A handler that took 80 ms in isolation would take 600 ms when twenty other callers were hitting different endpoints on the same pod. p99 was much worse than the averages suggested.

The reason, which I only fully understood later, is in [Part III, section 1](/blog/building-ml-inference-part-3#1-why-fastapi--uvicorn--gunicorn-not-flask--gevent): gevent gets concurrency by monkey-patching the standard library's blocking I/O calls so they cooperatively yield. That works for I/O-bound workloads. It does not help when 95% of the time is spent inside `numpy` and `xgboost` C extensions that don't yield to gevent's scheduler. Each worker still ran one inference at a time, with everyone else queued behind it.

We tuned the only knob we had, `-w` (worker count). Going from 2 to 4 to 8 helped throughput but not tail latencies.

**No request validation.** `body = request.json`, then `body["features"]`. If the caller forgot the key or sent the wrong shape, we got a `KeyError` in production logs and returned a 400 with no useful message. We added more `try/except`. We sometimes bolted on `pydantic` as a separate step. Each model endpoint ended up with its own subtly different schema handling.

**No model binding.** Models were loaded at module import as global variables. If a `.pkl` file was missing on disk, the import crashed and gunicorn restarted in a loop until alerts caught it. There was no catalog, no central record of what the service served, no clean way to add a new model without grepping the source. Ten models in, this was painful.

We shipped, but we knew we were working around the framework rather than with it.

## II. FastAPI + Uvicorn (under gunicorn)

By the time we were considering yet another round of `try/except` improvements, FastAPI was the obvious next direction. Async-native, Pydantic for validation, OpenAPI auto-generated, no monkey-patching of the standard library. The "why" for each is in [Part III](/blog/building-ml-inference-part-3); this section is how I got the implementation right, which took a few tries.

### First cut: sync `def` handlers

The initial port was almost mechanical. Replace `Flask` with `FastAPI`, replace `request.json` with a Pydantic body model, keep handlers as plain `def`:

```python
from fastapi import FastAPI
from pydantic import BaseModel

app = FastAPI()


class PredictRequest(BaseModel):
    features: list[dict]


@app.post("/predict/score")
def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = score_model.predict(df)
    return {"score": float(result[0])}
```

This worked. FastAPI auto-runs sync handlers in a threadpool. The Pydantic class alone was a big win: callers sending the wrong shape now got a 422 with a per-field error message before my code ran. The 2 AM `KeyError`s went away in the first deploy.

### Switching to `async def`

I converted handlers to `async def` shortly after. I don't remember the exact trigger. It was probably an `@app.middleware("http")` for request timing, which composes more cleanly when handlers are async, or a point where we needed `await request.body()` for a custom payload. The change:

```python
@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = score_model.predict(df)   # blocking call, inside async handler
    return {"score": float(result[0])}
```

Latencies got worse. Switching from `def` to `async def` silently changes FastAPI's behaviour: with `def`, FastAPI runs the handler in a threadpool; with `async def`, it expects you to be cooperative and runs the code directly on the event loop. My CPU-bound `model.predict` was now sitting on the loop, blocking it for the full inference duration. [Part III, section 5](/blog/building-ml-inference-part-3#5-async-def-plus-run_in_threadpool-the-importance-of-the-offload) has the full pitfall.

### `asyncio.to_thread`, then `run_in_threadpool`

The call needed to be off the event loop. The first thing I reached for was the standard library:

```python
import asyncio

@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = await asyncio.to_thread(score_model.predict, df)
    return {"score": float(result[0])}
```

Latencies recovered. I shipped it.

A few weeks later, while reading FastAPI's source for an unrelated reason, I noticed something I had missed: FastAPI doesn't use asyncio's threadpool. It uses anyio's, via `fastapi.concurrency.run_in_threadpool`. They are different pools. Anyio's has a global concurrency limiter (default 40 threads); asyncio's `to_thread` does not, every call goes into the default executor with no cooperative cap.

For our load, that mostly didn't matter. But our inference workload was bypassing the bound the rest of the framework respected, with no single place to tune it. The fix was a one-line change:

```python
from fastapi.concurrency import run_in_threadpool

@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = await run_in_threadpool(score_model.predict, df)
    return {"score": float(result[0])}
```

That is the version still running in production. [Part III, section 4](/blog/building-ml-inference-part-3#4-anyio-vs-asyncio) covers the anyio vs asyncio rationale.

### Why we kept `async def`

With `async def` plus `run_in_threadpool`, the handler does roughly the same thing FastAPI would have done automatically with a sync `def`. Two reasons we kept the explicit version, both expanded in Part III:

* The offload boundary is visible in the code. A reader sees which call is blocking and which is async.
* The access-log middleware is async. The `lifespan` startup hook is async. Any future cache lookup or remote call would also be async. Starting that way avoids the conversion later.

### Process model

Uvicorn alone is fine in dev. In production we run it under gunicorn:

```dockerfile
ENTRYPOINT ["gunicorn", "-w", "1", "-k", "uvicorn.workers.UvicornWorker", \
            "-b", "0.0.0.0:80", "app:app"]
```

One Uvicorn worker per pod, scaled horizontally by Kubernetes. Gunicorn handles process supervision, graceful shutdown, and the listening socket; Uvicorn is the ASGI runtime inside the worker. We prefer more pods over more workers per pod, since it keeps the unit of failure smaller and concentrates scheduling decisions in the kubelet.

### Conda to uv

The last change is not strictly part of the FastAPI rewrite, but it lands in the same era. The two-Dockerfile dance, plus the registry artifact to maintain, was always a smell. uv installs the dependency set in seconds rather than minutes. The production image is back to a single `Dockerfile`. CI is faster. [Part III, section 3](/blog/building-ml-inference-part-3#3-why-uv-over-conda) covers the why.

## Closing thoughts

The shape we landed on (`async def` plus `run_in_threadpool`, Pydantic for the request boundary, FastAPI under gunicorn) is the shape the template in [Part III](/blog/building-ml-inference-part-3) ships with. Part III explains why each choice is the default. This post is how I got there. If you are starting an inference service today, skip the journey and use the template.
