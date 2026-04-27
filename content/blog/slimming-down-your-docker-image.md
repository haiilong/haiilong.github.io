---
title: Slimming down your Docker Image
date: 2025-02-10
description: Simple Docker image changes that reduce size and risk.
tags: [tech]
---

Docker images can quickly become bloated, leading to slower deployments, increased storage costs, and reduced performance. In this guide, I explain some way you can reduce your docker image size for .NET and python application.

## I. Clean Caches

Clean any of the caches if you use them

### Clean package manager cache

```dockerfile
RUN apt-get update && apt-get install -y \
    package1 \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
```

### Clean conda cache

```dockerfile
RUN conda env update -n base -f environment.yml \
    && conda clean -afy \
    && find /opt/conda/ -follow -type f -name '*.a' -delete \
    && find /opt/conda/ -follow -type f -name '*.js.map' -delete
```

* `conda clean -afy` will clean caches (all, forced, say yes to all prompts)

* `*.a` are conda static files

* `*.js.map` are javascript package static files usually used in jupyter notebook or other graphical libraries

### Clean pip cache

```dockerfile
RUN pip install --no-cache-dir -r requirements.txt
```

### Clean pixi cache

```dockerfile
RUN rm -rf /root/.cache/rattler
```

## II. Delete files you don't need

```dockerfile
COPY pixi.toml .
RUN pixi install && \
    rm pixi.lock && \
    rm -rf /root/.cache/rattler && \
```

## III. Combine RUN commands to reduce layer

```dockerfile
RUN pixi install && \
    rm pixi.lock && \
    rm -rf /root/.cache/rattler && \
    rm pixi.toml
```

is better than

```dockerfile
RUN pixi install
RUN pixi.lock
RUN rm -rf /root/.cache/rattler
RUN rm pixi.toml
```

## IV. Use .dockerignore to exclude unnecessary files from build context

```dockerignore
**/.git
**/node_modules
**/bin
**/obj
```

## V. Use .NET optimization flag

```dockerfile
RUN dotnet publish "MyApp.csproj" -c Release -o /app/publish \
    /p:UseAppHost=false
```

Matter of fact, we should always use `/p:UseAppHost=false` in our project

What does it do?. There are a few .NET optimization flag

* `/p:UseAppHost=false`: Prevents generation of native executable

   * You need this if you use IIS

   * If your environment already runs asp net runtime (docker), you don't need this, this will prevent generating .dll files needed to run .NET

* `/p:PublishTrimmed=true`: Removes unused assemblies (careful with reflection)

   * This is the best if your project is AOT, it does the equivalent of Tree Shaking in JavaScript

* `/p:PublishSingleFile=true`: Creates a single executable file
