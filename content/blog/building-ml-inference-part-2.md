---
title: Building an ML Inference API, Part II
date: 2025-09-04
description: Building Scalable Python Web API for ML Inference
tags: [tech]
---

## Background

By 2023, all our services had been Dockerized and were running on Kubernetes, so the VM era from [Part I](/blog/building-ml-inference-part-1) and its ban on Python web services were over. Now that we could run Python directly, what should an inference API look like?

There were two phases: Flask + gunicorn + gevent + conda first, then a rewrite to FastAPI + Uvicorn, which is what we run today. [Part III](/blog/building-ml-inference-part-3) covers the technical decisions in detail; this post is how I got there.

## I. Flask + gunicorn + gevent + conda

The first version used the most familiar tools. Every Python developer knows Flask. I honestly don't remember why I picked Gunicorn + Gevent, most likely from Googling and reading other people's blogs. Conda was what the data science team used, so their pickled model files loaded without numpy version conflicts.

### The two-Dockerfile dance

The conda environment solve for our dependencies (`numpy`, `pandas`, `xgboost`, `catboost`, `flask`, `gunicorn`, `gevent`) took five to seven minutes on every CI build, so we split the image in two:

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

That gave us two gevent workers per pod, and one environment split across two images plus an extra registry artifact to maintain.

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

This worked well enough to serve traffic.

### Where it ran into problems

Three problems showed up over time.

**Requests felt synchronous.** Under load, latencies spiked well beyond the actual inference cost. A handler that took 80 ms alone would take 600 ms when twenty other callers hit different endpoints on the same pod, and p99 was much worse than the averages.

I only understood why later ([Part III, section 1](/blog/building-ml-inference-part-3#_1-why-fastapi-uvicorn-gunicorn-not-flask-gevent)). gevent gets concurrency by monkey-patching the standard library's blocking I/O calls so they cooperatively yield. That works for I/O-bound workloads, but not when 95% of the time is spent inside `numpy` and `xgboost` C extensions that never yield to gevent's scheduler. Each worker still ran one inference at a time, and everyone else queued behind it.

We tuned the only knob we had, `-w` (worker count). Going from 2 to 4 to 8 helped throughput but not tail latencies.

**No request validation.** The handler read `body = request.json`, then `body["features"]`. If the caller forgot the key or sent the wrong shape, we got a `KeyError` in production logs and returned a 400 with no useful message. We added more `try/except` and sometimes bolted on `pydantic` as a separate step, so each model endpoint ended up with slightly different schema handling.

**No model binding.** Models were loaded at import time as module globals. If a `.pkl` file was missing on disk, the import crashed and gunicorn restarted in a loop until alerts caught it. Nothing recorded which models the service served, and adding a new one meant grepping the source. By ten models, this was painful.

## II. FastAPI + Uvicorn (under gunicorn)

Instead of another round of `try/except` fixes, we moved to FastAPI. It is async-native, uses Pydantic for validation, auto-generates OpenAPI docs, and doesn't monkey-patch the standard library. [Part III](/blog/building-ml-inference-part-3) covers the "why" for each. This section covers getting the implementation right, which took a few tries.

### First cut: sync `def` handlers

The first port was almost mechanical: replace `Flask` with `FastAPI`, replace `request.json` with a Pydantic body model, and keep handlers as plain `def`:

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

This worked, since FastAPI runs sync handlers in a threadpool. The Pydantic class alone was a big win, because callers sending the wrong shape now got a 422 with a per-field error message before my code ran. The 2 AM `KeyError`s stopped after the first deploy.

### Switching to `async def`

Shortly after, I converted the handlers to `async def`. I don't remember the exact trigger; it was probably an `@app.middleware("http")` for request timing, which composes more cleanly with async handlers, or a case where we needed `await request.body()` for a custom payload. The change:

```python
@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = score_model.predict(df)   # blocking call, inside async handler
    return {"score": float(result[0])}
```

Latencies got worse. With `def`, FastAPI runs the handler in a threadpool. With `async def`, it assumes the code is cooperative and runs it directly on the event loop. My CPU-bound `model.predict` was now blocking the loop for the whole inference. [Part III, section 5](/blog/building-ml-inference-part-3#_5-async-def-plus-run_in_threadpool-the-importance-of-the-offload) has the full pitfall.

### `asyncio.to_thread`, then `run_in_threadpool`

The call had to move off the event loop, and the first thing I reached for was the standard library:

```python
import asyncio

@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = await asyncio.to_thread(score_model.predict, df)
    return {"score": float(result[0])}
```

Latencies recovered, and I shipped it.

A few weeks later, while reading FastAPI's source for an unrelated reason, I found that FastAPI doesn't use asyncio's threadpool. It uses anyio's, through `fastapi.concurrency.run_in_threadpool`, and that pool has a global concurrency limiter (default 40 threads). asyncio's `to_thread` skips that limiter and sends every call to the default executor.

For our load, that mostly didn't matter, but inference was bypassing the limit the rest of the framework respected, and there was no single place to tune it. The fix was one line:

```python
from fastapi.concurrency import run_in_threadpool

@app.post("/predict/score")
async def predict_score(req: PredictRequest):
    df = pd.DataFrame(req.features)
    result = await run_in_threadpool(score_model.predict, df)
    return {"score": float(result[0])}
```

That is the version still running in production. [Part III, section 4](/blog/building-ml-inference-part-3#_4-anyio-vs-asyncio) covers the anyio vs asyncio rationale.

### Why we kept `async def`

With `async def` plus `run_in_threadpool`, the handler does roughly the same thing FastAPI would have done automatically with a sync `def`. We kept the explicit version for two reasons, both expanded in Part III:

* The offload boundary is visible in the code, so a reader sees which call is blocking and which is async.
* The access-log middleware and the `lifespan` startup hook are already async, and any future cache lookup or remote call would be too. Starting async avoids a conversion later.

### Process model

Uvicorn alone is fine in dev. In production we run it under gunicorn:

```dockerfile
ENTRYPOINT ["gunicorn", "-w", "1", "-k", "uvicorn.workers.UvicornWorker", \
            "-b", "0.0.0.0:80", "app:app"]
```

That's one Uvicorn worker per pod, scaled horizontally by Kubernetes. Gunicorn handles process supervision, graceful shutdown, and the listening socket; Uvicorn is the ASGI runtime inside the worker. We prefer more pods over more workers per pod, since it keeps the unit of failure smaller and concentrates scheduling decisions in the kubelet.

### Conda to uv

The last change isn't strictly part of the FastAPI rewrite, but it happened around the same time. The two-Dockerfile setup and its extra registry artifact were always a smell. uv installs the dependencies in seconds instead of minutes, so the production image is back to a single `Dockerfile` and CI is faster. [Part III, section 3](/blog/building-ml-inference-part-3#_3-why-uv-over-conda) covers the why.

## Closing thoughts

The setup we landed on (`async def` plus `run_in_threadpool`, Pydantic for the request boundary, FastAPI under gunicorn) is what the template in [Part III](/blog/building-ml-inference-part-3) ships with, and Part III explains why each choice is the default. If you are starting an inference service today, skip all this and use the template.
