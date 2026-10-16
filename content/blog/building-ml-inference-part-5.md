---
title: Building an ML Inference API, Part V
date: 2026-05-07
description: Extending native inference to other boosting frameworks
tags: [tech]
---

Continuing from part IV, there were a few things I wanted to do:

1. Extend this to XGBoost and CatBoost. These 3 should cover almost all gradient boosting cases.
2. Make the prompt interactive in terminal (ask for model path, output name, etc.)
3. Extend to Go, since besides C# (which I use), Go is a common language for cloud microservices.

The requirements were clear, and there was already working code for LightGBM plus the explanation in part IV, so I decided to just hand this to Claude and let it finish (also I'm not that good with Go anyways).

Before that, I trained 3 models on a small dataset (sklearn `make_classification`, 10 features, 200 rows) and wrote an xUnit test asserting that the .NET classes LgbmModel, XgbModel and CbModel (placeholders with a `Predict()` function) match the Python predictions. If Claude got all the tests passing, I was quite confident the task was done, because there's no way a bug in classification prediction would pass all 200 rows.

Anyway, there were some hiccups but Claude managed to fix them by itself after like 20 minutes lol. TDD worked well here (don't do TDD unless you can see the benefit though, most of the time it's not that useful).

Here is the git repo if it's useful:

<https://github.com/haiilong/boostexport>

With that, I'll close this long chapter on ML inference.
