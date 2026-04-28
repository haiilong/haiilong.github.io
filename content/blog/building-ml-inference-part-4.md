---
title: "Building an ML Inference API, Part IV: Compiling LightGBM Trees to C#"
date: 2026-04-28
description: Converting LightGBM models into native .NET inference, from naive if/else generation to a compact array-based evaluator.
tags: [tech]
---

## Background

By the time the FastAPI inference service from [Part II](/blog/building-ml-inference-part-2) was running in production, the .NET callers around it were doing all the work you'd expect: HTTP clients, retries on transient errors, timeouts, circuit breakers, distributed tracing. All standard, all necessary, all extra moving parts. And in some downstream systems, even a clean network round-trip was a latency budget we couldn't afford.

Most of what we served was a LightGBM regression. Training pipelines, retraining schedules, and feature engineering all genuinely belong in Python. But inference itself is just a tree, technically an ensemble of trees. It is comparisons, branches, and additions. There is no reason that has to live behind an HTTP call to a separate process.

The thought was: since it's just a tree, translate the trained model into C# directly. Then the .NET callers call a method instead of an endpoint. No network, no retries, no service to scale.

It works. For regression especially, the mapping from tree to code is almost literal. You generate source from the model, ship a DLL, and have native .NET inference with no Python and no model file at runtime. The catch: generated if/else grows fast, and once it does, the cleaner move is to represent the trees as data and walk them with a small evaluator.

This post walks through both approaches:

1. Why tree models can be represented as code
2. What each part of a LightGBM tree means
3. A concrete tiny LightGBM example converted to C#
4. Python code generation for the if/else version
5. Why generated code can become unwieldy
6. The array-based evaluator approach (what I ended up preferring)
7. How this extends to binary and multiclass models

We'll start with regression, because that is the cleanest place to build intuition.

## A regression tree is already code

One useful mental shift:

A decision tree is not something that can be *translated* into if/else. A decision tree already *is* nested if/else.

Here is a tiny tree:

* If `strength_diff <= -2.11`
  * predict `0.3145`
* Else
  * predict `0.7237`

That is literally:

```csharp
if (features[5] <= -2.11)
    return 0.3145;
else
    return 0.7237;
```

That is not an approximation. That is the model.

This is why tree models are uniquely portable compared with many other ML models.

## Gradient boosting is many trees adding small corrections

A LightGBM regression model is an ensemble:

```text
prediction = tree1(x)
           + tree2(x)
           + tree3(x)
           + ...
```

Each tree contributes a small adjustment.

That becomes:

```csharp
public static double Predict(double[] f)
{
    double score = 0;

    score += Tree0(f);
    score += Tree1(f);
    score += Tree2(f);

    return score;
}
```

Each `TreeN` is nested branching logic. That is LightGBM inference.

## What each part of a LightGBM tree means

A tree dump looks conceptually like this:

```text
split_feature: strength_diff
threshold: -1.18
left_child:
   split_feature: minute
   threshold: 15
   left_child: leaf=0.48
   right_child: leaf=0.62
right_child:
   leaf=1.03
```

That means:

```csharp
if (strengthDiff <= -1.18)
{
    if (minute <= 15)
        return 0.48;
    else
        return 0.62;
}
else
{
    return 1.03;
}
```

Direct mapping:

| LightGBM | C# |
|---|---|
| split_feature | feature index |
| threshold | comparison |
| left child | if branch |
| right child | else branch |
| leaf value | returned score |
| boosting ensemble | sum of trees |

Once you see this mapping, the rest follows naturally.

## A tiny real LightGBM example

A small LightGBM model file with one tree looks like:

```text
Tree=0
num_leaves=3
split_feature=5 7
threshold=-1.18 15
left_child=1 -1
right_child=2 -2
leaf_value=0.48 0.62 1.03
```

Interpretation:

* First split on feature 5
* If <= -1.18 go left
* Then split feature 7
* Else go right to a leaf

Generated C#:

```csharp
static double Tree0(double[] f)
{
    if (f[5] <= -1.18)
    {
        if (f[7] <= 15)
            return 0.48;
        else
            return 0.62;
    }
    else
    {
        return 1.03;
    }
}
```

