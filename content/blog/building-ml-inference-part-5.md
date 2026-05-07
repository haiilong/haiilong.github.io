---
title: Building an ML Inference API, Part V
date: 2026-05-07
description: Extending native inference to other boosting frameworks
tags: [tech]
---

Continuing from part IV, I have a few things I want to do:

1. Extend this to XGBoost and CatBoost. These 3 should cover almost all gradient boosting cases.
2. Make the prompt interactive in terminal (ask for model path, output name, etc.)
3. Extend to Go because besides C# which I use, Go is a common language used by microservices in cloud.

Since the requirements are quite clear and there is already existing working codes for LightGBM as well as the explanation in part IV, I decided to just pass this to Claude and let it finish (also I'm not that good with Go anyways).

But before that, I created 3 different models based on a small dataset (sklearn `make_classification`, 10 features, 200 rows). I also created a dotnet test using XUnit to assert that .NET classes called LgbmModel, XgbModel and CbModel (placeholders with `Predict()` function) would match the predictions by Python. As long as Claude can make sure all the tests pass, I'm quite confident the task is finished (because of the nature of the work, there is no way it would pass if there is a bug in classification prediction for 200 data).

Anyway, there were some hiccups but Claude managed to fix them by itself after like 20 minutes lol. The TDD approach worked well here (you should not do TDD if you don't know the usefulness, because in fact it's not that useful most of the time).

Here is the git repo if it's useful:

<https://github.com/haiilong/boostexport>

With that, I'll close this long chapter on ML inference.
