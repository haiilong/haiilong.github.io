---
title: Slimming down your Docker Image
date: 2025-02-10
description: Simple Docker image changes that reduce size and risk.
tags: [tech]
---

Docker images get bloated quickly, which makes pulls and deployments slower and costs more storage. Here are some ways to reduce image size for .NET and Python applications.

## I. Clean Caches

Clean the cache of any package manager you use.

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
    rm -rf /root/.cache/rattler
```

## III. Combine RUN commands to reduce layers

```dockerfile
RUN pixi install && \
    rm pixi.lock && \
    rm -rf /root/.cache/rattler && \
    rm pixi.toml
```

is better than

```dockerfile
RUN pixi install
RUN rm pixi.lock
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

## V. Use .NET optimization flags

```dockerfile
RUN dotnet publish "MyApp.csproj" -c Release -o /app/publish \
    /p:UseAppHost=false
```

Matter of fact, we should always use `/p:UseAppHost=false` in our projects.

Here's what it does, along with a few other .NET optimization flags:

* `/p:UseAppHost=false`: Prevents generation of native executable

   * You need this if you use IIS

   * If your environment already runs asp net runtime (docker), you don't need this, this will prevent generating .dll files needed to run .NET

* `/p:PublishTrimmed=true`: Removes unused assemblies (careful with reflection)

   * It works best if your project is AOT. It's the equivalent of Tree Shaking in JavaScript

* `/p:PublishSingleFile=true`: Creates a single executable file