That is an actual tree represented as code. If the model has 300 trees, you generate 300 methods. That scales surprisingly far.

## Real inference verification

Using one row from my model:

```csharp
var result = Model.Predict(
[
    1.2699999809265137,
    3.380000114440918,
    0.7300000190734863,
    1.6299999952316284,
    4.650000095367432,
    -2.1100001335144043,
    1.0,
    28.0,
    0.0,
    0.0,
    2.0,
    2.0,
    -2.0,
    0.0,
    2.0,
    2.0,
    -2.0,
    7.0,
    -0.40880000591278076,
    1.0871999263763428,
    427465.0
]);
```

Expected:

```text
0.31458735
```

Generated predictor matched exactly.

That is important. We are not approximating the model. We are reproducing inference exactly.

## Generate the C# automatically with Python

And it should absolutely be generated. Never hand-write tree logic.

### Load the model

```python
import lightgbm as lgb

booster = lgb.Booster(model_file='model.txt')
model_dump = booster.dump_model()
```

Trees live in:

```python
model_dump['tree_info']
```

### Recursive emitter

```python
def emit_node(node, indent=1):
    pad = '    ' * indent

    if 'leaf_value' in node:
        return f"{pad}return {node['leaf_value']};\n"

    feature = node['split_feature']
    threshold = node['threshold']

    code = []

    code.append(
        f"{pad}if (features[{feature}] <= {threshold})\n"
        f"{pad}{{\n"
    )

    code.append(
        emit_node(node['left_child'], indent + 1)
    )

    code.append(
        f"{pad}}}\n"
        f"{pad}else\n"
        f"{pad}{{\n"
    )

    code.append(
        emit_node(node['right_child'], indent + 1)
    )

    code.append(
        f"{pad}}}\n"
    )

    return ''.join(code)
```

Generate methods:

```python
for i, tree in enumerate(model_dump['tree_info']):
    print(f"static double Tree{i}(double[] features)")
    print('{')
    print(emit_node(tree['tree_structure']))
    print('}')
```

Then aggregate them. Very straightforward.

## Why this approach is attractive

There are real benefits.

### Native inference

No LightGBM runtime. No Python. No model file loading. Just compiled .NET.

### Performance

Inference becomes:

* comparisons
* branches
* additions

That is very cheap.

### Deployability

Model becomes source code. A DLL ships the model. That can be attractive operationally.

### Debuggability

You can inspect decisions directly. Very useful in risk systems, pricing systems, and rule-heavy domains.

## But generated code grows fast

This is where practical limits show up.

Take a model with 500 trees, depth 8, roughly 255 nodes each. That is potentially:

```text
127,500 node checks
```

That is a large amount of generated code.

A single tree might look manageable:

```csharp
if (f[12] <= 0.7)
{
   if (f[5] <= -1.1)
   {
      if (f[3] <= 0.2)
      {
         ...
      }
   }
}
```

Hundreds of trees later:

* giant files
* slower compile times
* poor diffs
* harder JIT optimization
* possible method size issues

It works, but eventually it stops being elegant. The fix is to stop emitting branching syntax for every tree and represent the model as data instead.

## Represent the model directly as data, not giant if/else

Instead of generating:

```csharp
if (...) {
   if (...) {
      ...
   }
}
```

for every tree, you can export the tree exactly the way the model already represents itself:

* node tables
* feature arrays
* threshold arrays
* child pointers
* leaf values

Then run a tiny evaluator over those arrays.

This is just preserving the model structure directly.

### The key idea

Flatten every node into arrays:

```text
Feature[]
Threshold[]
Left[]
Right[]
IsLeaf[]
Value[]
Roots[]
```

Then inference becomes a small tree virtual machine:

```csharp
private static double Eval(int node, ReadOnlySpan<double> f)
{
    while (true)
    {
        if (IsLeaf[node])
            return Value[node];

        if (f[Feature[node]] <= Threshold[node])
            node = Left[node];
        else
            node = Right[node];
    }
}
```

And boosting:

```csharp
public static double Predict(ReadOnlySpan<double> f)
{
    double s = 0;

    for (int i = 0; i < TreeCount; i++)
        s += Eval(Roots[i], f);

    return s;
}
```

That is still exact LightGBM inference. But now generated source stays small.

### This mirrors the model itself

Using our tiny earlier tree:

```text
if feature5 <= -1.18
   if feature7 <=15
      0.48
   else
      0.62
else
   1.03
```

Instead of generating nested code, you can emit:

```text
Feature   = [5,0,7,0,0]
Threshold = [-1.18,0,15,0,0]
Left      = [1,0,3,0,0]
Right     = [2,0,4,0,0]
IsLeaf    = [F,T,F,T,T]
Value     = [0,.48,0,.81,.67]
```

This *is* the model. Just serialized into arrays. And your evaluator walks it.

### Python generator for this approach

This was the exporter I ended up liking most.

Flatten nodes recursively:

```python
def flatten(tree, nodes):
    idx = len(nodes)

    if "leaf_value" in tree:
        nodes.append({"leaf": True,
                      "value": tree["leaf_value"]})
        return idx

    node = {
        "leaf": False,
        "feature": tree["split_feature"],
        "threshold": tree["threshold"],
        "left": None,
        "right": None
    }

    nodes.append(node)

    node["left"] = flatten(tree["left_child"], nodes)
    node["right"] = flatten(tree["right_child"], nodes)

    return idx
```

Then generate C# arrays plus the evaluator. Exactly matching model structure.

### Why I like this approach

Compared with giant if/else generation:

* dramatically smaller generated files
* one evaluator method
* easier for JIT
* easier diffs
* easier codegen
* still zero model runtime dependency

And importantly, the source size grows mostly with model data, not with duplicated branching syntax. That is a meaningful difference.

## My practical rule

Small models: generate direct if/else. It is great for understanding what the model is actually doing.

Medium to large models: generate the array representation plus the evaluator. It keeps the spirit of "compile model into .NET" without gigantic branch forests, and it is much closer to how tree engines already work internally.

## Regression output

Regression is simplest. Each tree returns a leaf value. You sum them.

```text
score = Σ trees
```

That is the whole story.

## Binary classification

Same structure. Difference: trees often produce logits.

Then:

```text
probability = sigmoid(sum)
```

```csharp
static double Sigmoid(double x)
{
   return 1 / (1 + Math.Exp(-x));
}
```

Prediction threshold:

```csharp
return prob >= 0.5;
```

Tree traversal is identical. Only the output transformation changes.

## Multiclass

Same story again. Often:

```text
num_classes × boosting_rounds trees
```

Accumulate score per class:

```csharp
double[] scores = new double[3];

scores[0] += Tree0(f);
scores[1] += Tree1(f);
scores[2] += Tree2(f);
```

Then softmax:

```csharp
static double[] Softmax(double[] x)
{
    var exp = x.Select(Math.Exp).ToArray();
    var sum = exp.Sum();
    return exp.Select(v => v / sum).ToArray();
}
```

Then take argmax. Same trees, different aggregation.

## Validation matters

One thing I strongly recommend: validate generated inference against model outputs.

For example, checking every CSV row:

```csharp
Assert.True(
    diff < 1e-4,
    $"Row {i} mismatch. Expected={expected}, Actual={actual}"
);
```

Do this before thinking about optimization. Correctness first, then performance.

## Summary

Trees compile into if/else almost literally:

* splits become conditions
* leaves become returned values
* boosting becomes summation

For binary classification: same trees plus sigmoid.

For multiclass: same trees plus per-class accumulation and softmax.

Python can generate all of it.

**Start by generating direct if/else for small models.** It teaches you how tree inference actually works.

**Once generated source starts feeling unwieldy, switch to the array representation with a small evaluator.** It keeps the same "no runtime, just compiled .NET" property without growing into a forest of branches.

## The complete code

The full exporter, the array-based evaluator, and the validation harness are on GitHub at [haiilong/export_lgbm_universal_cs](https://github.com/haiilong/export_lgbm_universal_cs).
